# file: getkeys.py

import sys
import os
import random
import tempfile
import shutil
import time
import getpass
import concurrent.futures
import queue
import threading
import logging
import time
from functools import wraps
from google.api_core import exceptions as google_exceptions
from grpc import RpcError

# --- 内部并发控制 ---
# 为避免线程数爆炸式增长，内部任务使用固定的并发数，而不重用UI层级的max_workers
PROJECT_CHECK_CONCURRENCY = 12  # 并行检查已有项目的最大线程数
PROJECT_CONFIG_CONCURRENCY = 4 # 并行配置新项目的最大线程数


# 线程局部存储，用于日志记录上下文
thread_local = threading.local()

class ContextFilter(logging.Filter):
    """一个将线程局部上下文注入日志记录的过滤器。"""
    def filter(self, record):
        record.account = getattr(thread_local, 'account', 'N/A')
        record.project = getattr(thread_local, 'project', '-----')
        return True

def setup_global_logging(log_queue=None, level=logging.INFO):
    """配置全局（根）日志记录器。"""
    root_logger = logging.getLogger()
    # 配置一次即可
    if root_logger.hasHandlers():
        root_logger.handlers.clear()
    
    root_logger.setLevel(level)
    root_logger.addFilter(ContextFilter())

    formatter = logging.Formatter(
        '[%(asctime)s] [%(levelname)-5s] [%(account)s] [%(project)s] %(message)s',
        datefmt='%H:%M:%S'
    )

    if log_queue:
        from logging.handlers import QueueHandler
        handler = QueueHandler(log_queue)
    else:
        handler = logging.StreamHandler(sys.stdout)
    
    handler.setFormatter(formatter)
    root_logger.addHandler(handler)

def create_thread_logger(name, log_stream):
    """为单个线程创建一个隔离的、不传播的日志记录器。"""
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.propagate = False  # 这是关键：防止日志被发送到根记录器
    
    # 清除旧的处理器以防万一
    if logger.hasHandlers():
        logger.handlers.clear()

    # 关键修复：为线程级logger也添加上下文过滤器
    logger.addFilter(ContextFilter())
        
    formatter = logging.Formatter(
        '[%(asctime)s] [%(levelname)-5s] [%(account)s] [%(project)s] %(message)s',
        datefmt='%H:%M:%S'
    )
    stream_handler = logging.StreamHandler(log_stream)
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)
    
    return logger

def retry_on_unavailable(max_retries=3, delay=2, backoff=2):
    """
    A decorator to retry a function on google.api_core.exceptions.ServiceUnavailable and grpc.RpcError.
    It intelligently finds a logger instance from the function's arguments.
    """
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            logger_instance = None
            for arg in args:
                if isinstance(arg, logging.Logger):
                    logger_instance = arg
                    break
            if 'logger' in kwargs:
                logger_instance = kwargs['logger']
            
            if not logger_instance:
                logger_instance = logging.getLogger() # Fallback to root logger

            current_delay = delay
            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except (google_exceptions.ServiceUnavailable, RpcError):
                    logger_instance.warning(
                        f"'{func.__name__}' failed with ServiceUnavailable or gRPC error (Attempt {attempt + 1}/{max_retries}). "
                        f"Retrying in {current_delay}s..."
                    )
                    if attempt + 1 == max_retries:
                        logger_instance.error(f"All retry attempts for '{func.__name__}' failed.")
                        raise
                    time.sleep(current_delay)
                    current_delay *= backoff
        return wrapper
    return decorator


# 尝试导入，如果失败则给出清晰的错误提示
try:
    from google.cloud import resourcemanager, service_usage, api_keys
    from google.oauth2 import credentials as google_credentials
    from google.auth import exceptions as google_auth_exceptions
    from auto_login import perform_login_automation
    import undetected_chromedriver as uc
    from constants import (STATUS_PROCESSING, STATUS_SUCCESS, STATUS_FAILURE,
                           STATUS_LOGIN_FAILED, STATUS_PARTIAL_SUCCESS, STATUS_PENDING,
                           DependenciesMissingError, GCloudNotInstalledError)
