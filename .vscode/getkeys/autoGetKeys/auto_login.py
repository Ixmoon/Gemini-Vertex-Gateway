# file: auto_login.py

import sys
import os
import subprocess
import threading
import signal
import time
import concurrent.futures
from urllib.parse import urlparse
import undetected_chromedriver as uc
from selenium import webdriver
from selenium.common.exceptions import NoSuchWindowException, TimeoutException, InvalidSessionIdException
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
# 导入统一的重试框架
from retry_utils import robust_retry, VerificationRequiredException

# --- 超时常量 (秒) ---
TOTAL_TIMEOUT = 60.0  # 整个自动化流程的总超时
# 单个WebDriver命令的套接字超时。必须小于TOTAL_TIMEOUT，以确保TOTAL_TIMEOUT可以生效。
# 同时也应该大于所有显式的元素等待超时（如ELEMENT_VISIBILITY_TIMEOUT）。
WEBDRIVER_COMMAND_TIMEOUT = 30.0
GCLOUD_AUTH_URL_TIMEOUT = 20.0  # 等待gcloud认证链接的超时
ELEMENT_VISIBILITY_TIMEOUT = 20.0  # 等待通用元素可见的默认超时
ELEMENT_CLICKABLE_TIMEOUT = 10.0  # 等待元素可点击的默认超时
PASSWORD_INPUT_VISIBILITY_TIMEOUT = 15.0 # 单独为密码输入框设置的超时
STALENESS_TIMEOUT = 15.0 # 等待元素从DOM中消失的超时
GCLOUD_PROCESS_JOIN_TIMEOUT = 5.0 # 等待gcloud进程结束的超时
STDERR_THREAD_JOIN_TIMEOUT = 5.0 # 等待stderr线程结束的超时

def _create_driver(browser_path, patched_driver_path, logger, window_size=None, window_position=None):
    """
    创建并配置一个优化的、带有特定选项的 undetected_chromedriver 实例。
    """
    options = webdriver.ChromeOptions()

    # 页面加载策略: 'eager' 表示等待DOM加载完成，但不等待图片、样式表等资源。
    options.page_load_strategy = 'eager'

    # --- 窗口位置和大小的参数设置（作为后备） ---
    if window_size:
        formatted_size = window_size.replace('x', ',').replace('X', ',')
        options.add_argument(f'--window-size={formatted_size}')

    if window_position:
        options.add_argument(f'--window-position={window_position}')
    
    # --- 性能和隐蔽性优化参数 ---
    options.add_argument('--incognito')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    # 禁用浏览器扩展，减少不必要的开销
    options.add_argument('--disable-extensions')
    options.add_argument('--ignore-certificate-errors')
    options.add_argument('--allow-insecure-localhost')
    # 禁用图片加载可以显著加快页面渲染速度
    options.add_argument('--blink-settings=imagesEnabled=false')
    # 即使窗口被其他窗口覆盖，也禁用后台计时器限制
    options.add_argument('--disable-background-timer-throttling')
    # 禁用因遮挡而将渲染器置于后台的功能
    options.add_argument('--disable-backgrounding-occluded-windows')
    # 禁用渲染器后台处理
    options.add_argument('--disable-renderer-backgrounding')
    # 核心修复：禁用弹出窗口拦截，以允许window.open()正常工作
    options.add_argument("--disable-popup-blocking")

    driver_path = browser_path if browser_path and os.path.exists(browser_path) else patched_driver_path
    
    driver = uc.Chrome(
        driver_executable_path=driver_path,
        options=options
    )

    # --- 强制设置窗口大小和位置（主要方法） ---
    # 这是更可靠的方法，在驱动启动后直接调用命令
    try:
        if window_size:
            # 解析 "widthxheight" 格式的字符串
            parts = window_size.lower().split('x')
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                width, height = int(parts[0]), int(parts[1])
                driver.set_window_size(width, height)
        
        if window_position:
            # 解析 "x,y" 格式的字符串
            parts = window_position.replace(' ', '').split(',')
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                x, y = int(parts[0]), int(parts[1])
                driver.set_window_position(x, y)

    except Exception:
        # 在生产环境中，我们可能不希望因为窗口设置失败而使整个程序崩溃，
        # 因此静默处理异常。
        pass

    return driver

