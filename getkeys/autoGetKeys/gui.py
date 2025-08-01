# file: autogetkeys/gui.py
import tkinter
import customtkinter
from tkinter import filedialog, messagebox
import threading
import queue
import multiprocessing
import sys
import os
import json
import time
import logging
import math
import signal
import subprocess
import concurrent.futures
from datetime import datetime
import re

# 确保可以从父目录导入 getkeys
try:
    from getkeys import start_processing
    from constants import (STATUS_PENDING, STATUS_PROCESSING, STATUS_SUCCESS,
                           STATUS_FAILURE, STATUS_PARTIAL_SUCCESS, STATUS_COLORS,
                           GENERAL_ERROR_ACCOUNT, DependenciesMissingError, GCloudNotInstalledError)
except ImportError:
    # 如果直接运行，可能需要调整路径
    sys.path.append(os.path.join(os.path.dirname(__file__), '..'))
    from getkeys import start_processing
    from constants import (STATUS_PENDING, STATUS_PROCESSING, STATUS_SUCCESS,
                           STATUS_FAILURE, STATUS_PARTIAL_SUCCESS, STATUS_COLORS,
                           GENERAL_ERROR_ACCOUNT, DependenciesMissingError, GCloudNotInstalledError)

# --- 全局常量 ---
CONFIG_FILE = "gui_config.json"
APP_NAME = "Gemini API 密钥获取工具"

# --- 自定义组件 ---
class AccountRow(customtkinter.CTkFrame):
    """显示单个账户状态的UI组件"""
    def __init__(self, master, account_email, on_double_click):
        super().__init__(master, fg_color="transparent")
        self.account_email = account_email

        self.status_light = customtkinter.CTkFrame(self, width=10, height=10, corner_radius=5, fg_color=STATUS_COLORS[STATUS_PENDING])
        self.status_light.pack(side="left", padx=(5, 10), pady=5)

        self.email_label = customtkinter.CTkLabel(self, text=account_email, anchor="w")
        self.email_label.pack(side="left", fill="x", expand=True)

        self.error_label = customtkinter.CTkLabel(self, text="", anchor="w", text_color=STATUS_COLORS[STATUS_FAILURE])
        self.error_label.pack(side="left", padx=(5, 5))

        # 绑定双击事件
        self.bind("<Double-1>", lambda _: on_double_click(self.account_email))
        self.email_label.bind("<Double-1>", lambda _: on_double_click(self.account_email))
        self.status_light.bind("<Double-1>", lambda _: on_double_click(self.account_email))
        self.error_label.bind("<Double-1>", lambda _: on_double_click(self.account_email))

    def set_status(self, status, error_message=None, key_count=0):
        # 确定灯的颜色
        light_status = status
        if '失败' in status:  # "登录失败" 也算失败
            light_status = STATUS_FAILURE
        color = STATUS_COLORS.get(light_status, STATUS_COLORS[STATUS_FAILURE])
        self.status_light.configure(fg_color=color)

        # 根据状态构建显示文本
        display_text = ""
        text_color = STATUS_COLORS[STATUS_FAILURE] # 默认是失败的红色

        if status == STATUS_SUCCESS:
            display_text = f"获取 {key_count} 个密钥"
            text_color = STATUS_COLORS[STATUS_SUCCESS]
        elif status == STATUS_PARTIAL_SUCCESS:
            # 对于部分成功，总是显示获取的密钥数和原因
            error_line = error_message.splitlines()[0] if error_message else "部分项目失败"
            display_text = f"获取 {key_count} 个, {error_line}"
            text_color = STATUS_COLORS[STATUS_PARTIAL_SUCCESS] # 使用蓝色表示部分成功
        elif error_message:
            display_text = f"{error_message.splitlines()[0]}"
            # 对于其他失败状态，保持红色
        
        self.error_label.configure(text=display_text, text_color=text_color)