except ImportError as e:
    # 立即抛出自定义异常，而不是退出
    raise DependenciesMissingError(
        "错误: 缺少必要的库。\n"
        "请运行: pip install google-auth google-cloud-resource-manager "
        "google-cloud-service-usage google-cloud-api-keys selenium "
        "undetected-chromedriver"
    ) from e

def check_gcloud_installed():
    """检查gcloud CLI是否已安装并返回其路径"""
    gcloud_path = shutil.which('gcloud')
    if not gcloud_path:
        raise GCloudNotInstalledError(
            "错误: 未找到 'gcloud' 命令行工具。\n"
            "请按照官方文档安装 Google Cloud SDK: \n"
            "https://cloud.google.com/sdk/docs/install"
        )
    return gcloud_path

@retry_on_unavailable()
def enable_api_if_not_enabled(su_client, project_id, logger):
    """检查并启用Generative Language API。"""
    service_name = f"projects/{project_id}/services/generativelanguage.googleapis.com"
    try:
        service = su_client.get_service(request={'name': service_name})
        if service.state == service_usage.State.ENABLED:
            logger.info("✅ API 已启用。")
            return True
    except (google_exceptions.ServiceUnavailable, RpcError):
        raise # Re-raise for the decorator to handle retries
    except google_exceptions.NotFound:
        logger.info("ℹ️ API 未启用，正在尝试启用...")
    except Exception:
        logger.error("❌ 检查API状态时出错:", exc_info=True)
        return False

    try:
        su_client.enable_service(request={'name': service_name}).result(timeout=300)
        logger.info("✅ API 启用成功。")
        return True
    except (google_exceptions.ServiceUnavailable, RpcError):
        raise # Re-raise for the decorator to handle retries
    except Exception:
        logger.error("❌ 启用API时出错:", exc_info=True)
        return False

@retry_on_unavailable()
def create_api_key_if_not_exists(ak_client, project_id, logger):
    """检查项目是否已有API密钥，如果没有则创建并返回密钥字符串。"""
    try:
        keys = ak_client.list_keys(parent=f"projects/{project_id}/locations/global")
        for key in keys:
            if key.restrictions is None or not key.restrictions.api_targets:
                logger.info("✅ 发现已存在的API密钥。")
                key_string = ak_client.get_key_string(request={'name': key.name}).key_string
                return key_string

        logger.info("ℹ️ 未发现可用API密钥，正在创建...")
        key_request = api_keys.CreateKeyRequest(
            parent=f"projects/{project_id}/locations/global",
            key=api_keys.Key(display_name="Auto-Generated Gemini Key")
        )
        api_key_obj = ak_client.create_key(request=key_request).result(timeout=300)
        logger.info("✅ API密钥创建成功。")
        return api_key_obj.key_string
    
    except (google_exceptions.ServiceUnavailable, RpcError):
        raise # Re-raise for the decorator to handle retries
    except Exception:
        logger.error("❌ 处理API密钥时出错:", exc_info=True)
        return None

def process_existing_project(project_id, credentials, account_email, logger):
    """处理单个现有项目：检查API和密钥，成功则返回密钥。"""
    try:
        thread_local.account = account_email
        thread_local.project = project_id
        logger.info("--- 开始处理现有项目 ---")
        su_client = service_usage.ServiceUsageClient(credentials=credentials)
        ak_client = api_keys.ApiKeysClient(credentials=credentials)

        if enable_api_if_not_enabled(su_client, project_id, logger):
            key = create_api_key_if_not_exists(ak_client, project_id, logger)
            if key:
                logger.info("✅ 成功获取密钥。")
                return key
    except Exception as e:
        logger.error(f"❌ 处理项目时发生未知错误: {e}", exc_info=True)
    finally:
        thread_local.project = '-----'
    return None

def configure_project_and_get_key(project_id, credentials, account_email, logger):
    """(配置者)接收一个项目ID，为其启用API并创建密钥。"""
    try:
        thread_local.account = account_email
        thread_local.project = project_id
        logger.info("⚙️ 开始配置项目...")
        su_client = service_usage.ServiceUsageClient(credentials=credentials)
        ak_client = api_keys.ApiKeysClient(credentials=credentials)

        if enable_api_if_not_enabled(su_client, project_id, logger):
            key = create_api_key_if_not_exists(ak_client, project_id, logger)
            if key:
                logger.info("✅ 成功获取密钥。")
                return key
    except Exception:
        logger.error("❌ 配置项目时出错:", exc_info=True)
    finally:
        thread_local.project = '-----'
    return None


