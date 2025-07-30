# file: autogetkeys/gui.py
import tkinter
import customtkinter
from tkinter import filedialog, messagebox
import threading
import queue
import sys
import os
import json
import time
import logging
import math
from datetime import datetime

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
APP_NAME = "Gemini API 密钥获取工具 Pro"

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
        self.bind("<Double-1>", lambda event: on_double_click(self.account_email))
        self.email_label.bind("<Double-1>", lambda event: on_double_click(self.account_email))
        self.status_light.bind("<Double-1>", lambda event: on_double_click(self.account_email))
        self.error_label.bind("<Double-1>", lambda event: on_double_click(self.account_email))

    def set_status(self, status, error_message=None, key_count=0):
        # 确定灯的颜色
        light_status = status
        if '失败' in status:  # "登录失败" 也算失败
            light_status = STATUS_FAILURE
        color = STATUS_COLORS.get(light_status, STATUS_COLORS[STATUS_FAILURE])
        self.status_light.configure(fg_color=color)

        # 根据状态构建显示文本
        display_text = ""
        if status == STATUS_SUCCESS:
            display_text = f"获取 {key_count} 个密钥"
            self.error_label.configure(text=display_text, text_color=STATUS_COLORS[STATUS_SUCCESS])
        elif status == STATUS_PARTIAL_SUCCESS:
            error_line = error_message.splitlines()[0] if error_message else ""
            # 对于部分成功，如果只是被用户中断，则使用更清晰的表述
            if "中断" in error_line:
                 display_text = f"获取 {key_count} 个, {error_line}"
            else:
                 display_text = f"获取 {key_count} 个, Err: {error_line}"
            self.error_label.configure(text=display_text, text_color=STATUS_COLORS[STATUS_FAILURE])
        elif error_message:
            display_text = f"{error_message.splitlines()[0]}"
            self.error_label.configure(text=display_text, text_color=STATUS_COLORS[STATUS_FAILURE])
        else:
            self.error_label.configure(text="")

