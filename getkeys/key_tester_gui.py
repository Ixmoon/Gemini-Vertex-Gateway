import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import json
from re import split
import asyncio
from threading import Thread
from google.genai import Client
from google.genai.types import HttpOptions
from platform import system as platformsystem
from collections import Counter

class ElegantGeminiKeyChecker:
    def __init__(self, root):
        self.root = root
        self.root.title("Gemini API 密钥验证工具")
        self.root.geometry("800x600")
        self.root.minsize(650, 450)
        self.root.configure(bg="#FAFAFA")
        self.config_path = 'key_tester_gui_config.json'
        self.SECRETS_CONFIG_PATH = 'secrets.config.json'
        self.max_workers_var = tk.IntVar(value=50)
        self.max_retries_var = tk.IntVar(value=3)
        self.pending_ui_updates = []
        self.ui_update_scheduled = False

        self.setup_styles()
        self.create_widgets()
        self.load_gui_config()
        self.center_window()
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

    def setup_styles(self):
        style = ttk.Style()
        if platformsystem() == "Windows":
            style.theme_use('vista')
        else:
            style.theme_use('clam')

        self.colors = {
            "bg": "#FAFAFA",
            "bg_secondary": "#FFFFFF",
            "fg": "#212121",
            "fg_subtle": "#616161",
            "accent": "#007BFF",
            "accent_active": "#0056b3",
            "accent_fg": "#FFFFFF",
            "success": "#28A745",
            "error": "#DC3545",
            "warning": "#FFC107",
            "border": "#E0E0E0",
            "border_focus": "#007BFF",
        }

        font_family = 'Microsoft YaHei UI' if platformsystem() == "Windows" else 'Helvetica'
        style.configure(".", background=self.colors["bg"], foreground=self.colors["fg"], font=(font_family, 10))
        style.configure("TFrame", background=self.colors["bg"])
        style.configure("TLabel", background=self.colors["bg"], foreground=self.colors["fg"])
        style.configure("TPanedwindow", background=self.colors["border"])
        style.configure("TPanedwindow.Sash", sashthickness=6, relief="flat", background=self.colors["bg"])
        style.configure("TButton", padding=(12, 6), relief="flat", background=self.colors["bg_secondary"],
                        foreground=self.colors["fg"], borderwidth=1, bordercolor=self.colors["border"],
                        font=(font_family, 10))
        style.map("TButton", background=[('active', '#F0F0F0')], bordercolor=[('active', self.colors["border_focus"])])
        style.configure("Accent.TButton", background=self.colors["accent"], foreground=self.colors["fg"])
        style.map("Accent.TButton", background=[('active', self.colors["accent_active"]), ('disabled', '#E0E0E0')])
        style.configure("Treeview", background=self.colors["bg_secondary"], foreground=self.colors["fg"],
                        fieldbackground=self.colors["bg_secondary"], rowheight=30, relief="solid",
                        borderwidth=1, bordercolor=self.colors["border"])
        style.configure("Treeview.Heading", background=self.colors["bg"], foreground=self.colors["fg"],
                        relief="flat", font=(font_family, 10, 'bold'), padding=(12, 8))
        style.map("Treeview.Heading", background=[('active', self.colors["bg"])])
        style.map("Treeview", background=[('selected', self.colors["accent"])],
                  foreground=[('selected', self.colors["accent_fg"])])
        style.configure("Vertical.TScrollbar", relief="flat", background=self.colors["bg"],
                        troughcolor=self.colors["bg"], bordercolor=self.colors["bg"],
                        arrowcolor=self.colors["fg_subtle"])
        style.map("Vertical.TScrollbar", background=[('active', '#E0E0E0')])

    def create_widgets(self):
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        
        paned_window = ttk.PanedWindow(self.root, orient=tk.VERTICAL, style="TPanedwindow")
        paned_window.grid(row=0, column=0, sticky="nsew", padx=15, pady=(15, 10))

        input_container = ttk.Frame(paned_window, padding=(15, 15, 15, 0))
        input_container.columnconfigure(0, weight=1)
        input_container.rowconfigure(1, weight=1)
        
        keys_input_label = ttk.Label(input_container, text="粘贴一个或多个密钥 (通过换行、空格或逗号分隔)", font=('Microsoft YaHei UI', 11, 'bold'))
        keys_input_label.grid(row=0, column=0, sticky="w", pady=(0, 10))
        
        self.keys_input = scrolledtext.ScrolledText(input_container, wrap=tk.WORD,
                                                    bg=self.colors["bg_secondary"], fg=self.colors["fg"],
                                                    relief=tk.SOLID, borderwidth=1, bd=0,
                                                    highlightthickness=1, highlightcolor=self.colors["border"],
                                                    highlightbackground=self.colors["border"],
                                                    insertbackground=self.colors["fg"],
                                                    selectbackground=self.colors["accent"],
                                                    padx=12, pady=12, font=('Consolas', 10))
        self.keys_input.grid(row=1, column=0, sticky="nsew")
        self.keys_input.bind("<FocusIn>", lambda e: self.keys_input.config(highlightcolor=self.colors["border_focus"]))
        self.keys_input.bind("<FocusOut>", lambda e: self.keys_input.config(highlightcolor=self.colors["border"]))

        options_frame = ttk.Frame(input_container)
        options_frame.grid(row=2, column=0, sticky="ew", pady=(10, 5))
        options_frame.columnconfigure(1, weight=1)

        endpoint_label = ttk.Label(options_frame, text="API 端点:")
        endpoint_label.grid(row=0, column=0, sticky="w")
        
        self.api_endpoint_var = tk.StringVar()
        self.endpoint_entry = ttk.Entry(options_frame, textvariable=self.api_endpoint_var, font=('Consolas', 10))
        self.endpoint_entry.grid(row=0, column=1, sticky="ew", padx=5)
        self.api_endpoint_var.set("https://generativelanguage.googleapis.com")

        max_workers_label = ttk.Label(options_frame, text="并发数:")
        max_workers_label.grid(row=0, column=2, sticky="w", padx=(15, 5))

        self.max_workers_spinbox = ttk.Spinbox(options_frame, from_=1, to=500, textvariable=self.max_workers_var, width=8)
        self.max_workers_spinbox.grid(row=0, column=3, sticky="w")

        max_retries_label = ttk.Label(options_frame, text="重试次数:")
        max_retries_label.grid(row=0, column=4, sticky="w", padx=(15, 5))

        self.max_retries_spinbox = ttk.Spinbox(options_frame, from_=0, to=10, textvariable=self.max_retries_var, width=8)
        self.max_retries_spinbox.grid(row=0, column=5, sticky="w")

        self.status_bar = ttk.Label(options_frame, text="准备就绪", anchor='w', foreground=self.colors["fg_subtle"])
        self.status_bar.grid(row=1, column=0, columnspan=6, sticky="ew", pady=(10, 0))
        
        paned_window.add(input_container, weight=1)

        results_container = ttk.Frame(paned_window, padding=(15, 15, 15, 0))
        results_container.columnconfigure(0, weight=1)
        results_container.rowconfigure(0, weight=1)

        columns = ("#", "Key", "Status", "Details")
        self.tree = ttk.Treeview(results_container, columns=columns, show="headings")
        self.tree.heading("#", text="#", anchor=tk.W)
        self.tree.heading("Key", text="API 密钥", anchor=tk.W)
        self.tree.heading("Status", text="状态", anchor=tk.CENTER)
        self.tree.heading("Details", text="详情", anchor=tk.W)

        self.tree.column("#", width=50, stretch=False, anchor=tk.W)
        self.tree.column("Key", width=320, anchor=tk.W)
        self.tree.column("Status", width=120, stretch=False, anchor=tk.CENTER)
        self.tree.column("Details", width=400)

        vsb = ttk.Scrollbar(results_container, orient="vertical", command=self.tree.yview, style="Vertical.TScrollbar")
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky='ns')

        self.tree.tag_configure('valid', foreground=self.colors["success"])
        self.tree.tag_configure('invalid', foreground=self.colors["error"])
        self.tree.tag_configure('checking', foreground=self.colors["fg_subtle"])
        
        paned_window.add(results_container, weight=3)
        
        bottom_frame = ttk.Frame(self.root, padding=(15, 5, 15, 10))
        bottom_frame.grid(row=1, column=0, sticky="ew")
        bottom_frame.columnconfigure(1, weight=1)

        self.check_button = ttk.Button(bottom_frame, text="开始验证", command=self.start_checking, style="Accent.TButton")
        self.check_button.grid(row=0, column=0, sticky="w")

        # Action buttons grouped on the right
        actions_frame = ttk.Frame(bottom_frame)
        actions_frame.grid(row=0, column=2, sticky="e")

        self.copy_valid_button = ttk.Button(actions_frame, text="复制有效", command=self.copy_valid)
        self.copy_valid_button.grid(row=0, column=0, padx=(0, 5))
        
        self.delete_invalid_button = ttk.Button(actions_frame, text="删除无效", command=self.delete_invalid)
        self.delete_invalid_button.grid(row=0, column=1, padx=(0, 5))

        self.load_button = ttk.Button(actions_frame, text="读取配置", command=self.load_from_config)
        self.load_button.grid(row=0, column=2, padx=(0, 5))

        self.clear_pool_button = ttk.Button(actions_frame, text="清空密钥池", command=self.clear_key_pool)
        self.clear_pool_button.grid(row=0, column=3, padx=(0, 5))

        self.save_button = ttk.Button(actions_frame, text="保存到配置", command=self.save_to_config)
        self.save_button.grid(row=0, column=4, padx=(0, 0))
        
    def start_checking(self):
        self.check_button.config(state=tk.DISABLED)
        for i in self.tree.get_children():
            self.tree.delete(i)

        keys_text = self.keys_input.get("1.0", tk.END)
        keys = split(r'[\s,]+', keys_text)
        unique_keys = list(dict.fromkeys(filter(None, keys)))

        if not unique_keys:
            messagebox.showwarning("输入错误", "请输入至少一个 API 密钥。")
            self.check_button.config(state=tk.NORMAL)
            return
        
        Thread(target=self.run_async_validation, args=(unique_keys,), daemon=True).start()

    def run_async_validation(self, keys):
        try:
            asyncio.run(self.validate_all_keys_async(keys))
        except Exception as e:
            self.root.after(0, self.handle_validation_error, e)

    def handle_validation_error(self, e):
        messagebox.showerror("验证出错", f"执行异步验证时发生错误: {e}")
        self.check_button.config(state=tk.NORMAL)

    async def worker(self, queue, http_options):
        while True:
            try:
                item = await queue.get()
                await self.validate_key_async(item['key'], http_options, item['id'])
                queue.task_done()
            except asyncio.CancelledError:
                break
            except Exception:
                # Handle exceptions within the worker if necessary
                queue.task_done()


    async def validate_all_keys_async(self, keys):
        api_endpoint = self.api_endpoint_var.get().strip()
        http_options = HttpOptions(base_url=api_endpoint) if api_endpoint else None
        max_concurrency = self.max_workers_var.get()
        
        self.root.after(0, self.update_status, f"开始验证 {len(keys)} 个密钥 (并发: {max_concurrency})...")
        self.key_statuses = {}
        
        queue = asyncio.Queue()
        for i, key in enumerate(keys):
            item_id = self.tree.insert("", "end", values=(i + 1, key, "排队中...", ""), tags=('checking',))
            await queue.put({'id': item_id, 'key': key})

        workers = [asyncio.create_task(self.worker(queue, http_options)) for _ in range(max_concurrency)]

        await queue.join()

        for w in workers:
            w.cancel()
        await asyncio.gather(*workers, return_exceptions=True)


    async def validate_key_async(self, key, http_options, item_id):
        status, details, tag = "错误", "未知错误", "invalid"
        max_retries = self.max_retries_var.get()
        
        for attempt in range(max_retries + 1):
            try:
                client = Client(api_key=key, http_options=http_options)
                await client.aio.models.get(model="models/gemini-2.0-flash")
                status, details, tag = "有效", "密钥有效", "valid"
                break
            except Exception as e:
                error_str = str(e).lower()

                if "permission denied" in error_str or "api key not valid" in error_str or "unauthenticated" in error_str:
                    status, details, tag = "无效", f"认证失败: {repr(e)}", "invalid"
                    break
                if "not found" in error_str:
                    status, details, tag = "无效", f"模型或端点未找到: {repr(e)}", "invalid"
                    break

                if attempt < max_retries:
                    details = f"尝试 {attempt + 1}/{max_retries + 1} 失败，将重试..."
                    self.root.after(0, self.schedule_ui_update, item_id, key, "重试中", details, 'checking')
                    await asyncio.sleep(1 * (attempt + 1))
                    continue
                else:
                    status, details, tag = "无效", f"重试 {max_retries} 次后失败: {repr(e)}", "invalid"
                    break
        
        self.key_statuses[key] = tag
        self.root.after(0, self.schedule_ui_update, item_id, key, status, details, tag)

    def schedule_ui_update(self, item_id, key, status, details, tag):
        self.pending_ui_updates.append((item_id, key, status, details, tag))
        if not self.ui_update_scheduled:
            self.ui_update_scheduled = True
            self.root.after(100, self.process_pending_updates)

    def process_pending_updates(self):
        self.ui_update_scheduled = False
        if not self.pending_ui_updates:
            return

        updates_to_process = self.pending_ui_updates[:]
        self.pending_ui_updates.clear()

        latest_updates = {}
        for item_id, key, status, details, tag in updates_to_process:
            latest_updates[item_id] = (key, status, details, tag)

        for item_id, (key, status, details, tag) in latest_updates.items():
            try:
                if self.tree.exists(item_id):
                    values = list(self.tree.item(item_id, "values"))
                    self.tree.item(item_id, values=(values[0], key, status, details), tags=(tag,))
            except tk.TclError:
                pass
            except Exception as e:
                if self.tree.exists(item_id):
                    self.tree.item(item_id, values=(self.tree.item(item_id, "values")[0], key, "UI更新错误", str(e)), tags=('invalid',))

        self.update_status_summary()

    def update_status_summary(self):
        counts = Counter(self.key_statuses.values())
        total = len(self.key_statuses)
        valid_count = counts.get('valid', 0)
        invalid_count = counts.get('invalid', 0)
        
        summary_text = f"总计: {total} | 有效: {valid_count} | 无效/错误: {invalid_count}"
        if total == (valid_count + invalid_count) and total > 0:
             self.check_button.config(state=tk.NORMAL)
             summary_text += " | 验证完成"
        self.update_status(summary_text)

    def delete_invalid(self):
        items_to_delete = [item_id for item_id in self.tree.get_children() if 'valid' not in self.tree.item(item_id, "tags")]
        if not items_to_delete:
            messagebox.showinfo("提示", "没有可删除的无效或错误密钥。")
            return
        
        if messagebox.askyesno("确认删除", f"确定要删除 {len(items_to_delete)} 个无效/错误密钥吗？", icon='warning'):
            for item_id in items_to_delete:
                self.tree.delete(item_id)
            self.update_status(f"删除了 {len(items_to_delete)} 个密钥。")

    def copy_valid(self):
        valid_keys = self._get_valid_keys()
        if not valid_keys:
            messagebox.showwarning("无有效密钥", "没有可复制的有效密钥。")
            return
        
        keys_string = "\n".join(valid_keys)
        self.root.clipboard_clear()
        self.root.clipboard_append(keys_string)
        self.update_status(f"已复制 {len(valid_keys)} 个有效密钥到剪贴板。")

    def _get_valid_keys(self):
        return [self.tree.item(item_id, "values")[1] for item_id in self.tree.get_children() if 'valid' in self.tree.item(item_id, "tags")]

    def save_to_config(self):
        valid_keys = self._get_valid_keys()
        if not valid_keys:
            messagebox.showwarning("没有密钥", "没有可保存的有效密钥。")
            return

        config_data = self._read_json_config(self.SECRETS_CONFIG_PATH, default={"poolKeys": []})
        if config_data is None: return

        if 'poolKeys' not in config_data or not isinstance(config_data.get('poolKeys'), list):
            config_data['poolKeys'] = []

        existing_keys = set(config_data['poolKeys'])
        new_keys_to_add = [key for key in valid_keys if key not in existing_keys]
        config_data['poolKeys'].extend(new_keys_to_add)

        if self._write_json_config(self.SECRETS_CONFIG_PATH, config_data):
            messagebox.showinfo("成功", f"已成功将 {len(new_keys_to_add)} 个新密钥添加到 {self.SECRETS_CONFIG_PATH}。")
            self.update_status(f"已添加 {len(new_keys_to_add)} 个新密钥到 {self.SECRETS_CONFIG_PATH}。")

    def load_from_config(self):
        config_data = self._read_json_config(self.SECRETS_CONFIG_PATH)
        if config_data is None: return

        pool_keys = config_data.get('poolKeys', [])
        if not isinstance(pool_keys, list):
             messagebox.showwarning("格式错误", f"{self.SECRETS_CONFIG_PATH} 中的 'poolKeys' 不是一个列表。")
             return

        if not pool_keys:
            messagebox.showinfo("提示", f"{self.SECRETS_CONFIG_PATH} 中的密钥池为空。")
            return

        self.keys_input.delete('1.0', tk.END)
        self.keys_input.insert('1.0', "\n".join(pool_keys))
        self.update_status(f"已从 {self.SECRETS_CONFIG_PATH} 加载 {len(pool_keys)} 个密钥。")

    def clear_key_pool(self):
        if not messagebox.askyesno("确认清空", f"你确定要清空 {self.SECRETS_CONFIG_PATH} 中的所有密钥吗？\n此操作不可撤销。", icon='warning'):
            return

        config_data = self._read_json_config(self.SECRETS_CONFIG_PATH, default={})
        if config_data is None:
             config_data = {}

        config_data['poolKeys'] = []

        if self._write_json_config(self.SECRETS_CONFIG_PATH, config_data):
            messagebox.showinfo("成功", f"已成功清空 {self.SECRETS_CONFIG_PATH} 中的密钥池。")
            self.update_status(f"密钥池 {self.SECRETS_CONFIG_PATH} 已被清空。")

    def load_gui_config(self):
        gui_config = self._read_json_config(self.config_path)
        if not gui_config:
            self.update_status("未找到配置文件，使用默认设置。")
            return

        endpoint = gui_config.get("customApiEndpoint")
        if endpoint and isinstance(endpoint, str):
            self.api_endpoint_var.set(endpoint)
        
        max_workers = gui_config.get("maxWorkers", 50)
        if isinstance(max_workers, int) and 1 <= max_workers <= 500:
            self.max_workers_var.set(max_workers)
        
        max_retries = gui_config.get("maxRetries", 3)
        if isinstance(max_retries, int) and 0 <= max_retries <= 10:
            self.max_retries_var.set(max_retries)

        self.update_status("已加载配置。")

    def save_gui_config(self):
        gui_config = {
            "customApiEndpoint": self.api_endpoint_var.get().strip(),
            "maxWorkers": self.max_workers_var.get(),
            "maxRetries": self.max_retries_var.get()
        }
        self._write_json_config(self.config_path, gui_config)

    def _read_json_config(self, path, default=None):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            return default
        except json.JSONDecodeError:
            messagebox.showerror("错误", f"无法解析 {path}，请检查文件格式。")
            return None
        except Exception as e:
            messagebox.showerror("读取错误", f"读取 {path} 失败: {e}")
            return None

    def _write_json_config(self, path, data):
        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            return True
        except Exception as e:
            messagebox.showerror("保存错误", f"写入 {path} 失败: {e}")
            self.update_status(f"保存失败: {e}")
            return False

    def on_closing(self):
        self.save_gui_config()
        self.root.destroy()

    def update_status(self, text):
        self.status_bar.config(text=text)

    def center_window(self):
        self.root.update_idletasks()
        width = self.root.winfo_width()
        height = self.root.winfo_height()
        x = (self.root.winfo_screenwidth() // 2) - (width // 2)
        y = (self.root.winfo_screenheight() // 2) - (height // 2)
        self.root.geometry(f'{width}x{height}+{x}+{y}')

if __name__ == "__main__":
    missing_deps = []

    root = tk.Tk()

    app = ElegantGeminiKeyChecker(root)

    root.mainloop()