def creator_task(credentials, projects_to_configure_queue, account_email, logger, existing_project_display_names, projects_to_create=0, account_stop_event=None, global_stop_event=None):
    """(创建者)循环创建项目，直到达到配额或目标数量。"""
    thread_local.account = account_email
    project_counter = 1
    created_count = 0
    while not ((global_stop_event and global_stop_event.is_set()) or (account_stop_event and account_stop_event.is_set())):
        if projects_to_create > 0 and created_count >= projects_to_create:
            logger.info(f"已达到计划创建的项目数 ({projects_to_create})，创建者任务停止。")
            break
        display_name = f"my-project-{project_counter}"
        
        # 检查显示名称是否已存在，如果存在则跳过并递增计数器
        if display_name in existing_project_display_names:
            logger.info(f"ℹ️ 项目显示名称 '{display_name}' 已存在，跳过。")
            project_counter += 1
            continue

        # 必须在客户端生成唯一的 project_id。
        project_id = f"{display_name}-{random.randint(1000, 9999)}"
        
        thread_local.project = project_id
        logger.info(f"▶️ 提交创建新项目 '{display_name}' (ID: {project_id}) 的请求...")
        
        try:
            rm_client = resourcemanager.ProjectsClient(credentials=credentials)
            project_obj = resourcemanager.Project(
                project_id=project_id,
                display_name=display_name
            )
            
            operation = rm_client.create_project(project=project_obj)
            operation.result(timeout=300)
            
            logger.info(f"✅ 项目 '{display_name}' (ID: {project_id}) 创建成功，已加入配置队列。")
            projects_to_configure_queue.put(project_id)
            created_count += 1
            # 成功创建后，也将新名称加入集合，以防万一
            existing_project_display_names.add(display_name)
            project_counter += 1

        except google_exceptions.AlreadyExists:
            logger.warning(f"⚠️ 项目ID '{project_id}' 已存在（小概率事件），将生成新ID重试...")
            continue # 直接进入下一次循环，project_counter不变，但会生成新的随机ID
        except google_exceptions.ResourceExhausted:
            logger.warning("⏹️ 已达到项目创建配额，创建者任务停止。")
            break
        except google_exceptions.PermissionDenied as e:
            if "project_creation_quota" in str(e) or "PROJECT_CREATION_QUOTA" in str(e):
                logger.warning("⏹️ 已达到项目创建配额，创建者任务停止。")
            else:
                logger.error("❌ 创建项目时权限被拒绝 (非配额问题):", exc_info=True)
            break
        except Exception:
            logger.error("❌ 创建项目时发生未知错误:", exc_info=True)
            break
        finally:
            thread_local.project = '-----'

def handle_existing_projects(credentials, logger, all_keys, lock, account_email, projects, desired_keys=0, account_stop_event=None, global_stop_event=None):
    """(主任务1) 并行处理所有现有项目。"""
    thread_local.account = account_email
    logger.info("--- (任务1) 开始并行处理现有项目 ---")
    if not projects:
        logger.info("没有发现现有项目。")
        return
    
    logger.info(f"开始处理 {len(projects)} 个现有项目。")
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=PROJECT_CHECK_CONCURRENCY) as executor:
            future_to_project = {executor.submit(process_existing_project, p.project_id, credentials, account_email, logger): p for p in projects}
            for future in concurrent.futures.as_completed(future_to_project):
                if (global_stop_event and global_stop_event.is_set()) or (account_stop_event and account_stop_event.is_set()):
                    logger.info("接收到停止信号，提前终止检查现有项目。")
                    executor.shutdown(wait=False, cancel_futures=True)
                    break
                key = future.result()
                if key:
                    with lock:
                        all_keys.add(key)
                        # 检查是否已达到目标数量
                        if desired_keys > 0 and len(all_keys) >= desired_keys:
                            logger.info(f"已为该账号获取 {len(all_keys)}/{desired_keys} 个密钥，达到目标。")
                            if account_stop_event:
                                account_stop_event.set() # 发出针对此账号的停止信号
                            executor.shutdown(wait=False, cancel_futures=True)
                            break
    except google_exceptions.PermissionDenied:
        logger.error("❌ 权限不足，无法列出项目。请检查账号是否拥有 'Project Viewer' 或更高权限。", exc_info=True)
    except google_auth_exceptions.RefreshError:
        logger.error("❌ 身份验证凭据已过期或失效，无法刷新。请尝试重新登录。", exc_info=True)
    except Exception:
        logger.error("❌ 列出或处理现有项目时发生未知错误:", exc_info=True)
    logger.info("--- (任务1) 处理现有项目完成 ---")

