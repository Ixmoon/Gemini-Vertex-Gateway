# file: auto_login.py

import sys
import os
import subprocess
import threading
import time
import signal

try:
    import pyperclip
    import undetected_chromedriver as uc
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except ImportError:
    print("❌ 错误: 缺少必要的Selenium/pyperclip库。", file=sys.stderr)
    print("请运行: pip install selenium undetected-chromedriver pyperclip", file=sys.stderr)
    sys.exit(1)

def perform_login_automation(account_email, password, gcloud_path, temp_dir):
    """
    在一个隔离的环境中，为指定账号执行gcloud登录的浏览器自动化部分。
    成功时返回True，失败时返回False。
    """
    thread_local_env = os.environ.copy()
    thread_local_env['CLOUDSDK_CONFIG'] = temp_dir

    process = None
    driver = None
    stderr_thread = None

    def cleanup_resources():
        """手动、权威地终止所有子进程（浏览器、驱动、gcloud），绕过库中不可靠的quit方法。"""
        nonlocal driver, process, stderr_thread
        
        # 步骤1: 手动终止浏览器和驱动进程
        if driver:
            print(f"[{account_email}] > 正在手动终止浏览器和驱动进程...")
            pids_to_kill = []
            if driver.browser_pid:
                pids_to_kill.append(driver.browser_pid)
            if driver.service and hasattr(driver.service, 'process'):
                pids_to_kill.append(driver.service.process.pid)

            for pid in pids_to_kill:
                try:
                    if sys.platform == "win32":
                        subprocess.run(
                            ['taskkill', '/F', '/PID', str(pid)],
                            check=False, capture_output=True
                        )
                    else:
                        os.kill(pid, signal.SIGKILL)
                except Exception:
                    pass
            
            print(f"[{account_email}] > 浏览器和驱动进程已终止。")
            driver = None

        # 步骤2: 强制终止gcloud进程树
        if process and process.poll() is None:
            print(f"[{account_email}] > 正在强制终止gcloud进程树 (PID: {process.pid})...")
            try:
                if sys.platform == "win32":
                    subprocess.run(
                        ['taskkill', '/F', '/T', '/PID', str(process.pid)],
                        check=True,
                        capture_output=True,
                        text=True
                    )
                else:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                
                print(f"[{account_email}] > gcloud进程树已成功终止。")
            except (subprocess.CalledProcessError, ProcessLookupError):
                pass
            except Exception as e:
                print(f"[{account_email}] > 终止gcloud子进程时发生未知错误: {e}", file=sys.stderr)
            finally:
                process = None
        
        if stderr_thread and stderr_thread.is_alive():
            stderr_thread.join(timeout=2)

    try:
        print(f"[{account_email}] --- 开始自动化认证 ---")
        
        auth_url_event = threading.Event()
        auth_url_container = {}

        def capture_gcloud_stderr(pipe):
            """读取gcloud的stderr流，查找认证URL。"""
            try:
                for line in iter(pipe.readline, ''):
                    stripped_line = line.strip()
                    if stripped_line.startswith("https://accounts.google.com/o/oauth2/auth"):
                        auth_url_container['url'] = stripped_line
                        auth_url_event.set()
                        break
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

        stderr_thread = threading.Thread(target=capture_gcloud_stderr, args=(process.stderr,))
        stderr_thread.daemon = True
        stderr_thread.start()

        print("ℹ️  正在等待gcloud生成认证链接...")
        if not auth_url_event.wait(timeout=20.0):
            print("\n⚠️ 未能在20秒内捕获认证链接。", file=sys.stderr)
            cleanup_resources()
            return False

        print(f"\n✅ 成功捕获认证链接，正在启动浏览器并自动登录...")
        
        options = webdriver.ChromeOptions()
        options.add_argument('--incognito')
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--ignore-certificate-errors')
        options.add_argument('--allow-insecure-localhost')

        patcher = uc.Patcher()
        patched_driver_path = patcher.executable_path if os.path.exists(patcher.executable_path) else patcher.auto()
        
        driver = uc.Chrome(
            driver_executable_path=patched_driver_path,
            options=options
        )
        
        driver.get(auth_url_container['url'])
        wait = WebDriverWait(driver, 20)

        email_input = wait.until(EC.visibility_of_element_located((By.XPATH, '//*[@id="identifierId"]')))
        email_input.send_keys(account_email)
        driver.find_element(By.ID, 'identifierNext').click()

        password_input = wait.until(EC.visibility_of_element_located((By.XPATH, '//*[@id="password"]/div[1]/div/div[1]/input')))
        password_input.send_keys(password)
        driver.find_element(By.ID, 'passwordNext').click()

        try:
            wait = WebDriverWait(driver, 5)
            result = wait.until(
                EC.any_of(
                    EC.visibility_of_element_located((By.XPATH, '//*[contains(text(), "Wrong password") or contains(text(), "密码不正确")]')),
                    EC.title_contains("2-Step Verification"),
                    EC.title_contains("两步验证")
                )
            )
            if hasattr(result, 'tag_name'):
                print(f"[{account_email}] ❌ 错误：登录失败，密码不正确。", file=sys.stderr)
            else:
                print(f"[{account_email}] ❌ 错误：此账号需要两步验证（2FA），无法自动处理。", file=sys.stderr)
            
            cleanup_resources()
            return False
            
        except Exception:
            pass

        continue_button = wait.until(EC.element_to_be_clickable((By.XPATH, '//*[text()="继续" or text()="Continue"]')))
        continue_button.click()

        allow_button = wait.until(EC.element_to_be_clickable((By.XPATH, '//*[text()="允许" or text()="Allow"]')))
        allow_button.click()

        copy_button = wait.until(EC.element_to_be_clickable((By.XPATH, '//*[text()="Copy" or text()="复制"]')))
        copy_button.click()
        
        verification_code = pyperclip.paste()

        process.stdin.write(verification_code + '\n')
        process.stdin.flush()
        process.stdin.close()

        stdout, stderr = process.communicate(timeout=60)
        
        if process.returncode != 0:
            print("❌ 认证失败。gcloud返回了错误。", file=sys.stderr)
            cleanup_resources()
            return False

        print(f"✅ [{account_email}] 全自动认证成功！")
        return True

    except Exception as e:
        print(f"❌ 认证过程中发生未知错误: {e}", file=sys.stderr)
        cleanup_resources()
        return False
    finally:
        cleanup_resources()