# file: auto_login.py

import sys
import os
import subprocess
import threading
import signal
import logging
import time
import tkinter as tk

try:
    import undetected_chromedriver as uc
    from selenium import webdriver
    from selenium.common.exceptions import NoSuchWindowException, TimeoutException
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    # 导入自定义异常
    from constants import DependenciesMissingError
except ImportError as e:
    raise DependenciesMissingError(
        "错误: 缺少必要的库 (selenium, undetected-chromedriver)。\n"
        "请运行: pip install selenium undetected-chromedriver"
    ) from e

def perform_login_automation(account_email, password, gcloud_path, temp_dir, patched_driver_path, stop_event, logger, browser_path=None, worker_id=0):
    """
    在一个隔离的环境中，为指定账号执行gcloud登录的浏览器自动化部分。
    成功时返回 True，失败时返回 False。日志直接通过传入的logger对象记录。
    """
    # 注意：这里的logging上下文是在调用者(getkeys.py)的线程中设置的
    thread_local_env = os.environ.copy()
    thread_local_env['CLOUDSDK_CONFIG'] = temp_dir

    process = None
    driver = None
    stderr_thread = None

    def cleanup_resources():
        """手动、权威地终止所有子进程（浏览器、驱动、gcloud），绕过库中不可靠的quit方法。"""
        nonlocal driver, process, stderr_thread
        
        if driver:
            logger.info("> 正在手动终止浏览器和驱动进程...")
            pids_to_kill = []
            if driver.browser_pid:
                pids_to_kill.append(driver.browser_pid)
            if driver.service and hasattr(driver.service, 'process'):
                pids_to_kill.append(driver.service.process.pid)

            for pid in pids_to_kill:
                try:
                    if sys.platform == "win32":
                        subprocess.run(['taskkill', '/F', '/PID', str(pid)], check=False, capture_output=True)
                    else:
                        os.kill(pid, signal.SIGKILL)
                except Exception:
                    pass
            logger.info("> 浏览器和驱动进程已终止。")
            driver = None

        if process and process.poll() is None:
            logger.info(f"> 正在强制终止gcloud进程树 (PID: {process.pid})...")
            try:
                if sys.platform == "win32":
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(process.pid)], check=True, capture_output=True, text=True)
                else:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                logger.info("> gcloud进程树已成功终止。")
            except (subprocess.CalledProcessError, ProcessLookupError):
                pass
            except Exception as e:
                logger.warning(f"> 终止gcloud子进程时发生未知错误: {e}")
            finally:
                process = None
        
        if stderr_thread and stderr_thread.is_alive():
            stderr_thread.join(timeout=2)

    try:
        logger.info("--- 开始自动化认证 ---")

        # --- 优化: 减少Selenium的日志输出，降低I/O开销 ---
        logging.getLogger('selenium.webdriver.remote.remote_connection').setLevel(logging.WARNING)
        logging.getLogger('urllib3.connectionpool').setLevel(logging.WARNING)
        deadline = time.time() + 60.0  # 60秒总超时

        # 在开始任何耗时操作前，先检查一次停止信号
        if stop_event.is_set():
            logger.info("检测到停止信号，取消认证流程。")
            return False

        auth_url_event = threading.Event()
        auth_url_container = {}
        gcloud_stderr_lines = []

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

        logger.info("ℹ️  正在等待gcloud生成认证链接...")
        auth_wait_timeout = min(20.0, max(0.1, deadline - time.time()))
        if not auth_url_event.wait(timeout=auth_wait_timeout):
            # 在等待后再次检查，因为等待期间可能已发出停止信号
            if stop_event.is_set():
                logger.info("认证链接等待超时，且检测到停止信号。")
            elif time.time() >= deadline:
                logger.warning("⚠️ 整体流程超时，未能捕获认证链接。")
            else:
                logger.warning(f"⚠️ 未能在 {auth_wait_timeout:.1f} 秒内捕获认证链接。")
            cleanup_resources()
            return False

        logger.info("✅ 成功捕获认证链接，正在启动浏览器并自动登录...")
        
        options = webdriver.ChromeOptions()

        # 页面加载策略: 'none'表示不等待页面加载完成。
        # 这使得脚本可以立即开始查找元素，而不是等待任何页面加载信号。
        options.page_load_strategy = 'none'

        # --- 窗口位置和大小设置 ---
        try:
            # 使用tkinter获取屏幕尺寸，而不需要一个完整的GUI应用
            root = tk.Tk()
            root.withdraw() # 隐藏主窗口
            screen_width = root.winfo_screenwidth()
            screen_height = root.winfo_screenheight()
            root.destroy()
        except Exception:
            # 如果tkinter失败，回退到默认值
            screen_width = 1920
            screen_height = 1080
            logger.warning("无法使用tkinter获取屏幕尺寸，回退到默认值 1920x1080。")

        window_width = 500
        window_height = 700
        
        # 计算每行可以容纳多少个窗口
        cols = max(1, screen_width // window_width)
        
        # 计算窗口的行和列索引
        col_index = worker_id % cols
        row_index = worker_id // cols
        
        # 计算窗口位置
        pos_x = col_index * window_width
        pos_y = row_index * (window_height + 40) # 增加40像素的间距以避免窗口标题栏重叠

        # 如果垂直方向超出屏幕，则重置到左上角，允许重叠
        if pos_y + window_height > screen_height:
             pos_y = 0
             logger.warning(f"窗口(Worker {worker_id})垂直位置超出屏幕，重置到顶部。")

        options.add_argument(f'--window-size={window_width},{window_height}')
        options.add_argument(f'--window-position={pos_x},{pos_y}')
        
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

        driver_path = browser_path if browser_path and os.path.exists(browser_path) else patched_driver_path
        logger.info(f"使用驱动路径: {driver_path}")
        
        driver = uc.Chrome(
            driver_executable_path=driver_path,
            options=options
        )
        
        # 强制使用英文界面，确保后续的文本选择器能够稳定工作
        auth_url = auth_url_container['url'] + '&hl=en'
        driver.get(auth_url)
        wait = WebDriverWait(driver, 20)

        # 在启动浏览器后，将检查循环嵌入到每一步操作中
        def wait_and_check_stop(condition, deadline):
            """包装WebDriverWait，在等待时周期性检查stop_event和总超时。"""
            wait_interval = 0.1 # seconds, 缩短轮询间隔以加快响应
            end_time = deadline
            while time.time() < end_time:
                if stop_event.is_set():
                    logger.info("浏览器操作期间检测到停止信号，中断。")
                    return None # 返回一个可识别为中断的信号
                try:
                    # 等待一个短间隔，而不是总剩余时间，以允许频繁检查stop_event
                    element = WebDriverWait(driver, min(wait_interval, max(0.1, end_time - time.time()))).until(condition)
                    return element
                except TimeoutException:
                    continue # 正常的等待超时，继续循环
            # 如果循环结束仍未找到元素，则手动引发一个可识别的超时错误
            raise TimeoutError("等待元素超时或总流程超时")

        # --- 步骤 1: 输入邮箱并等待密码框 ---
        email_input = wait_and_check_stop(EC.visibility_of_element_located((By.ID, 'identifierId')), deadline)
        if email_input is None: cleanup_resources(); return False
        email_input.send_keys(account_email)
        driver.find_element(By.ID, 'identifierNext').click()
        
        # --- 步骤 2: 输入密码并等待页面跳转 ---
        password_input = wait_and_check_stop(EC.visibility_of_element_located((By.CSS_SELECTOR, 'input[type="password"]')), deadline)
        if password_input is None: cleanup_resources(); return False
        password_input.send_keys(password)
        driver.find_element(By.ID, 'passwordNext').click()

        try:
            wait = WebDriverWait(driver, 5)
            result = wait.until(
                EC.any_of(
                    # 注意: 此处的XPath是必要的，因为错误消息的元素没有稳定的ID
                    EC.visibility_of_element_located((By.XPATH, '//*[contains(text(), "Wrong password")]')),
                    EC.title_contains("2-Step Verification")
                )
            )
            if hasattr(result, 'tag_name'):
                logger.error("❌ 错误：登录失败，密码不正确。")
            else:
                logger.error("❌ 错误：此账号需要两步验证（2FA）")
            
            cleanup_resources()
            return False
            
        except Exception:
            pass

        # 注意: 后续按钮依赖于文本内容，这是因为Google页面的元素ID不固定。
        # 通过强制hl=en，我们可以安全地只检查英文文本。
        # --- 步骤 3: 点击 'Continue' 并等待 'Allow' 按钮 ---
        continue_button = wait_and_check_stop(EC.visibility_of_element_located((By.XPATH, '//*[text()="Continue"]')), deadline)
        if continue_button is None: cleanup_resources(); return False
        continue_button.click()

        # --- 步骤 4: 点击 'Allow' 并等待成功页面 ---
        allow_button = wait_and_check_stop(EC.visibility_of_element_located((By.XPATH, '//*[text()="Allow"]')), deadline)
        if allow_button is None: cleanup_resources(); return False
        allow_button.click()
        
        # --- 步骤 5: 等待并直接读取凭证 ---
        # 点击"Allow"后，我们不再等待"Copy"按钮，而是直接轮询凭证元素的出现。
        # gcloud的凭证通常以 "4/0" 开头。我们使用XPath来查找包含此特征文本的元素。
        verification_code_element = wait_and_check_stop(EC.visibility_of_element_located((By.XPATH, "//*[starts-with(text(), '4/0')]")), deadline)
        if verification_code_element is None:
            logger.error("❌ 未能在页面上找到凭证元素。")
            cleanup_resources()
            return False
        
        verification_code = verification_code_element.text
        
        logger.info(f"✅ 成功获取凭证: {verification_code[:15]}...")
        process.stdin.write(verification_code + '\n')
        process.stdin.flush()
        process.stdin.close()

        
        # 等待gcloud进程结束
        process.wait(timeout=max(0.1, deadline - time.time()))

        if process.returncode != 0:
            stderr_thread.join(timeout=2) # 确保在报告前已捕获所有错误输出
            
            # 关键修复：过滤掉误导性的初始提示信息，只显示真正的错误
            error_lines = []
            initial_prompt_found = False
            for line in gcloud_stderr_lines:
                if "Go to the following link" in line:
                    initial_prompt_found = True
                if initial_prompt_found and "https://accounts.google.com/o/oauth2/auth" in line:
                    continue # 跳过URL行
                if initial_prompt_found and not line.strip().startswith("https://"):
                     error_lines.append(line)

            error_details = "".join(error_lines).strip()

            logger.error(f"❌ 认证失败。gcloud返回了错误码: {process.returncode}")
            if error_details:
                logger.error(f"gcloud 错误详情:\n---\n{error_details}\n---")
            else:
                logger.error("gcloud 未提供额外的错误详情。")
            cleanup_resources()
            return False

        logger.info("✅ 全自动认证成功！")
        return True

    except NoSuchWindowException:
        logger.error("❌ 浏览器窗口被意外关闭，认证流程中断。")
        cleanup_resources()
        return False
    except TimeoutError as e:
        logger.error(f"❌ 自动化操作超时: {e}")
        cleanup_resources()
        return False
    except Exception as e:
        logger.critical(f"❌ 认证过程中发生未知严重错误: {e}", exc_info=True)
        cleanup_resources()
        return False
    finally:
        cleanup_resources()