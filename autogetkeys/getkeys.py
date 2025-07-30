# file: getkeys.py

import sys
import os
import subprocess
import random
import tempfile
import shutil
import time
import threading
import getpass

# 尝试导入，如果失败则给出清晰的错误提示
try:
    from google.cloud import resourcemanager, service_usage, api_keys
    from google.oauth2 import credentials as google_credentials
    # 从新模块中导入自动化登录函数
    from auto_login import perform_login_automation
except ImportError:
    print("❌ 错误: 缺少必要的库。", file=sys.stderr)
    print("请运行: pip install google-auth google-cloud-resource-manager google-cloud-service-usage google-cloud-api-keys selenium undetected-chromedriver pyperclip", file=sys.stderr)
    sys.exit(1)

def check_gcloud_installed():
    """检查gcloud CLI是否已安装并返回其路径"""
    gcloud_path = shutil.which('gcloud')
    if not gcloud_path:
        print("❌ 错误: 'gcloud' command-line tool not found.", file=sys.stderr)
        print("请按照官方文档安装 Google Cloud SDK: https://cloud.google.com/sdk/docs/install", file=sys.stderr)
        sys.exit(1)
    return gcloud_path

def process_account(account_email, password, gcloud_path, temp_dir):
    """
    为指定账号执行完整的认证和资源创建流程。
    """
    # --- 步骤 1: 调用独立的自动化登录模块 ---
    login_success = perform_login_automation(account_email, password, gcloud_path, temp_dir)

    if not login_success:
        print(f"[{account_email}] 登录过程失败，终止此账号的操作。", file=sys.stderr)
        return

    # --- 步骤 2: Python部分显式加载凭据 ---
    print(f"[{account_email}] --- 正在从隔离环境中显式加载新凭证 ---")
    
    adc_path = os.path.join(temp_dir, "application_default_credentials.json")
    if not os.path.exists(adc_path):
        print(f"[{account_email}] ❌ 错误：在临时目录 {temp_dir} 中未找到凭证文件。", file=sys.stderr)
        return

    try:
        credentials = google_credentials.Credentials.from_authorized_user_file(adc_path)
        print(f"[{account_email}] ✅ 成功加载了新登录用户的凭证。")

        project_id = f"gemini-key-project-{random.randint(100000, 999999)}"
        print(f"[{account_email}] 将创建新项目: {project_id}")

        # --- 步骤 3: 执行操作 ---
        print(f"[{account_email}] --- 以新凭证开始创建资源 ---")
        
        print(f"[{account_email}] 正在创建项目 '{project_id}'...")
        rm_client = resourcemanager.ProjectsClient(credentials=credentials)
        project_obj = resourcemanager.Project(project_id=project_id, display_name=f"Gemini Key Project")
        rm_client.create_project(project=project_obj).result(timeout=300)
        print(f"[{account_email}] ✅ 项目创建成功。")

        print(f"[{account_email}] 正在启用 Generative Language API... (这可能需要一分钟)")
        su_client = service_usage.ServiceUsageClient(credentials=credentials)
        su_client.enable_service(name=f"projects/{project_id}/services/generativelanguage.googleapis.com").result(timeout=300)
        print(f"[{account_email}] ✅ API 启用成功。")

        print(f"[{account_email}] 正在创建 API 密钥...")
        ak_client = api_keys.ApiKeysClient(credentials=credentials)
        key_request = api_keys.CreateKeyRequest(
            parent=f"projects/{project_id}/locations/global",
            key=api_keys.Key(display_name="Auto-Generated Key")
        )
        api_key_obj = ak_client.create_key(request=key_request).result()
        print(f"[{account_email}] ✅ API 密钥创建成功。")
        
        print("\n" + "="*60)
        print(f"🎉 [{account_email}] 操作成功完成！🎉")
        print(f"   > 账号: {account_email}")
        print(f"   > 新创建的项目ID: {project_id}")
        print(f"   > 您的 API 密钥是: {api_key_obj.key_string}")
        print("="*60)

    except Exception as e:
        print(f"[{account_email}] ❌ 在使用凭证创建云资源时发生严重错误: {e}", file=sys.stderr)
        return

def main():
    gcloud_path = check_gcloud_installed()
    accounts = []

    if len(sys.argv) > 1:
        if len(sys.argv[1:]) % 2 != 0:
            print("❌ 错误: 命令行参数必须是账号和密码成对出现。", file=sys.stderr)
            sys.exit(1)
        for i in range(0, len(sys.argv[1:]), 2):
            accounts.append((sys.argv[i+1], sys.argv[i+2]))
    else:
        print("--- 请逐个输入您的Google账号和密码 ---")
        print("   (输入一个空的账号名来结束)")
        while True:
            try:
                email = input("▶️  账号邮箱: ").strip()
                if not email:
                    break
                password = getpass.getpass("▶️  密码 (输入时不可见): ")
                if not password:
                    print("❌ 密码不能为空。请重新输入该账号。")
                    continue
                accounts.append((email, password))
            except KeyboardInterrupt:
                print("\n操作已取消。")
                sys.exit(0)

    if not accounts:
        print("未输入任何账号。")
        sys.exit(0)

    threads = []
    temp_dirs = []

    try:
        for email, password in accounts:
            temp_dir = tempfile.mkdtemp()
            temp_dirs.append(temp_dir)
            print(f"\n--- 准备为账号 '{email}' 启动独立线程 ---")
            print(f"   > 隔离环境: {temp_dir}")
            
            thread = threading.Thread(
                target=process_account,
                args=(email, password, gcloud_path, temp_dir)
            )
            threads.append(thread)
            thread.start()
            time.sleep(2)

        print("\n--- 所有账号任务已启动，正在等待其完成... ---")
        for thread in threads:
            thread.join()
        print("\n--- 所有任务已执行完毕。 ---")

    except Exception as e:
        print(f"\n--- 脚本主线程因意外错误而中断 ---")
        print(f"❌ 错误详情: {e}", file=sys.stderr)
        if sys.platform == "win32":
            os.system("pause")
        sys.exit(1)
    finally:
        print("\n--- 正在清理所有临时隔离环境... ---")
        for temp_dir in temp_dirs:
            shutil.rmtree(temp_dir, ignore_errors=True)
            print(f"   > 已清理: {temp_dir}")

    if sys.platform == "win32":
        print("\n按任意键退出...")
        os.system("pause")


if __name__ == "__main__":
    main()