def handle_new_projects(credentials, logger, all_keys, lock, account_email, projects, projects_to_create=0, account_stop_event=None, global_stop_event=None, desired_keys=0):
    """(主任务2) 使用创建者/配置者模式处理新项目。"""
    thread_local.account = account_email
    logger.info("--- (任务2) 启动创建者/配置者模式以生成新密钥 ---")
    
    projects_to_configure_queue = queue.Queue()
    existing_project_display_names = {p.display_name for p in projects}
    
    def configurator_worker(email_for_thread, logger_for_thread):
        """配置者线程的工作内容"""
        thread_local.account = email_for_thread
        while not ((global_stop_event and global_stop_event.is_set()) or (account_stop_event and account_stop_event.is_set())):
            try:
                project_id = projects_to_configure_queue.get(timeout=1)
                if project_id is None: # Shutdown signal
                    break # Exit thread
                key = configure_project_and_get_key(project_id, credentials, email_for_thread, logger_for_thread)
                if key:
                    with lock:
                        all_keys.add(key)
                        if desired_keys > 0 and len(all_keys) >= desired_keys:
                            logger.info(f"已为该账号获取 {len(all_keys)}/{desired_keys} 个密钥，达到目标。")
                            if account_stop_event:
                                account_stop_event.set()
                projects_to_configure_queue.task_done()
            except queue.Empty:
                continue # 继续循环检查停止信号

    creator_thread = threading.Thread(
        target=creator_task,
        args=(credentials, projects_to_configure_queue, account_email, logger, existing_project_display_names, projects_to_create, account_stop_event, global_stop_event)
    )
    creator_thread.start()

    configurator_threads = []
    for _ in range(PROJECT_CONFIG_CONCURRENCY):
        t = threading.Thread(target=configurator_worker, args=(account_email, logger))
        t.daemon = True
        t.start()
        configurator_threads.append(t)

    creator_thread.join() # 等待创建者线程结束（即达到配额）
    projects_to_configure_queue.join() # 等待所有已入队的配置任务完成

    # 所有真实任务已完成，现在通过发送None信号来停止工作线程
    for _ in range(len(configurator_threads)):
        projects_to_configure_queue.put(None)
    
    for t in configurator_threads:
        t.join(timeout=5) # 等待线程干净地退出

    logger.info("--- (任务2) 处理新项目完成 ---")


import io