def perform_login_automation(account_email, password, gcloud_path, temp_dir, patched_driver_path, stop_event, logger, browser_path=None, worker_id=0, window_size=None, window_position=None):
    """
    在一个隔离的环境中，为指定账号执行gcloud登录的浏览器自动化部分。
    成功时返回 True，失败时返回 False。日志直接通过传入的logger对象记录。
    """

    def try_step(action_function, expected_url_part, step_name, max_retries=3):
        """
        尝试执行一个操作，并验证URL。如果URL不正确，则返回并重试。
        """
        for attempt in range(max_retries):
            if stop_event.is_set(): return False
            
            action_function() # 执行定义的操作，如点击按钮

            current_url = driver.current_url
            if expected_url_part in current_url:
                logger.info(f"✅ {step_name} 成功，URL正确。")
                return True # 成功，跳出重试循环
            
            logger.warning(f"⚠️ {step_name} 后URL跳转异常 (第 {attempt + 1} 次尝试)。")
            logger.warning(f"   - 期望URL包含: '{expected_url_part}'")
            logger.warning(f"   - 实际URL为: '{current_url}'")
            logger.info("   - 正在尝试返回上一页并重试...")

            driver.back()

        logger.error(f"❌ {step_name} 在 {max_retries} 次尝试后仍然失败。")
        return False
    
    def cleanup_resources():
        """
        一个强化的、本地化的清理函数，确保无论如何都能终止所有相关进程。
        """
        nonlocal driver, process, stderr_thread
        
        # 1. 终止 Selenium WebDriver 和浏览器进程
        if driver:
            logger.info("> 正在强制终止浏览器和驱动...")
            
            # 直接、强制地终止所有相关进程
            pids_to_kill = []
            if hasattr(driver, 'browser_pid') and driver.browser_pid:
                pids_to_kill.append(driver.browser_pid)
            if hasattr(driver, 'service') and driver.service and hasattr(driver.service, 'process'):
                pids_to_kill.append(driver.service.process.pid)

            for pid in pids_to_kill:
                try:
                    if sys.platform == "win32":
                        # 核心修复：添加 /T 参数来终止整个进程树
                        subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)], check=False, capture_output=True)
                    else:
                        os.kill(int(pid), signal.SIGKILL)
                except (ProcessLookupError, TypeError, OSError):
                    pass # 进程可能已经不存在
            
            # 解除与后台服务的关联，防止垃圾回收器再次尝试调用quit()
            if hasattr(driver, 'service'):
                driver.service = None
            
            driver = None

        # 2. 终止 gcloud 进程树
        if process and process.poll() is None:
            logger.info(f"> 正在终止gcloud进程树 (PID: {process.pid})...")
            try:
                if sys.platform == "win32":
                    # /T 选项会终止进程及其所有子进程
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(process.pid)], check=False, capture_output=True)
                else:
                    # 使用 os.killpg 发送信号到整个进程组
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                logger.info("> gcloud进程树已终止。")
            except (ProcessLookupError, PermissionError, OSError) as e:
                 logger.warning(f"> 终止gcloud进程树时出错: {e}")
            finally:
                process = None
        
        # 3. 等待stderr线程结束
        if stderr_thread and stderr_thread.is_alive():
            stderr_thread.join(timeout=STDERR_THREAD_JOIN_TIMEOUT)

    thread_local_env = os.environ.copy()
    thread_local_env['CLOUDSDK_CONFIG'] = temp_dir

    process = None
    driver = None
    stderr_thread = None


    try:
        def capture_gcloud_stderr(pipe, url_event, url_container, stderr_lines):
            """读取gcloud的stderr流，查找认证URL并捕获所有输出。"""
            try:
                for line in iter(pipe.readline, ''):
                    stderr_lines.append(line)
                    stripped_line = line.strip()
                    if not url_event.is_set() and stripped_line.startswith("https://accounts.google.com/o/oauth2/auth"):
                        url_container['url'] = stripped_line
                        url_event.set()
            except Exception:
                pass
        def password_step_action():
            password_next_button = wait_and_check_stop(EC.visibility_of_element_located((By.ID, 'passwordNext')), ELEMENT_CLICKABLE_TIMEOUT)
            password_next_button.click()
            wait_and_check_stop(EC.staleness_of(password_next_button), STALENESS_TIMEOUT)

        logger.info("--- GCloud 自动登录---")

        deadline = time.time() + TOTAL_TIMEOUT  # 90秒总超时, 为重试提供充足时间

        auth_url_event = threading.Event()
        auth_url_container = {}
        gcloud_stderr_lines = []

        preexec_fn = os.setsid if sys.platform != "win32" else None

        process = subprocess.Popen(
            [gcloud_path, "auth", "login", account_email, "--update-adc", "--brief", "--no-launch-browser", "--quiet"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            universal_newlines=True,
            env=thread_local_env,
            preexec_fn=preexec_fn
        )

        stderr_thread = threading.Thread(
            target=capture_gcloud_stderr,
            args=(process.stderr, auth_url_event, auth_url_container, gcloud_stderr_lines)
        )
        stderr_thread.daemon = True
        stderr_thread.start()

        # --- (并行) 获取认证链接 和 创建WebDriver ---
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            logger.info("ℹ️  正在并行启动浏览器和等待gcloud认证链接...")
            
            # 任务1: 创建WebDriver
            driver_future = executor.submit(_create_driver, browser_path, patched_driver_path, logger, window_size, window_position)
            
            # 任务2: 等待认证链接
            auth_wait_timeout = min(GCLOUD_AUTH_URL_TIMEOUT, max(0.1, deadline - time.time()))
            auth_url_event_is_set = auth_url_event.wait(timeout=auth_wait_timeout)

            # 检查认证链接是否获取成功
            if not auth_url_event_is_set:
                if stop_event.is_set():
                    logger.info("认证链接等待超时，且检测到停止信号。")
                elif time.time() >= deadline:
                    logger.warning("⚠️ 整体流程超时，未能捕获认证链接。")
                else:
                    logger.warning(f"⚠️ 未能在 {auth_wait_timeout:.1f} 秒内捕获认证链接。")
                
                # 尝试获取可能已经创建的driver，以便于清理
                try:
                    driver = driver_future.result(timeout=5)
                except Exception:
                    driver = None # 如果创建失败或超时，driver设为None
                
                cleanup_resources()
                return False

            logger.info("✅ 成功捕获认证链接")
            
            # 从future中获取已经创建好的driver实例
            try:
                logger.info("ℹ️  正在等待浏览器实例完成初始化...")
                driver = driver_future.result(timeout=20) # 应该很快，因为是并行的
                if not driver:
                    raise RuntimeError("驱动程序创建函数返回了None。")
                
                # 核心修复: 强制设置WebDriver的命令超时，使其小于TOTAL_TIMEOUT。
                # 这可以防止任何单个的driver命令阻塞超过整个流程的忍耐时间，从而让TOTAL_TIMEOUT机制有机会生效。
                if hasattr(driver, 'command_executor') and hasattr(driver.command_executor, '_conn'):
                    driver.command_executor._conn.timeout = WEBDRIVER_COMMAND_TIMEOUT
                    logger.info(f"✅ 浏览器实例已就绪, 底层命令超时已设置为: {WEBDRIVER_COMMAND_TIMEOUT} 秒。")
                else:
                    logger.info("✅ 浏览器实例已就绪。")
            except Exception as e:
                logger.error(f"❌ 创建浏览器实例时发生意外错误: {e}", exc_info=True)
                # driver可能部分创建，也可能没有。无论如何，cleanup都会处理
                cleanup_resources()
                return False

        # 强制使用英文界面，确保后续的文本选择器能够稳定工作
        auth_url = auth_url_container['url'] + '&hl=en'
        driver.get(auth_url)
        # 在启动浏览器后，将检查循环嵌入到每一步操作中
        def wait_and_check_stop(condition, timeout, non_blocking=False):
            """
            包装WebDriverWait。
            - 阻塞模式 (默认): 在等待时周期性检查stop_event。
            - 非阻塞模式: 立即检查元素是否存在，不存在则返回None。
            """
            if non_blocking:
                if stop_event.is_set():
                    raise InterruptedError("用户请求停止。")
                try:
                    # 非阻塞式检查，超时设为0
                    return WebDriverWait(driver, 0).until(condition)
                except TimeoutException:
                    return None

            end_time = time.time() + timeout
            while time.time() < end_time:
                if stop_event.is_set():
                    raise InterruptedError("用户请求停止。")
                try:
                    # 阻塞式检查，使用短轮询间隔
                    element = WebDriverWait(driver, 0.2).until(condition)
                    return element
                except TimeoutException:
                    continue
            raise TimeoutError(f"在 {timeout} 秒内等待元素超时。")

        # --- 步骤 1: 输入邮箱并等待密码框 ---
        email_input = wait_and_check_stop(EC.visibility_of_element_located((By.ID, 'identifierId')), ELEMENT_VISIBILITY_TIMEOUT)
        email_input.send_keys(account_email)
        
        def email_step_action():
            next_button = wait_and_check_stop(EC.visibility_of_element_located((By.ID, 'identifierNext')), ELEMENT_CLICKABLE_TIMEOUT)
            next_button.click()
            wait_and_check_stop(EC.staleness_of(next_button), STALENESS_TIMEOUT)

        if not try_step(email_step_action, "accounts.google.com", "输入邮箱"):
            return False

        # --- 步骤 2: 复合页面判断 (密码/人机验证/2FA) ---
        logger.info("ℹ️  正在判断下一步页面类型...")
        
        password_condition = EC.visibility_of_element_located((By.CSS_SELECTOR, 'input[type="password"]'))
        robot_condition = EC.visibility_of_element_located((By.XPATH, "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'robot')]"))
        two_fa_condition = EC.visibility_of_element_located((By.XPATH, "//*[contains(., '2-Step')]"))

        try:
            # 等待上述任何一个条件成立
            element = wait_and_check_stop(EC.any_of(
                password_condition,
                robot_condition,
                two_fa_condition
            ), PASSWORD_INPUT_VISIBILITY_TIMEOUT)
            
            # 判断返回的是哪个元素
            if element.get_attribute('type') == 'password':
                logger.info("✅ 页面为密码输入页，流程继续。")
                password_input = element
            else:
                # 如果不是密码框，说明是人机验证或2FA，抛出特定异常
                message = f"需人工验证'"
                logger.error(f"❌ {message}。")
                raise VerificationRequiredException(message)

        except TimeoutException:
            message = f"在 {PASSWORD_INPUT_VISIBILITY_TIMEOUT} 秒内未等到密码框或任何已知验证页面。"
            logger.error(f"❌ {message}。")
            raise VerificationRequiredException(message)

        # --- 步骤 2 (续): 输入密码并等待页面跳转 ---
        password_input.send_keys(password)



        password_step_action()
        logger.info("✅ 密码已提交，正在进入轮询阶段...")

        # --- 步骤 3 & onwards: 单线程轮询并发模型 ---
        try:
            logger.info("--- (轮询并发) 开始处理凭证和所有服务条款 ---")
            
            # 1. 定义任务
            main_flow_handle = driver.current_window_handle
            gen_lang_url = "https://console.cloud.google.com/terms/generative-language-api?inv=1&invt=Ab4Lsw&hl=en"
            universal_url = "https://console.developers.google.com/terms/universal?hl=en"
            
            # 2. 逐一打开新窗口并确定性地获取句柄 (最终鲁棒性优化)
            def open_and_get_handle(url):
                """打开一个新窗口并返回其唯一的句柄。"""
                original_handles = set(driver.window_handles)
                driver.execute_script("window.open(arguments[0], '_blank');", url)
                
                wait_for_handle_deadline = time.time() + 5
                while time.time() < wait_for_handle_deadline:
                    new_handles = set(driver.window_handles) - original_handles
                    if new_handles:
                        return new_handles.pop()
                    time.sleep(0.2)
                raise TimeoutError(f"打开 {url} 后未能找到新窗口的句柄。")

            gen_lang_handle = open_and_get_handle(gen_lang_url)
            universal_handle = open_and_get_handle(universal_url)
            
            driver.switch_to.window(main_flow_handle)

            # 3. 初始化任务状态机
            tasks = {
                "main": {"handle": main_flow_handle, "status": "wait_continue", "result": None, "name": "主流程", "refresh_count": 0},
                "gen_lang": {"handle": gen_lang_handle, "status": "wait_accept", "result": False, "name": "Gen Language ToS", "refresh_count": 0},
                "universal": {"handle": universal_handle, "status": "wait_accept", "result": False, "name": "Universal ToS", "refresh_count": 0},
            }
            active_tasks = list(tasks.values()) # 动态任务列表 (性能优化)
            
            # 4. 轮询执行循环 (使用全局 deadline 保证总超时)
            logger.info(f"ℹ️  轮询阶段开始，剩余时间: {max(0, deadline - time.time()):.1f} 秒。")
            while time.time() < deadline:
                if not active_tasks: # 如果没有活动任务，则提前结束
                    logger.info("✅ 所有并发任务均已处理完毕，提前退出轮询。")
                    break

                # 性能与鲁棒性优化：使用索引迭代以避免创建列表副本，并处理窗口意外关闭的情况
                i = 0
                while i < len(active_tasks):
                    task = active_tasks[i]
                    
                    try:
                        # 内层 try...except 用于处理超时并刷新
                        try:
                            # 每次循环都尝试切换到任务窗口
                            driver.switch_to.window(task["handle"])
                            
                            current_status = task["status"]
                            
                            # --- 主流程任务 ---
                            if task["name"] == "主流程":
                                current_url = driver.current_url
                                hostname = urlparse(current_url).hostname if current_url else ""
                                is_on_correct_page = hostname == "accounts.google.com" or hostname == "sdk.cloud.google.com"

                                if not is_on_correct_page:
                                    logger.warning(f"⚠️ ({task['name']}) 发生意外跳转: {hostname}，尝试回退...")
                                    driver.back()
                                    time.sleep(1) # 等待页面回退
                                    task["status"] = "unknown" # 进入未知状态，准备进行落点判断
                                else:
                                    # 只有在URL正确的前提下，才执行状态机操作
                                    if current_status == "wait_continue":
                                        continue_button = wait_and_check_stop(EC.visibility_of_element_located((By.XPATH, '//*[text()="Continue"]')), 0, non_blocking=True)
                                        if continue_button:
                                            logger.info(f"✅ ({task['name']}) 找到 'Continue' 按钮，正在点击...")
                                            driver.execute_script("arguments[0].click();", continue_button)
                                            task["status"] = "wait_allow"
                                    
                                    elif current_status == "wait_allow":
                                        allow_button = wait_and_check_stop(EC.visibility_of_element_located((By.XPATH, '//*[text()="Allow"]')), 0, non_blocking=True)
                                        if allow_button:
                                            logger.info(f"✅ ({task['name']}) 找到 'Allow' 按钮，正在点击...")
                                            driver.execute_script("arguments[0].click();", allow_button)
                                            task["status"] = "wait_code"

                                    elif current_status == "wait_code":
                                        code_element = wait_and_check_stop(EC.visibility_of_element_located((By.XPATH, "//*[starts-with(text(), '4/0')]")), 0, non_blocking=True)
                                        if code_element:
                                            verification_code = code_element.text
                                            task["result"] = verification_code
                                            # --- 核心修改: 立即提交凭证并关闭窗口 ---
                                            logger.info(f"✅ ({task['name']}) 成功获取凭证: {verification_code[:15]}... 立即提交认证并关闭主窗口。")
                                            process.stdin.write(verification_code + '\n')
                                            process.stdin.flush()
                                            driver.close() # 关闭当前窗口 (主流程窗口)
                                            # 标记主流程的核心任务完成，但循环会继续处理其他TOS任务
                                            task["status"] = "done"
                                    
                                    elif current_status == "unknown":
                                        logger.info(f"ℹ️ ({task['name']}) 处于 'unknown' 状态，进行一次性复合探测...")
                                        
                                        # 性能优化：一次性探测所有可能的落点元素
                                        allow_condition = EC.visibility_of_element_located((By.XPATH, '//*[text()="Allow"]'))
                                        continue_condition = EC.visibility_of_element_located((By.XPATH, '//*[text()="Continue"]'))
                                        account_condition = EC.visibility_of_element_located((By.XPATH, f"//div[text()='{account_email}']"))
                                        
                                        found_element = wait_and_check_stop(EC.any_of(allow_condition, continue_condition, account_condition), 0, non_blocking=True)
                                        
                                        if found_element:
                                            element_text = found_element.text
                                            if "Allow" in element_text:
                                                logger.info(f"✅ ({task['name']}) [落点判断] 发现 'Allow' 按钮，状态设置为 'wait_allow'。")
                                                task["status"] = "wait_allow"
                                            elif "Continue" in element_text:
                                                logger.info(f"✅ ({task['name']}) [落点判断] 发现 'Continue' 按钮，状态设置为 'wait_continue'。")
                                                task["status"] = "wait_continue"
                                            elif account_email in element_text:
                                                logger.info(f"✅ ({task['name']}) [落点判断] 发现账户选择按钮，正在点击...")
                                                found_element.click()
                                                task["status"] = "wait_continue"
                                        else:
                                            logger.info(f"ℹ️ ({task['name']}) [落点判断] 未发现关键元素，将在下一轮继续探测。")

                            # --- 服务条款任务 ---
                            else:
                                accepted_texts = ["The requested Terms of Service have already been accepted.", "The Terms of Service were accepted."]
                                accepted_conditions = [EC.presence_of_element_located((By.XPATH, f"//*[contains(normalize-space(.), '{text}')]")) for text in accepted_texts]

                                if current_status == "wait_accept":
                                    condition = EC.any_of(EC.visibility_of_element_located((By.XPATH, "//button[normalize-space()='Accept']")), *accepted_conditions)
                                    outcome = wait_and_check_stop(condition, timeout=0, non_blocking=True)
                                    if outcome:
                                        if outcome.tag_name == 'button':
                                            logger.info(f"✅ ({task['name']}) 找到'Accept'按钮，正在点击...")
                                            driver.execute_script("arguments[0].click();", outcome)
                                            task["status"] = "wait_accept_confirmation"
                                        else:
                                            logger.info(f"✅ ({task['name']}) 服务条款已接受。")
                                            task["status"] = "done"
                                            task["result"] = True
                                            driver.close()
                                
                                elif current_status == "wait_accept_confirmation":
                                    condition = EC.any_of(*accepted_conditions)
                                    outcome = wait_and_check_stop(condition, timeout=0, non_blocking=True)
                                    if outcome:
                                        logger.info(f"✅ ({task['name']}) 服务条款确认成功。")
                                        task["status"] = "done"
                                        task["result"] = True
                                        driver.close()

                        except (TimeoutError, TimeoutException):
                            if task['refresh_count'] < 2:
                                logger.warning(f"⚠️ ({task['name']}) 操作超时，正在尝试刷新... (第 {task['refresh_count'] + 1} 次)")
                                if time.time() < deadline:
                                    # 核心加固：在刷新前，再次确保焦点在正确的窗口上，防止意外跳转导致刷新错误页面。
                                    driver.switch_to.window(task["handle"])
                                    driver.refresh()
                                    task['refresh_count'] += 1
                                else:
                                    logger.error(f"❌ ({task['name']}) 刷新前已达总超时，将任务标记为失败。")
                                    task['status'] = 'done'
                                    task['result'] = False
                            else:
                                logger.error(f"❌ ({task['name']}) 操作超时，且已达到最大刷新次数(2次)，将任务标记为失败。")
                                task['status'] = 'done'
                                task['result'] = False
                    
                    except NoSuchWindowException:
                        logger.warning(f"⚠️ ({task['name']}) 任务窗口已不存在，将从队列中移除。")
                        task["status"] = "done" # 标记为完成以确保被移除

                    # 检查任务是否完成，如果完成则从列表中移除，否则递增索引
                    if task["status"] == "done":
                        active_tasks.pop(i)
                    else:
                        i += 1
                
                time.sleep(0.2)

            # 5. 检查最终结果
            # 此时，凭证应该已经提交，我们只需确保所有任务都已标记为'done'
            if any(t["status"] != "done" for t in tasks.values()):
                # 检查是否是由于总超时退出循环
                if time.time() >= deadline:
                    raise TimeoutError("轮询并发处理超时，主流程凭证也未获取。")
                
                # 如果不是因为超时，但仍有未完成任务（例如所有窗口都意外关闭）
                # 检查主流程是否是因为拿到code而完成的
                if tasks["main"]["status"] == "done" and tasks["main"]["result"]:
                     logger.warning("⚠️ 主流程凭证已提交，但部分服务条款(ToS)窗口在完成前关闭或处理失败。")
                else:
                    # 这种情况理论上不应该发生，除非所有窗口都被手动关闭
                    logger.error("❌ 轮询意外终止，主流程凭证也未获取。")
                    raise RuntimeError("轮询意外终止，未能完成所有任务。")

            # 再次验证所有任务是否都成功
            if not tasks["main"]["result"] or not tasks["gen_lang"]["result"] or not tasks["universal"]["result"]:
                # 收集失败的任务信息
                failed_tasks = [t["name"] for t in tasks.values() if not t["result"]]
                raise RuntimeError(f"未能成功完成所有并发任务。失败的任务: {', '.join(failed_tasks)}")

            logger.info("✅ 所有浏览器自动化任务均已完成。")
            # 在这里关闭stdin是安全的，因为凭证已经写入并且所有浏览器任务都已结束
            process.stdin.close()
        except Exception as e:
            logger.error(f"❌ 并行处理凭证和条款时发生错误: {e}", exc_info=False)
            return False
        
        # --- (并行) 等待gcloud进程结束并检查结果 ---
        logger.info("ℹ️  正在等待gcloud进程完成认证...")
        try:
            # 给予一个固定的、合理的超时（例如10秒），以确保gcloud有足够的时间完成凭证写入。
            # 不再使用动态计算的deadline，因为它可能在之前的步骤中被耗尽。
            process.wait(timeout=10)
        except TimeoutException:
            logger.error("❌ gcloud 进程在写入凭证时超时。")
            return False

        if process.returncode != 0:
            stderr_thread.join(timeout=GCLOUD_PROCESS_JOIN_TIMEOUT)
            error_lines = []
            initial_prompt_found = False
            for line in gcloud_stderr_lines:
                if "Go to the following link" in line: initial_prompt_found = True
                if initial_prompt_found and "https://accounts.google.com/o/oauth2/auth" in line: continue
                if initial_prompt_found and not line.strip().startswith("https://"): error_lines.append(line)
            error_details = "".join(error_lines).strip()
            if error_details:
                logger.error(f"❌ gcloud 认证失败:\n---\n{error_details}\n---")
            else:
                logger.error("gcloud 未提供错误。")
            return False
            
        logger.info("✅ 全流程处理完毕！")
        return True

    except Exception as e:
        # 核心修复：如果异常是需要人工干预的特定类型，则直接重新抛出，以便上层可以捕获并停止重试
        if isinstance(e, VerificationRequiredException):
            raise

        # 创建一个统一的异常处理块
        error_map = {
            InterruptedError: "认证流程被用户主动中断。",
            NoSuchWindowException: "浏览器窗口被意外关闭。",
            InvalidSessionIdException: "浏览器会话已失效。",
            TimeoutError: f"自动化操作超时: {e}",
        }
        error_message = error_map.get(type(e), f"发生未知错误: {e}")
        
        if isinstance(e, (InterruptedError, NoSuchWindowException, TimeoutError)):
             logger.warning(f"❌ {error_message}")
        else:
             logger.critical(f"❌ {error_message}", exc_info=True)
        
        return False
    finally:
        # 无论成功或失败，这个块都将被执行，确保资源被清理
        cleanup_resources()