class SettingsWindow(customtkinter.CTkToplevel):
    """设置窗口"""
    def __init__(self, master, current_configs, on_save):
        super().__init__(master)
        self.grab_set() # 设置为模态窗口，强制用户交互
        self.title("设置")
        self.geometry("600x300") # 稍微增加高度以获得更好的边距
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

        # 保存按钮 (master更改为 self.main_frame)
        self.save_btn = customtkinter.CTkButton(self.main_frame, text="保存并关闭", command=self.save_and_close)
        self.save_btn.grid(row=4, column=0, columnspan=3, padx=10, pady=(20, 10))

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
            "desired_keys": self.keys_var.get() or "0"
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
        self.gui_queue = queue.Queue()
        self.all_keys = set()
        self.full_log = ""
        self.is_running = False
        self.processing_thread = None # 对处理线程的引用
        self.stop_event = threading.Event() # 用于停止的事件
        self.start_time = 0
        self.log_windows = {} # 追踪打开的日志窗口
        self.filter_vars = {} # 用于存储筛选复选框的状态

        # --- UI布局 ---
        self._create_widgets()
        self._load_configs()
        self.after(100, self._process_gui_queue)

    def _create_widgets(self):
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(2, weight=1) # 中间行（列表）将占据大部分空间

        # --- 顶部控制栏 ---
        self.top_frame = customtkinter.CTkFrame(self, height=50)
        self.top_frame.grid(row=0, column=0, padx=10, pady=(10, 5), sticky="ew")

        self.load_button = customtkinter.CTkButton(self.top_frame, text="加载账户文件", command=self.load_accounts_file)
        self.load_button.pack(side="left", padx=5, pady=10)
        
        self.start_button = customtkinter.CTkButton(self.top_frame, text="开始处理", command=self.start_processing_thread, state="disabled")
        self.start_button.pack(side="left", padx=5, pady=10)
        
        self.stop_button = customtkinter.CTkButton(self.top_frame, text="强制停止", command=self.stop_processing, state="disabled", fg_color="#D35400")
        self.stop_button.pack(side="left", padx=5, pady=10)

        self.show_keys_button = customtkinter.CTkButton(self.top_frame, text="显示密钥", command=self.show_keys_window, state="disabled")
        self.show_keys_button.pack(side="left", padx=5, pady=10)

        self.settings_button = customtkinter.CTkButton(self.top_frame, text="设置", command=self.open_settings_window)
        self.settings_button.pack(side="right", padx=5, pady=10)

        # --- 筛选和导出 ---
        self.filter_frame = customtkinter.CTkFrame(self)
        self.filter_frame.grid(row=1, column=0, padx=10, pady=5, sticky="ew")

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
        
        self.export_button = customtkinter.CTkButton(self.filter_frame, text="导出筛选账号", command=self.export_filtered_accounts)
        self.export_button.pack(side="right", padx=10, pady=5)

        # --- 中部账户列表 ---
        self.scrollable_frame = customtkinter.CTkScrollableFrame(self, label_text="账户列表")
        self.scrollable_frame.grid(row=2, column=0, padx=10, pady=0, sticky="nsew")

        # --- 底部状态栏 ---
        self.status_bar = customtkinter.CTkFrame(self, height=30)
        self.status_bar.grid(row=3, column=0, padx=10, pady=10, sticky="ew")
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

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    parts = line.replace(",", "|").split("|")
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
        for email, data in self.accounts_data.items():
            if data["status"] != STATUS_SUCCESS:
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

        self.processing_thread = threading.Thread(
            target=self._thread_target_wrapper,
            args=(accounts_to_process, max_workers, self.gui_queue, self.stop_event, self.configs.get("browser_path"), self.configs.get("save_path"), desired_keys),
            daemon=True
        )
        self.processing_thread.start()
        self._update_status_bar() # 启动计时器

    def stop_processing(self):
        if not self.is_running: return
        self.stop_event.set() # 发出停止信号
        self.stop_button.configure(state="disabled") # 禁用按钮防止重复点击
        messagebox.showwarning("正在停止...", "已发送停止信号，请等待当前运行的任务完成。")

    def _thread_target_wrapper(self, accounts_list, max_workers, gui_queue, stop_event, browser_path, save_path, desired_keys):
        """包装 start_processing 以捕获启动异常。"""
        try:
            start_processing(accounts_list, max_workers, gui_queue, stop_event, browser_path, save_path, desired_keys)
        except (DependenciesMissingError, GCloudNotInstalledError) as e:
            # 捕获可预见的启动错误，并直接在主线程显示
            messagebox.showerror("启动错误", str(e))
            # 发送一个通用错误来停止UI
            self.gui_queue.put({"account": GENERAL_ERROR_ACCOUNT, "status": STATUS_FAILURE, "reason": "启动前检查失败"})
        except Exception as e:
            # 将其他启动时发生的严重错误发送回主线程
            error_msg = f"后台任务启动时发生未知错误: {e}"
            self.gui_queue.put({"account": GENERAL_ERROR_ACCOUNT, "status": STATUS_FAILURE, "reason": error_msg})

    def _process_gui_queue(self):
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

                # 处理账户结果
                email = result.get("account")
                if email and email in self.accounts_data:
                    self.accounts_data[email].update(result)
                    status = result.get("status", STATUS_FAILURE)
                    error_message = result.get("reason")
                    key_count = len(result.get("keys", []))

                    self.accounts_data[email]["widget"].set_status(
                        status, error_message=error_message, key_count=key_count
                    )
                    
                    if result.get("keys"):
                        self.all_keys.update(result["keys"])
                        self.show_keys_button.configure(state="normal")
                    
                    self._update_status_bar()
                    self._apply_filters() # 实时更新筛选视图
        except queue.Empty:
            pass
        finally:
            # 任务状态检查与UI更新
            if self.is_running:
                task_is_over = False
                # 条件1: 后台线程已不存在 (处理了正常结束和强制停止)
                if not self.processing_thread or not self.processing_thread.is_alive():
                    task_is_over = True
                # 条件2: 所有任务都已完成 (正常结束的保险检查)
                elif not self.stop_event.is_set() and all(d['status'] not in [STATUS_PENDING, STATUS_PROCESSING] for d in self.accounts_data.values()):
                    task_is_over = True
                
                if task_is_over:
                    self._task_finished()
                else:
                    # 任务仍在运行, 仅更新状态栏计时器
                    self._update_status_bar()

            self.after(100, self._process_gui_queue)

    def _task_finished(self):
        self.is_running = False
        self.start_button.configure(state="normal")
        self.load_button.configure(state="normal")
        self.stop_button.configure(state="disabled")
        
        # 保存完整日志
        # 修正：确保log目录与autogetkeys目录同级
        log_dir = os.path.abspath(os.path.join(sys.path[0], "..", "log"))
        os.makedirs(log_dir, exist_ok=True)
        log_filename = os.path.join(log_dir, f"log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt")
        try:
            with open(log_filename, "w", encoding="utf-8") as f:
                f.write(self.full_log)
            log_msg = f"完整日志已保存到: {log_filename}"
        except Exception as e:
            log_msg = f"保存日志失败: {e}"

        # 新增：自动保存密钥文件
        keys_save_msg = ""
        if self.all_keys:
            save_path = self.configs.get("save_path")
            try:
                # 如果用户在设置中指定了路径，则使用它，否则默认保存到log目录
                keys_filename = save_path if save_path else os.path.join(log_dir, f"keys_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt")
                
                with open(keys_filename, "w", encoding="utf-8") as f:
                    f.write("\n".join(self.all_keys))
                keys_save_msg = f"密钥已保存到: {os.path.abspath(keys_filename)}"
            except Exception as e:
                keys_save_msg = f"保存密钥文件失败: {e}"

        # 最终报告
        s_count, p_count, f_count, k_count = self._get_stats()
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
        success_count = sum(1 for d in self.accounts_data.values() if d.get('status') == STATUS_SUCCESS)
        partial_count = sum(1 for d in self.accounts_data.values() if d.get('status') == STATUS_PARTIAL_SUCCESS)
        # 统计所有包含“失败”字样的状态，这样更具弹性
        failure_count = sum(1 for d in self.accounts_data.values() if '失败' in d.get('status', ''))
        key_count = len(self.all_keys)
        return success_count, partial_count, failure_count, key_count

    def _update_status_bar(self):
        s_count, p_count, f_count, k_count = self._get_stats()
        total_count = len(self.accounts_data)
        processed_count = sum(1 for d in self.accounts_data.values() if d.get('status') not in [STATUS_PENDING, STATUS_PROCESSING])

        run_time_str = "00:00:00"
        eta_str = "--:--:--"
        progress = 0
        
        if self.is_running and total_count > 0:
            elapsed = time.time() - self.start_time
            run_time_str = time.strftime('%H:%M:%S', time.gmtime(elapsed))
            
            # --- 并行感知ETA和进度条算法 ---
            try:
                max_workers = int(self.configs.get("max_workers", 4))
                if max_workers <= 0: max_workers = 1
            except (ValueError, TypeError):
                max_workers = 1

            PRESET_TIME_PER_BATCH = 50  # 预设每批次任务耗时50秒

            # 1. 计算总批次数
            num_batches = math.ceil(total_count / max_workers)

            # 2. 确定总预估时间
            if processed_count > 0:
                # 动态估算：基于已完成批次的平均耗时
                # 注意：这里的 'processed_count' 是已完成的账号数，我们需要的是已完成的批次数
                # 为了简化并得到一个平滑的估算，我们用 (已耗时 / 已完成账号数) 作为单个任务的平均时间
                # 然后用这个时间去估算一个批次的平均时间
                time_per_item_in_parallel = elapsed / processed_count
                time_per_batch = time_per_item_in_parallel * max_workers
                
                # 更稳健的估算：一个批次的耗时约等于完成该批次中最慢的那个任务的时间
                # 我们用 (总耗时 / 完成的批次数) 来估算
                num_processed_batches = math.ceil(processed_count / max_workers)
                time_per_batch_estimated = elapsed / num_processed_batches
                total_estimated_time = time_per_batch_estimated * num_batches
            else:
                # 初始估算：基于预设值
                total_estimated_time = num_batches * PRESET_TIME_PER_BATCH

            # 3. 基于总预估时间，派生出进度和剩余时间
            if total_estimated_time > 0:
                is_overtime = elapsed > total_estimated_time
                all_done = processed_count == total_count

                if is_overtime and not all_done:
                    progress = 0.99 # 超时但未完成，卡在99%
                    eta_str = "超时"
                else:
                    progress = min(elapsed / total_estimated_time, 1.0)
                    eta = max(0, total_estimated_time - elapsed)
                    eta_str = time.strftime('%H:%M:%S', time.gmtime(eta))
        
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
            self.after(2000, lambda: copy_btn.configure(text="全部复制"))

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

if __name__ == "__main__":
    app = App()
    app.mainloop()