class SettingsWindow(customtkinter.CTkToplevel):
    """设置窗口"""
    def __init__(self, master, current_configs, on_save):
        super().__init__(master)
        self.grab_set() # 设置为模态窗口，强制用户交互
        self.title("设置")
        self.geometry("600x420") # 增加高度以容纳新选项
        self.on_save = on_save

        # 根本性修复：使用一个主框架来承载所有组件，以确保主题一致性
        # CTkToplevel本身可能不遵循主题，但其内的CTkFrame会
        self.main_frame = customtkinter.CTkFrame(self)
        self.main_frame.pack(fill="both", expand=True, padx=10, pady=10)
        
        self.main_frame.grid_columnconfigure(1, weight=1)

        # 浏览器路径 (master更改为 self.main_frame)
        self.browser_label = customtkinter.CTkLabel(self.main_frame, text="浏览器可执行文件路径:")
        self.browser_label.grid(row=0, column=0, padx=10, pady=10, sticky="w")
        self.browser_path_var = tkinter.StringVar(value=current_configs.get("browser_path", ""))
        self.browser_entry = customtkinter.CTkEntry(self.main_frame, textvariable=self.browser_path_var)
        self.browser_entry.grid(row=0, column=1, padx=10, pady=10, sticky="ew")
        self.browser_button = customtkinter.CTkButton(self.main_frame, text="...", width=30, command=self.browse_browser)
        self.browser_button.grid(row=0, column=2, padx=(0, 10), pady=10)

        # 密钥保存路径 (master更改为 self.main_frame)
        self.save_label = customtkinter.CTkLabel(self.main_frame, text="密钥默认保存路径:")
        self.save_label.grid(row=1, column=0, padx=10, pady=10, sticky="w")
        self.save_path_var = tkinter.StringVar(value=current_configs.get("save_path", ""))
        self.save_entry = customtkinter.CTkEntry(self.main_frame, textvariable=self.save_path_var)
        self.save_entry.grid(row=1, column=1, padx=10, pady=10, sticky="ew")
        self.save_button = customtkinter.CTkButton(self.main_frame, text="...", width=30, command=self.browse_save_path)
        self.save_button.grid(row=1, column=2, padx=(0, 10), pady=10)

        # 并发数 (master更改为 self.main_frame)
        self.workers_label = customtkinter.CTkLabel(self.main_frame, text="最大并发线程数:")
        self.workers_label.grid(row=2, column=0, padx=10, pady=10, sticky="w")
        self.workers_var = tkinter.StringVar(value=current_configs.get("max_workers", "4"))
        self.workers_entry = customtkinter.CTkEntry(self.main_frame, textvariable=self.workers_var)
        self.workers_entry.grid(row=2, column=1, padx=10, pady=10, sticky="ew")

        # 目标密钥数
        self.keys_label = customtkinter.CTkLabel(self.main_frame, text="目标密钥数 (0为不限):")
        self.keys_label.grid(row=3, column=0, padx=10, pady=10, sticky="w")
        self.keys_var = tkinter.StringVar(value=current_configs.get("desired_keys", "0"))
        self.keys_entry = customtkinter.CTkEntry(self.main_frame, textvariable=self.keys_var)
        self.keys_entry.grid(row=3, column=1, padx=10, pady=10, sticky="ew")

        # 新增：浏览器窗口大小
        self.size_label = customtkinter.CTkLabel(self.main_frame, text="浏览器窗口大小 (宽x高):")
        self.size_label.grid(row=4, column=0, padx=10, pady=10, sticky="w")
        self.size_var = tkinter.StringVar(value=current_configs.get("window_size", "500x700"))
        self.size_entry = customtkinter.CTkEntry(self.main_frame, textvariable=self.size_var)
        self.size_entry.grid(row=4, column=1, padx=10, pady=10, sticky="ew")

        # 新增：浏览器窗口位置
        self.pos_label = customtkinter.CTkLabel(self.main_frame, text="浏览器窗口位置 (X,Y):")
        self.pos_label.grid(row=5, column=0, padx=10, pady=10, sticky="w")
        self.pos_var = tkinter.StringVar(value=current_configs.get("window_position", ""))
        self.pos_entry = customtkinter.CTkEntry(self.main_frame, placeholder_text="留空则自动平铺", textvariable=self.pos_var)
        self.pos_entry.grid(row=5, column=1, padx=10, pady=10, sticky="ew")

        # 保存按钮 (master更改为 self.main_frame)
        self.save_btn = customtkinter.CTkButton(self.main_frame, text="保存并关闭", command=self.save_and_close)
        self.save_btn.grid(row=6, column=0, columnspan=3, padx=10, pady=(20, 10))

    def browse_browser(self):
        path = filedialog.askopenfilename(title="选择浏览器可执行文件")
        if path:
            self.browser_path_var.set(path)

    def browse_save_path(self):
        path = filedialog.asksaveasfilename(title="选择密钥保存位置", defaultextension=".txt", filetypes=[("Text files", "*.txt")])
        if path:
            self.save_path_var.set(path)

    def save_and_close(self):
        try:
            workers = int(self.workers_var.get())
            if workers <= 0:
                raise ValueError
            desired_keys = int(self.keys_var.get() or "0")
            if desired_keys < 0:
                raise ValueError
        except ValueError:
            messagebox.showerror("无效输入", "并发线程数必须是正整数, 目标密钥数必须是非负整数。", parent=self)
            return

        new_configs = {
            "browser_path": self.browser_path_var.get(),
            "save_path": self.save_path_var.get(),
            "max_workers": self.workers_var.get(),
            "desired_keys": self.keys_var.get() or "0",
            "window_size": self.size_var.get(),
            "window_position": self.pos_var.get()
        }
        self.on_save(new_configs)
        self.destroy()