def process_account(account_email, password, gcloud_path, temp_dir, patched_driver_path, stop_event, browser_path=None, gui_queue=None, worker_id=0, desired_keys=0):
    """为指定账号执行完整的认证和资源创建流程。"""
    log_stream = io.StringIO()
    logger = create_thread_logger(f"account.{account_email}", log_stream)
    
    # 如果有GUI队列，也为主线程的logger添加一个队列处理器
    if gui_queue:
        from logging.handlers import QueueHandler
        queue_handler = QueueHandler(gui_queue)
        # 使用根记录器的格式化器
        queue_handler.setFormatter(logging.getLogger().handlers[0].formatter)
        logger.addHandler(queue_handler)

    thread_local.account = account_email
    result = {"account": account_email, "keys": set(), "status": STATUS_FAILURE, "reason": ""}

    try:
        # 立即通知GUI开始处理此账号
        if gui_queue:
            gui_queue.put({"account": account_email, "status": STATUS_PROCESSING})

        # --- 步骤 1: 登录 ---
        login_success = perform_login_automation(account_email, password, gcloud_path, temp_dir, patched_driver_path, stop_event, logger, browser_path, worker_id)
        if stop_event.is_set():
            logger.warning("外部信号中断，登录流程未完成。")
            result["status"] = STATUS_PENDING
            result["reason"] = "被用户强制中断"
            return result
        if not login_success:
            logger.error("登录失败，终止操作。")
            result["status"] = STATUS_LOGIN_FAILED
            
            # 从日志中提取具体的失败原因
            log_content = log_stream.getvalue()
            first_error = ""
            # 从后往前找，最后一条错误通常最能说明问题
            for line in reversed(log_content.splitlines()):
                if "❌" in line:
                    parts = line.split('] ')
                    # 提取真正的消息部分
                    first_error = '] '.join(parts[4:]) if len(parts) > 4 else line
                    break
            result["reason"] = first_error if first_error else "登录失败或被手动中断。"
            return result

        # --- 步骤 2: 加载凭据 ---
        logger.info("正在加载凭证...")
        adc_path = os.path.join(temp_dir, "application_default_credentials.json")
        credentials = google_credentials.Credentials.from_authorized_user_file(adc_path)
        logger.info("✅ 凭证加载成功。")
        lock = threading.Lock()
        
        # --- 步骤 3: 一次性获取所有项目 ---
        if stop_event.is_set():
            logger.warning("外部信号中断，跳过项目处理。")
            result["status"] = STATUS_PENDING
            result["reason"] = "被用户强制中断"
            return result

        logger.info("正在一次性获取所有现有项目列表...")
        try:
            rm_client = resourcemanager.ProjectsClient(credentials=credentials)
            all_projects = list(rm_client.search_projects())
            logger.info(f"✅ 发现 {len(all_projects)} 个现有项目。")
        except Exception as e:
            logger.error(f"❌ 获取项目列表时发生严重错误，无法继续: {e}", exc_info=True)
            result['status'] = STATUS_FAILURE
            result['reason'] = f"获取项目列表失败: {e}"
            return result

        # --- 步骤 4: 根据需求决定任务策略 ---
        account_stop_event = threading.Event() # 为此账号创建独立的停止信号
        num_existing_projects = len(all_projects)
        logger.info(f"需求密钥数: {'不限' if desired_keys == 0 else desired_keys}, 现有项目数: {num_existing_projects}")

        # 如果现有项目已满足需求，则只检查现有项目
        if desired_keys > 0 and num_existing_projects >= desired_keys:
            logger.info("现有项目数已满足需求，仅检查现有项目以获取密钥。")
            handle_existing_projects(credentials, logger, result["keys"], lock, account_email, all_projects, desired_keys, account_stop_event, stop_event)
        else:
            # 计算需要创建的数量
            projects_to_create = 0
            if desired_keys > 0:
                projects_to_create = desired_keys - num_existing_projects
                if projects_to_create < 0: projects_to_create = 0
                logger.info(f"项目数不足，将并行检查现有项目并尝试创建 {projects_to_create} 个新项目。")
            else:
                logger.info("未设置密钥数限制，将并行检查现有项目并创建新项目直到配额用尽。")

            # --- 并行启动两个主任务 ---
            existing_projects_thread = threading.Thread(
                target=handle_existing_projects,
                args=(credentials, logger, result["keys"], lock, account_email, all_projects, desired_keys, account_stop_event, stop_event)
            )
            new_projects_thread = threading.Thread(
                target=handle_new_projects,
                args=(credentials, logger, result["keys"], lock, account_email, all_projects, projects_to_create, account_stop_event, stop_event, desired_keys)
            )

            existing_projects_thread.start()
            if projects_to_create > 0 or desired_keys == 0:
                new_projects_thread.start()

            # 在等待时，周期性检查停止信号
            # The loop should check both the global stop event and the account-specific one.
            threads_to_watch = [existing_projects_thread]
            if new_projects_thread.is_alive():
                threads_to_watch.append(new_projects_thread)

            while any(t.is_alive() for t in threads_to_watch):
                 if stop_event.is_set() or account_stop_event.is_set():
                     logger.warning("接收到停止信号，将等待当前任务完成...")
                     if not account_stop_event.is_set():
                         account_stop_event.set() # Propagate stop signal to all sub-tasks
                     break
                 time.sleep(0.5)

            existing_projects_thread.join()
            if new_projects_thread.is_alive():
                new_projects_thread.join()

        # --- 步骤 5: 返回结果 ---
        key_count = len(result["keys"])
        log_content = log_stream.getvalue()
        # 检查日志中是否有错误标记
        has_errors = "❌" in log_content or "[ERROR]" in log_content or "[CRITICAL]" in log_content

        logger.info(f"--- 任务完成, 共获得 {key_count} 个密钥 ---")
        
        first_error = ""
        if has_errors:
            for line in reversed(log_content.splitlines()):
                if "❌" in line or "[ERROR]" in line or "[CRITICAL]" in line:
                    parts = line.split('] ')
                    first_error = '] '.join(parts[4:]) if len(parts) > 4 else line
                    break

        if key_count > 0:
            if has_errors:
                result["status"] = STATUS_PARTIAL_SUCCESS
                result["reason"] = first_error or "获取到密钥，但过程中存在未知错误。"
            else:
                result["status"] = STATUS_SUCCESS
                result["reason"] = "" # 成功时没有理由
        else:  # key_count == 0
            result["status"] = STATUS_FAILURE
            result["reason"] = first_error or "流程结束，但未能获取到任何密钥。"

    except Exception as e:
        logger.critical(f"处理账号 {account_email} 时发生顶层错误: {e}", exc_info=True)
        result['status'] = STATUS_FAILURE # 确保状态为失败
        result['reason'] = f"发生意外错误: {e}"
    finally:
        # 如果是因为中断而退出，且没有获得任何密钥，则标记为未处理
        if stop_event.is_set() and not result["keys"]:
            result['status'] = STATUS_PENDING
            result['reason'] = "被用户强制中断"
        # 如果中断但获得了部分密钥
        elif stop_event.is_set() and result["keys"]:
             result['status'] = STATUS_PARTIAL_SUCCESS
             result['reason'] = "被用户强制中断"

        # 在返回前，将密钥集合转换为列表
        result['keys'] = list(result['keys'])
        # 在函数末尾，获取所有捕获的日志
        result['log'] = log_stream.getvalue()
        # 此处不能关闭log_stream，因为logging模块可能仍在其他线程中引用与之关联的handler。
        # StringIO对象会在没有引用时被垃圾回收。

    return result

def start_processing(accounts, max_workers, gui_queue, stop_event, browser_path=None, save_path=None, desired_keys=0):
    """
    程序化入口点，用于从GUI或其他脚本调用。
    :param accounts: 一个包含元组(email, password)的列表。
    :param max_workers: 并发工作线程数。
    :param gui_queue: 用于将状态和结果发送回GUI的队列。
    :param stop_event: 用于全局停止的线程事件。
    :param browser_path: 自定义浏览器可执行文件路径。
    :param save_path: 自定义密钥保存路径。
    """
    # 主线程的日志记录器，只发送到GUI队列
    setup_global_logging(log_queue=gui_queue)
    
    try:
        gcloud_path = check_gcloud_installed()
    except GCloudNotInstalledError as e:
        # 这个异常会在主包装器中被捕获并显示给用户
        raise e

    if not accounts:
        logging.info("未提供任何账号。")
        return

    logging.info("\n--- 正在准备浏览器驱动 (仅执行一次)... ---")
    try:
        # 如果提供了自定义浏览器路径，则使用它
        if browser_path and os.path.exists(browser_path):
            logging.info(f"使用自定义浏览器路径: {browser_path}")
            patcher = uc.Patcher(executable_path=browser_path)
        else:
            patcher = uc.Patcher()
        
        patched_driver_path = patcher.executable_path if os.path.exists(patcher.executable_path) else patcher.auto()
        logging.info("✅ 浏览器驱动准备就绪。")
    except Exception as e:
        logging.critical(f"❌ 初始化浏览器驱动失败: {e}")
        logging.critical("请确保已安装兼容的Chrome浏览器。")
        return

    temp_dirs = []
    try:
        temp_dirs = [tempfile.mkdtemp() for _ in accounts]
        
        logging.info(f"\n--- 将使用 {max_workers} 个并发线程启动 {len(accounts)} 个账号任务... ---")

        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {}
            for i, (email, password) in enumerate(accounts):
                if stop_event.is_set():
                    logging.warning("启动过程中检测到停止信号，不再提交新任务。")
                    # 对于未提交的任务，立即返回“未处理”状态
                    if gui_queue:
                        gui_queue.put({"account": email, "status": STATUS_PENDING, "reason": "被用户强制中断"})
                    continue

                temp_dir = temp_dirs[i]
                logging.info(f"   > 正在为账号 '{email}' 提交任务，使用隔离环境: {temp_dir}")
                future = executor.submit(
                    process_account,
                    email,
                    password,
                    gcloud_path,
                    temp_dir,
                    patched_driver_path,
                    stop_event,
                    browser_path,
                    gui_queue,
                    i,
                    desired_keys
                )
                futures[future] = email

            # 当每个任务完成时，立即通过队列发送结果
            for future in concurrent.futures.as_completed(futures):
                try:
                    account_result = future.result()
                    if gui_queue:
                        gui_queue.put(account_result)
                except Exception as e:
                    # 即使线程内部出错，也要尝试记录
                    logging.error(f"--- 任务执行期间发生顶层错误: {e}", exc_info=True)

            # --- 最终报告和文件写入 ---
            # 这部分逻辑将移至GUI端，由GUI收集所有结果后生成
            # 后端只负责处理并发送单个结果
            logging.info("\n" + "="*80)
            logging.info("🎉🎉🎉 所有账号任务已提交并处理完毕 🎉🎉🎉")
            # 不再在这里生成最终报告或写入文件
            # GUI将负责收集所有通过队列发送的结果，并处理后续事宜
            logging.info("="*80)

    except Exception:
        logging.critical("\n--- 脚本主线程因意外错误而中断 ---", exc_info=True)
    finally:
        logging.info("\n--- 正在清理所有临时隔离环境... ---")
        for temp_dir in temp_dirs:
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
                logging.info(f"   > 已清理: {temp_dir}")
            except Exception:
                 logging.warning(f"   > 清理失败: {temp_dir}", exc_info=True)