# --- 主应用 ---
class App(customtkinter.CTk):
    def __init__(self):
        super().__init__()
        self.title(APP_NAME)
        self.geometry("800x600")
        customtkinter.set_appearance_mode("Dark")
        customtkinter.set_default_color_theme("dark-blue")

        # --- 数据状态 ---
        self.accounts_data = {}  # {'email': {'password': '...', 'status': '...', 'log': '', 'widget': AccountRow}}
        self.configs = {}
        self.gui_queue = None # Will be created by the Manager on start
        self.all_keys = set()
        self.full_log = ""
        self.is_running = False
        self.processing_thread = None
        self.stop_event = threading.Event()
        self.executor = None
        self.manager = None # Process Manager
        self.start_time = 0
        self.log_windows = {} # 追踪打开的日志窗口
        self.filter_vars = {} # 用于存储筛选复选框的状态
        # --- Performance Optimization: Cached Stats ---
        self._success_count = 0
        self._partial_count = 0
        self._failure_count = 0
        self.worker_pids = {} # {email: pid}
        self.logger = logging.getLogger(__name__)
        self.last_calculated_eta = 0
        self.time_of_last_eta_update = 0

        # --- UI布局 ---
        self._create_widgets()
        self._load_configs()
        self.after(100, self._process_gui_queue)
        # --- 绑定健壮的关闭协议 ---
        self.protocol("WM_DELETE_WINDOW", self.on_closing)

    def _create_widgets(self):
        self.grid_columnconfigure(0, weight=1)
        self.grid_columnconfigure(1, weight=0)  # 为右侧按钮添加新列
        self.grid_rowconfigure(2, weight=1) # 中间行（列表）将占据大部分空间

        # --- 顶部控制栏 ---
        self.top_frame = customtkinter.CTkFrame(self, height=50)
        self.top_frame.grid(row=0, column=0, padx=(10, 0), pady=(10, 5), sticky="ew")

        self.load_button = customtkinter.CTkButton(self.top_frame, text="加载账户文件", command=self.load_accounts_file)
        self.load_button.pack(side="left", padx=5, pady=10)
        
        self.start_button = customtkinter.CTkButton(self.top_frame, text="开始处理", command=self.start_processing_thread, state="disabled")
        self.start_button.pack(side="left", padx=5, pady=10)
        
        self.show_keys_button = customtkinter.CTkButton(self.top_frame, text="显示密钥", command=self.show_keys_window, state="disabled")
        self.show_keys_button.pack(side="left", padx=5, pady=10)

        self.stop_button = customtkinter.CTkButton(self.top_frame, text="强制停止", command=self.stop_processing, state="disabled", fg_color="#D35400", hover_color="#A93226")
        self.stop_button.pack(side="left", padx=5, pady=10)

        # --- 筛选和导出 ---
        self.filter_frame = customtkinter.CTkFrame(self)
        self.filter_frame.grid(row=1, column=0, padx=(10, 0), pady=5, sticky="ew")

        self.filter_label = customtkinter.CTkLabel(self.filter_frame, text="筛选:")
        self.filter_label.pack(side="left", padx=(10, 5), pady=5)

        filter_options = {
            "成功": STATUS_SUCCESS,
            "部分成功": STATUS_PARTIAL_SUCCESS,
            "失败": STATUS_FAILURE,
            "剩余": "remaining" # 特殊值，代表 PENDING 和 PROCESSING
        }
        for text, key in filter_options.items():
            var = tkinter.BooleanVar(value=True)
            cb = customtkinter.CTkCheckBox(self.filter_frame, text=text, variable=var, command=self._apply_filters)
            cb.pack(side="left", padx=5, pady=5)
            self.filter_vars[key] = var
        
        # --- 右侧对齐按钮 ---
        self.settings_button = customtkinter.CTkButton(self, text="设置", command=self.open_settings_window)
        self.settings_button.grid(row=0, column=1, padx=(5, 10), pady=(10, 5), sticky="ew")

        self.export_button = customtkinter.CTkButton(self, text="导出筛选账号", command=self.export_filtered_accounts)
        self.export_button.grid(row=1, column=1, padx=(5, 10), pady=5, sticky="ew")

        # --- 中部账户列表 ---
        self.scrollable_frame = customtkinter.CTkScrollableFrame(self, label_text="账户列表")
        self.scrollable_frame.grid(row=2, column=0, columnspan=2, padx=10, pady=0, sticky="nsew")

        # --- 底部状态栏 ---
        self.status_bar = customtkinter.CTkFrame(self, height=30)
        self.status_bar.grid(row=3, column=0, columnspan=2, padx=10, pady=10, sticky="ew")
        self.status_bar.grid_columnconfigure(0, weight=1)

        self.progress_bar = customtkinter.CTkProgressBar(self.status_bar)
        self.progress_bar.set(0)
        self.progress_bar.grid(row=0, column=0, padx=10, pady=5, sticky="ew")

        self.status_label = customtkinter.CTkLabel(self.status_bar, text="总数: 0 | 成功: 0 | 失败: 0 | 密钥: 0 | 运行时间: 00:00:00 | 剩余: --:--:--")
        self.status_label.grid(row=0, column=1, padx=10, pady=5, sticky="e")

    # --- 筛选与导出 ---
    def _apply_filters(self):
        """根据复选框的状态显示或隐藏账户行。"""
        for email, data in self.accounts_data.items():
            widget = data['widget']
            status = data['status']
            
            show = False
            if self.filter_vars[STATUS_SUCCESS].get() and status == STATUS_SUCCESS:
                show = True
            elif self.filter_vars[STATUS_PARTIAL_SUCCESS].get() and status == STATUS_PARTIAL_SUCCESS:
                show = True
            elif self.filter_vars[STATUS_FAILURE].get() and '失败' in status: # 包括 '登录失败'
                show = True
            elif self.filter_vars["remaining"].get() and status in [STATUS_PENDING, STATUS_PROCESSING]:
                show = True

            if show:
                widget.pack(fill="x", expand=True, padx=5, pady=2)
            else:
                widget.pack_forget()

    def export_filtered_accounts(self):
        """导出当前筛选出的账户。"""
        filtered_accounts = []
        for email, data in self.accounts_data.items():
            widget = data['widget']
            # 如果组件当前是可见的，就表示它通过了筛选
            if widget.winfo_ismapped():
                filtered_accounts.append(f"{email},{data['password']}")
        
        if not filtered_accounts:
            messagebox.showwarning("无内容可导出", "没有符合当前筛选条件的账号可供导出。")
            return

        filepath = filedialog.asksaveasfilename(
            title="导出筛选后的账号",
            defaultextension=".txt",
            filetypes=[("Text files", "*.txt"), ("All files", "*.*")],
            initialfile="filtered_accounts.txt"
        )
        if not filepath:
            return

        try:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write("\n".join(filtered_accounts))
            messagebox.showinfo("导出成功", f"已成功导出 {len(filtered_accounts)} 个账号到:\n{filepath}")
        except Exception as e:
            messagebox.showerror("导出失败", f"无法写入文件: {e}")


    # --- 核心逻辑方法 ---
    def load_accounts_file(self):
        if self.is_running: return
        filepath = filedialog.askopenfilename(title="选择账户文件", filetypes=[("Text files", "*.txt"), ("All files", "*.*")])
        if not filepath: return

        # 清理旧数据
        for widget in self.scrollable_frame.winfo_children():
            widget.destroy()
        self.accounts_data = {}
        self._success_count = 0
        self._partial_count = 0
        self._failure_count = 0
        self.all_keys.clear()
        self.progress_bar.set(0)
        self.last_calculated_eta = 0
        self.time_of_last_eta_update = 0


        try:
            with open(filepath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    parts = re.split(r'[,\s|]+', line)
                    if len(parts) >= 2 and parts[0] and parts[1]:
                        email, password = parts[0].strip(), parts[1].strip()
                        if email not in self.accounts_data:
                            row = AccountRow(self.scrollable_frame, email, self.show_log_window)
                            row.pack(fill="x", expand=True, padx=5, pady=2)
                            self.accounts_data[email] = {"password": password, "status": STATUS_PENDING, "log": "", "widget": row}
        except Exception as e:
            messagebox.showerror("文件读取错误", f"加载文件失败: {e}")
            return
        
        self.start_button.configure(state="normal" if self.accounts_data else "disabled")
        self._update_status_bar()

    def start_processing_thread(self):
        if self.is_running or not self.accounts_data: return
        
        # 准备待处理列表，只包括非成功的账号
        accounts_to_process = []
        # --- Performance Optimization: Reset stats before run ---
        self._success_count = 0
        self._partial_count = 0
        self._failure_count = 0
        self.last_calculated_eta = 0
        self.time_of_last_eta_update = 0
        
        for email, data in self.accounts_data.items():
            # Always recount successful ones for the progress bar logic
            if data["status"] == STATUS_SUCCESS:
                self._success_count += 1
            else:
                accounts_to_process.append((email, data['password']))
                # 重置这些账号的状态以便重试
                data["status"] = STATUS_PENDING
                data["log"] = "" # 可选：清空旧日志
                data["widget"].set_status(STATUS_PENDING, error_message=None)

        if not accounts_to_process:
            messagebox.showinfo("无需操作", "所有账号均已成功处理。")
            return
            
        self.is_running = True
        self.stop_event.clear() # 重置停止事件
        # 注意：不清空 all_keys，以便累积
        self.worker_pids.clear()
        self.full_log += f"\n\n--- 新任务轮次开始于: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ---\n\n"
        self.start_time = time.time()
        
        self.start_button.configure(state="disabled")
        self.load_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        # 如果已有密钥，保持按钮可用
        if not self.all_keys:
            self.show_keys_button.configure(state="disabled")

        max_workers = int(self.configs.get("max_workers", 4))
        desired_keys = int(self.configs.get("desired_keys", 0))

        # --- Correct IPC Setup ---
        # The Manager creates shared objects that can be passed to child processes.
        self.manager = multiprocessing.Manager()
        self.gui_queue = self.manager.Queue()
        self.executor = concurrent.futures.ProcessPoolExecutor(max_workers=max_workers)

        self.processing_thread = threading.Thread(
            target=self._thread_target_wrapper,
            args=(
                self.executor,
                accounts_to_process, self.gui_queue, self.stop_event,
                self.configs, # 传递整个配置字典
            ),
            daemon=True
        )
        self.processing_thread.start()
        self._update_status_bar()

    def stop_processing(self, force_after_timeout=True):
        if not self.is_running: return

        self.stop_button.configure(state="disabled", text="停止中...")
        
        if not self.stop_event.is_set():
            self.stop_event.set()
            
        if not force_after_timeout:
            return

        # --- Fix race condition by copying PIDs immediately ---
        pids_to_kill = list(self.worker_pids.values())
        self.worker_pids.clear() # Prevent the main thread from using a stale list

        # --- Two-phase termination: Graceful shutdown then Force kill ---
        def killer(pids):
            # Phase 1: Graceful shutdown
            if self.executor:
                self.executor.shutdown(wait=False)  # Send SIGTERM to children

            # Give processes a moment to shut down gracefully
            if self.processing_thread:
                self.processing_thread.join(timeout=3.0)

            # Phase 2: Recursively collect all child PIDs for a complete kill list
            def get_child_pids(parent_pid):
                """Recursively finds all child PIDs of a given parent PID."""
                children = set()
                try:
                    if sys.platform == "win32":
                        # Note: The 'where' clause must use single quotes in the shell,
                        # but here we pass a list of args, so no inner quotes are needed.
                        command = [
                            'wmic', 'process', 'where', f'ParentProcessId={parent_pid}',
                            'get', 'ProcessId'
                        ]
                        result = subprocess.run(command, capture_output=True, text=True, check=True)
                        # WMIC output has a header ("ProcessId") and trailing whitespace.
                        output_pids = result.stdout.strip().split('\n')[1:]
                        child_pids = {int(p.strip()) for p in output_pids if p.strip().isdigit()}
                        
                        for child_pid in child_pids:
                            children.add(child_pid)
                            children.update(get_child_pids(child_pid))
                except (subprocess.CalledProcessError, FileNotFoundError):
                    # WMIC might not be found or return an error if no children exist.
                    pass
                return children

            if pids:
                self.logger.info(f"正在为 {len(pids)} 个工作进程收集完整的进程树...")
                all_pids_to_kill = set(pids)
                for pid in pids:
                    child_pids = get_child_pids(pid)
                    all_pids_to_kill.update(child_pids)
                
                self.logger.info(f"共收集到 {len(all_pids_to_kill)} 个相关进程。正在执行精确终止...")
                for pid_to_kill in all_pids_to_kill:
                    try:
                        if sys.platform == "win32":
                            # No /T needed as we are killing each process individually.
                            subprocess.run(['taskkill', '/F', '/PID', str(pid_to_kill)], check=False, capture_output=True)
                        else:
                            os.kill(int(pid_to_kill), signal.SIGKILL)
                    except (ProcessLookupError, PermissionError, OSError):
                        pass # Process might already be gone

            # Ensure the main executor is fully shut down
            if self.executor:
                self.executor.shutdown(wait=True)

        threading.Thread(target=killer, args=(pids_to_kill,), daemon=True).start()

    def _thread_target_wrapper(self, executor, accounts_list, gui_queue, stop_event, configs):
        """包装 start_processing 以捕获启动异常，并管理executor的生命周期。"""
        try:
            start_processing(executor, accounts_list, gui_queue, stop_event, configs)
        except (DependenciesMissingError, GCloudNotInstalledError) as e:
            # 进程池中的异常需要通过队列传递回主线程
            self.gui_queue.put({"account": GENERAL_ERROR_ACCOUNT, "status": STATUS_FAILURE, "reason": str(e)})
        except Exception as e:
            error_msg = f"后台任务启动时发生未知错误: {e}"
            self.gui_queue.put({"account": GENERAL_ERROR_ACCOUNT, "status": STATUS_FAILURE, "reason": error_msg})

    def _process_gui_queue(self):
        if not self.gui_queue: # Queue is not created until processing starts
            self.after(100, self._process_gui_queue)
            return
            
        try:
            while not self.gui_queue.empty():
                result = self.gui_queue.get_nowait()
                
                # 处理来自后端的日志消息
                if isinstance(result, logging.LogRecord):
                    log_message = result.getMessage() + "\n"
                    self.full_log += log_message
                    account_email = getattr(result, 'account', None)
                    if account_email and account_email in self.accounts_data:
                        self.accounts_data[account_email]['log'] += log_message
                        if account_email in self.log_windows:
                            win, textbox = self.log_windows[account_email]
                            if win.winfo_exists():
                                textbox.configure(state="normal")
                                textbox.insert("end", log_message)
                                textbox.see("end")
                                textbox.configure(state="disabled")
                    continue
                
                # 处理启动时发生的全局错误
                if result.get("account") == GENERAL_ERROR_ACCOUNT:
                    messagebox.showerror("启动失败", result.get("reason", "发生未知错误"))
                    if self.is_running:
                        self._task_finished()
                    continue

                # 收集PID
                if result.get("pid"):
                    self.worker_pids[result.get("account")] = result.get("pid")

                # 处理账户结果
                email = result.get("account")
                if email and email in self.accounts_data:
                    self.accounts_data[email].update(result)
                    status = result.get("status", STATUS_FAILURE)
                    error_message = result.get("reason")
                    key_count = len(result.get("keys", []))
                    
                    # --- Performance Optimization: Incremental stat update ---
                    if status == STATUS_SUCCESS:
                        self._success_count += 1
                    elif status == STATUS_PARTIAL_SUCCESS:
                        self._partial_count += 1
                    elif '失败' in status:
                        self._failure_count += 1
                    
                    # Recalibrate ETA upon task completion
                    elapsed = time.time() - self.start_time
                    processed_count = self._success_count + self._partial_count + self._failure_count
                    if processed_count > 0:
                        avg_time_per_task = elapsed / processed_count
                        remaining_tasks = len(self.accounts_data) - processed_count
                        self.last_calculated_eta = remaining_tasks * avg_time_per_task
                        self.time_of_last_eta_update = time.time()

                    self.accounts_data[email]["widget"].set_status(
                        status, error_message=error_message, key_count=key_count
                    )
                    
                    if result.get("keys"):
                        self.all_keys.update(result["keys"])
                        self.show_keys_button.configure(state="normal")
                    
                    # If goal is achieved, trigger stop for all processes
                    if result.get("goal_achieved"):
                        self.logger.info("已达到目标密钥数，正在触发全局停止...")
                        self.stop_processing(force_after_timeout=False) # Just set event, no killer thread

                    self._apply_filters() # 实时更新筛选视图
        except queue.Empty:
            pass
        finally:
            # 任务状态检查与UI更新
            if self.is_running:
                is_thread_finished = not self.processing_thread or not self.processing_thread.is_alive()
                
                # The task is truly finished only when the thread has stopped AND the queue is empty.
                if is_thread_finished and self.gui_queue.empty():
                    self._task_finished()
                else:
                    # While running, or if there are still messages, just update the status bar.
                    self._update_status_bar()

            self.after(100, self._process_gui_queue)

    def _task_finished(self):
        was_stopped_by_user = self.stop_event.is_set()
        self.is_running = False
        self.worker_pids.clear()
        self.start_button.configure(state="normal")
        self.load_button.configure(state="normal")
        self.stop_button.configure(state="disabled", text="强制停止")

        self._update_status_bar() # Ensure final stats and progress are displayed
        
        # 无论如何都保存日志和密钥
        log_dir = os.path.abspath(os.path.join(sys.path[0], "log"))
        os.makedirs(log_dir, exist_ok=True)
        log_filename = os.path.join(log_dir, f"log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt")
        try:
            with open(log_filename, "w", encoding="utf-8") as f:
                f.write(self.full_log)
            log_msg = f"完整日志已保存到: {log_filename}"
        except Exception as e:
            log_msg = f"保存日志失败: {e}"
    
        keys_save_msg = ""
        if self.all_keys:
            save_path = self.configs.get("save_path")
            try:
                keys_filename = save_path if save_path else os.path.join(log_dir, f"keys_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt")
                with open(keys_filename, "w", encoding="utf-8") as f:
                    f.write("\n".join(self.all_keys))
                keys_save_msg = f"密钥已保存到: {os.path.abspath(keys_filename)}"
            except Exception as e:
                keys_save_msg = f"保存密钥文件失败: {e}"
    
        # 根据任务结束的原因显示不同的消息
        s_count, p_count, f_count, k_count = self._get_stats()
        if was_stopped_by_user:
            messagebox.showinfo("任务已停止",
                                f"任务已被用户手动停止。\n\n"
                                f"当前进度:\n"
                                f" - 成功: {s_count}, 部分成功: {p_count}, 失败: {f_count}\n"
                                f" - 共获得密钥: {k_count}\n\n"
                                f"{keys_save_msg}\n"
                                f"{log_msg}")
        else:
            # 正常的任务完成报告
            total_time = time.time() - self.start_time
            summary_lines = [f"成功: {s_count}"]
            if p_count > 0:
                summary_lines.append(f"部分成功: {p_count}")
            summary_lines.append(f"失败: {f_count}")
            summary = "\n".join(summary_lines)
            messagebox.showinfo("任务完成",
                                f"所有账号处理完毕！\n\n"
                                f"{summary}\n"
                                f"共获得密钥: {k_count}\n"
                                f"总耗时: {time.strftime('%H:%M:%S', time.gmtime(total_time))}\n\n"
                                f"{keys_save_msg}\n"
                                f"{log_msg}")

    def _get_stats(self):
        # --- Performance Optimization: Use cached stats ---
        return self._success_count, self._partial_count, self._failure_count, len(self.all_keys)

    def _update_status_bar(self):
        s_count, p_count, f_count, k_count = self._get_stats()
        total_count = len(self.accounts_data)
        processed_count = s_count + p_count + f_count

        run_time_str = "00:00:00"
        eta_str = "--:--:--"
        progress = 0
        
        if self.is_running and total_count > 0:
            elapsed = time.time() - self.start_time
            run_time_str = time.strftime('%H:%M:%S', time.gmtime(elapsed))
            
            if total_count > 0:
                progress = processed_count / total_count
                
                # 基于最后一次校准的结果进行平滑倒计时
                if self.time_of_last_eta_update > 0 and processed_count < total_count:
                    time_since_last_update = time.time() - self.time_of_last_eta_update
                    current_eta = self.last_calculated_eta - time_since_last_update
                    if current_eta < 0: current_eta = 0
                    eta_str = time.strftime('%H:%M:%S', time.gmtime(current_eta))
                elif self.is_running and processed_count == 0:
                    eta_str = "正在计算..."
        
        # 任务结束时强制设置为100%
        if not self.is_running and total_count > 0 and processed_count == total_count:
            progress = 1.0
            eta_str = "00:00:00"

        # 更新UI
        self.progress_bar.set(progress)
        self.status_label.configure(text=f"总数: {total_count} | 成功: {s_count} | 部分: {p_count} | 失败: {f_count} | 密钥: {k_count} | 运行时间: {run_time_str} | 剩余: {eta_str}")


    # --- 弹出窗口方法 ---
    def show_keys_window(self):
        if not self.all_keys:
            messagebox.showinfo("无密钥", "当前未获取到任何API密钥。")
            return
            
        win = customtkinter.CTkToplevel(self)
        win.title("已获取的API密钥")
        win.geometry("600x400")
        
        textbox = customtkinter.CTkTextbox(win, font=("Courier New", 12))
        textbox.pack(fill="both", expand=True, padx=10, pady=10)
        textbox.insert("1.0", "\n".join(self.all_keys))
        textbox.configure(state="disabled")

        # --- 按钮容器 ---
        button_frame = customtkinter.CTkFrame(win, fg_color="transparent")
        button_frame.pack(pady=(0, 10))

        def copy_keys():
            self.clipboard_clear()
            self.clipboard_append("\n".join(self.all_keys))
            copy_btn.configure(text="已复制!")
            self.after(2000, lambda: copy_btn.configure(text="全部复制") if copy_btn.winfo_exists() else None)

        def save_keys_as():
            filepath = filedialog.asksaveasfilename(
                title="将密钥保存到...",
                defaultextension=".txt",
                filetypes=[("Text files", "*.txt"), ("All files", "*.*")],
                initialfile=f"keys_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
            )
            if not filepath:
                return
            try:
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write("\n".join(self.all_keys))
                messagebox.showinfo("保存成功", f"密钥已成功保存到:\n{filepath}", parent=win)
            except Exception as e:
                messagebox.showerror("保存失败", f"无法写入文件: {e}", parent=win)

        copy_btn = customtkinter.CTkButton(button_frame, text="全部复制", command=copy_keys)
        copy_btn.pack(side="left", padx=5)
        
        save_as_btn = customtkinter.CTkButton(button_frame, text="另存为...", command=save_keys_as)
        save_as_btn.pack(side="left", padx=5)

    def _on_log_window_close(self, account_email):
        """当日志窗口关闭时，从跟踪字典中移除它。"""
        if account_email in self.log_windows:
            win, _ = self.log_windows.pop(account_email)
            win.destroy()

    def show_log_window(self, account_email):
        """显示或聚焦指定账户的日志窗口，并实现自动更新。"""
        if account_email in self.log_windows:
            # 如果窗口已存在，则聚焦它
            win, _ = self.log_windows[account_email]
            if win.winfo_exists():
                win.focus()
                return

        # 创建新窗口
        win = customtkinter.CTkToplevel(self)
        win.title(f"日志详情 - {account_email}")
        win.geometry("700x500")
        win.grab_set() # 设置为模态窗口，强制用户交互
        
        textbox = customtkinter.CTkTextbox(win, font=("Courier New", 12))
        textbox.pack(fill="both", expand=True, padx=10, pady=10)
        
        # 填充现有日志
        log_content = self.accounts_data[account_email].get('log', '暂无日志。')
        textbox.insert("1.0", log_content)
        textbox.see("end")
        textbox.configure(state="disabled")

        # 保存对窗口和文本框的引用以供实时更新
        self.log_windows[account_email] = (win, textbox)

        # 设置关闭窗口时的回调
        win.protocol("WM_DELETE_WINDOW", lambda: self._on_log_window_close(account_email))

    def open_settings_window(self):
        if hasattr(self, 'settings_win') and self.settings_win.winfo_exists():
            self.settings_win.focus()
        else:
            self.settings_win = SettingsWindow(self, self.configs, self._save_configs)

    # --- 配置管理 ---
    def _load_configs(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r") as f:
                    self.configs = json.load(f)
            except Exception:
                self.configs = {} # 加载失败则使用空配置
    
    def _save_configs(self, new_configs):
        self.configs.update(new_configs)
        try:
            with open(CONFIG_FILE, "w") as f:
                json.dump(self.configs, f, indent=4)
        except Exception as e:
            messagebox.showerror("配置保存失败", f"无法写入配置文件: {e}")

    def on_closing(self):
        """健壮的关闭协议，确保所有后台进程都被终止。"""
        if self.is_running:
            # 如果任务仍在运行，首先发出警告并给出取消的机会
            if not messagebox.askyesno("确认退出", "任务仍在运行中，强制关闭可能会导致数据丢失。您确定要退出吗？"):
                return # 用户取消了退出

        # 1. 发出停止信号
        self.stop_event.set()
        
        # 2. 禁用UI交互
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="disabled")
        self.load_button.configure(state="disabled")
        
        # 3. 给予后台线程一小段反应时间
        self.status_label.configure(text="正在等待后台任务终止...")
        self.update_idletasks() # 强制UI更新
        
        # 4. 强制关闭 Executor
        if self.is_running and self.executor:
            self.executor.shutdown(wait=True) # 在关闭窗口前，确保进程池已关闭
        
        # 5. 关闭 Manager 进程
        if self.manager:
            self.manager.shutdown()

        # 6. 等待后台线程结束
        if self.processing_thread and self.processing_thread.is_alive():
            self.processing_thread.join(timeout=1.0)

        # 7. 销毁窗口
        self.destroy()

if __name__ == "__main__":
    app = App()
    app.mainloop()