def main():
    """为命令行使用保留的原始main函数。"""
    setup_global_logging()
    
    accounts_from_args = []
    if len(sys.argv) > 1:
        if len(sys.argv[1:]) % 2 != 0:
            logging.critical("❌ 错误: 命令行参数必须是账号和密码成对出现。")
            sys.exit(1)
        for i in range(0, len(sys.argv[1:]), 2):
            accounts_from_args.append((sys.argv[i+1], sys.argv[i+2]))
    
    if accounts_from_args:
        accounts = accounts_from_args
    else:
        accounts = []
        logging.info("--- 请逐个输入您的Google账号和密码 ---")
        logging.info("   (输入一个空的账号名来结束)")
        while True:
            try:
                email = input("▶️  账号邮箱: ").strip()
                if not email:
                    break
                password = getpass.getpass("▶️  密码 (输入时不可见): ")
                if not password:
                    logging.warning("❌ 密码不能为空。请重新输入该账号。")
                    continue
                accounts.append((email, password))
            except KeyboardInterrupt:
                logging.info("\n操作已取消。")
                sys.exit(0)

    if not accounts:
        logging.info("未输入任何账号。")
        sys.exit(0)
    
    max_workers = 4
    if not accounts_from_args:
        while True:
            try:
                max_workers_str = input(f"▶️  请输入最大并发线程数 (推荐 1-{os.cpu_count() or 4}, 默认为 4): ")
                if not max_workers_str:
                    break
                max_workers = int(max_workers_str)
                if max_workers > 0:
                    break
                else:
                    logging.warning("❌ 请输入一个正整数。")
            except ValueError:
                logging.warning("❌ 无效输入，请输入一个数字。")

    # 注意：在命令行模式下，我们不使用log_queue
    start_processing(accounts, max_workers, None)

    if sys.platform == "win32":
        logging.info("\n按任意键退出...")
        os.system("pause")


if __name__ == "__main__":
    main()