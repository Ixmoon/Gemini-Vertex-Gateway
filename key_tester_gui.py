import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from google import genai
from google.genai import types
import platform
from collections import Counter

class ElegantGeminiKeyChecker:
    def __init__(self, root):
        self.root = root
        self.root.title("Gemini API 密钥验证工具")
        self.root.geometry("800x600")
        self.root.minsize(650, 450)
        self.root.configure(bg="#FAFAFA")
        self.config_path = 'key_tester_gui_config.json'

        self.setup_styles()
        self.create_widgets()
        self.load_gui_config() # Load URL on startup
        self.center_window()
        self.executor = ThreadPoolExecutor(max_workers=50) # 设置线程池
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

    def setup_styles(self):
        style = ttk.Style()
        if platform.system() == "Windows":
            style.theme_use('vista')
        else:
            style.theme_use('clam')

        # --- Professional Color Palette ---
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

        # --- General Styles ---
        font_family = 'Microsoft YaHei UI' if platform.system() == "Windows" else 'Helvetica'
        style.configure(".",
                        background=self.colors["bg"],
                        foreground=self.colors["fg"],
                        font=(font_family, 10))

        style.configure("TFrame", background=self.colors["bg"])
        style.configure("TLabel", background=self.colors["bg"], foreground=self.colors["fg"])
        
        # --- Paned Window Style ---
        style.configure("TPanedwindow", background=self.colors["border"])
        style.configure("TPanedwindow.Sash", sashthickness=6, relief="flat", background=self.colors["bg"])

        # --- Button Styles ---
        style.configure("TButton",
                        padding=(12, 6),
                        relief="flat",
                        background=self.colors["bg_secondary"],
                        foreground=self.colors["fg"],
                        borderwidth=1,
                        bordercolor=self.colors["border"],
                        font=(font_family, 10))
        style.map("TButton",
                  background=[('active', '#F0F0F0')],
                  bordercolor=[('active', self.colors["border_focus"])])

        style.configure("Accent.TButton",
                        background=self.colors["accent"],
                        foreground=self.colors["fg"]) # 强制设为黑色
        style.map("Accent.TButton",
                  background=[('active', self.colors["accent_active"]), ('disabled', '#E0E0E0')])

        # --- Treeview Styles ---
        style.configure("Treeview",
                        background=self.colors["bg_secondary"],
                        foreground=self.colors["fg"],
                        fieldbackground=self.colors["bg_secondary"],
                        rowheight=30,
                        relief="solid",
                        borderwidth=1,
                        bordercolor=self.colors["border"])
        style.configure("Treeview.Heading",
                        background=self.colors["bg"],
                        foreground=self.colors["fg"],
                        relief="flat",
                        font=(font_family, 10, 'bold'),
                        padding=(12, 8))
        style.map("Treeview.Heading", background=[('active', self.colors["bg"])])
        style.map("Treeview",
                  background=[('selected', self.colors["accent"])],
                  foreground=[('selected', self.colors["accent_fg"])])

        # --- Scrollbar Style ---
        style.configure("Vertical.TScrollbar",
                        relief="flat",
                        background=self.colors["bg"],
                        troughcolor=self.colors["bg"],
                        bordercolor=self.colors["bg"],
                        arrowcolor=self.colors["fg_subtle"])
        style.map("Vertical.TScrollbar", background=[('active', '#E0E0E0')])

    def create_widgets(self):
        # --- Main Layout ---
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        
        # PanedWindow for resizable sections
        paned_window = ttk.PanedWindow(self.root, orient=tk.VERTICAL, style="TPanedwindow")
        paned_window.grid(row=0, column=0, sticky="nsew", padx=15, pady=(15, 10))

        # --- Top Frame (Input) ---
        input_container = ttk.Frame(paned_window, padding=(15, 15, 15, 0))
        input_container.columnconfigure(0, weight=1)
        input_container.rowconfigure(1, weight=1)
        
        keys_input_label = ttk.Label(input_container, text="粘贴一个或多个密钥 (通过换行、空格或逗号分隔)", font=('Microsoft YaHei UI', 11, 'bold'))
        keys_input_label.grid(row=0, column=0, sticky="w", pady=(0, 10))
        
        self.keys_input = scrolledtext.ScrolledText(input_container, wrap=tk.WORD,
                                                    bg=self.colors["bg_secondary"], fg=self.colors["fg"],
                                                    relief=tk.SOLID, borderwidth=1,
                                                    bd=0, # Use highlightthickness instead
                                                    highlightthickness=1,
                                                    highlightcolor=self.colors["border"],
                                                    highlightbackground=self.colors["border"],
                                                    insertbackground=self.colors["fg"],
                                                    selectbackground=self.colors["accent"],
                                                    padx=12, pady=12, font=('Consolas', 10))
        self.keys_input.grid(row=1, column=0, sticky="nsew")
        self.keys_input.bind("<FocusIn>", lambda e: self.keys_input.config(highlightcolor=self.colors["border_focus"]))
        self.keys_input.bind("<FocusOut>", lambda e: self.keys_input.config(highlightcolor=self.colors["border"]))

        # --- API Endpoint Input ---
        endpoint_label = ttk.Label(input_container, text="自定义 API 端点 (可选):")
        endpoint_label.grid(row=2, column=0, sticky="w", pady=(10, 5))

        self.api_endpoint_var = tk.StringVar()
        self.endpoint_entry = ttk.Entry(input_container, textvariable=self.api_endpoint_var, font=('Consolas', 10))
        self.endpoint_entry.grid(row=3, column=0, sticky="ew")
        self.api_endpoint_var.set("https://generativelanguage.googleapis.com")
        
        paned_window.add(input_container, weight=1)

        # --- Bottom Frame (Results) ---
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
        self.tree.column("Details", width=250)

        vsb = ttk.Scrollbar(results_container, orient="vertical", command=self.tree.yview, style="Vertical.TScrollbar")
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky='ns')

        self.tree.tag_configure('valid', foreground=self.colors["success"])
        self.tree.tag_configure('invalid', foreground=self.colors["error"])
        self.tree.tag_configure('checking', foreground=self.colors["fg_subtle"])
        
        paned_window.add(results_container, weight=3)
        
        # --- Actions & Status Bar Frame ---
        bottom_frame = ttk.Frame(self.root, padding=(15, 5, 15, 10))
        bottom_frame.grid(row=1, column=0, sticky="ew")
        bottom_frame.columnconfigure(1, weight=1)

        self.check_button = ttk.Button(bottom_frame, text="开始验证", command=self.start_checking_thread, style="Accent.TButton")
        self.check_button.grid(row=0, column=0, sticky="w", padx=(0, 10))

        actions_inner_frame = ttk.Frame(bottom_frame)
        actions_inner_frame.grid(row=0, column=2, sticky="e")

        self.copy_valid_button = ttk.Button(actions_inner_frame, text="复制有效", command=self.copy_valid)
        self.copy_valid_button.pack(side=tk.LEFT, padx=(0, 10))
        
        self.delete_invalid_button = ttk.Button(actions_inner_frame, text="删除无效", command=self.delete_invalid)
        self.delete_invalid_button.pack(side=tk.LEFT, padx=(0, 10))

        self.load_button = ttk.Button(actions_inner_frame, text="读取配置", command=self.load_from_config)
        self.load_button.pack(side=tk.LEFT, padx=(0, 10))

        self.save_button = ttk.Button(actions_inner_frame, text="保存到配置", command=self.save_to_config)
        self.save_button.pack(side=tk.LEFT)
        
        self.status_bar = ttk.Label(bottom_frame, text="准备就绪", anchor='w', foreground=self.colors["fg_subtle"])
        self.status_bar.grid(row=0, column=1, sticky='ew', padx=(10, 10))
        
    def start_checking_thread(self):
        self.check_button.config(state=tk.DISABLED)
        for i in self.tree.get_children():
            self.tree.delete(i)

        keys_text = self.keys_input.get("1.0", tk.END)
        keys = re.split(r'[\s,]+', keys_text)
        unique_keys = list(dict.fromkeys(filter(None, keys)))

        if not unique_keys:
            messagebox.showwarning("输入错误", "请输入至少一个 API 密钥。")
            self.check_button.config(state=tk.NORMAL)
            return

        api_endpoint = self.api_endpoint_var.get().strip()

        self.update_status(f"开始验证 {len(unique_keys)} 个密钥...")
        self.key_statuses = {}
        
        for i, key in enumerate(unique_keys):
            item_id = self.tree.insert("", "end", values=(i + 1, key, "验证中...", ""), tags=('checking',))
            future = self.executor.submit(self.validate_key, key, api_endpoint)
            future.add_done_callback(
                lambda f, item=item_id, k=key: self.root.after(0, self.update_ui_from_future, f, item, k)
            )

    def validate_key(self, key, api_endpoint):
        """
        验证单个密钥，不再接收 item_id，而是返回结果。
        返回: (status, details, tag)
        """
        try:
            http_options = types.HttpOptions(base_url=api_endpoint) if api_endpoint else None
            client = genai.Client(api_key=key, http_options=http_options)
            client.models.get(model="models/gemini-2.0-flash")
            return "有效", "密钥有效，可访问模型。", "valid"
        except Exception as e:
            error_str = str(e).lower()
            if "permission denied" in error_str:
                return "无效", "权限被拒绝。请检查密钥权限。", "invalid"
            elif "api key not valid" in error_str or "unauthenticated" in error_str:
                return "无效", "认证失败。API 密钥不正确。", "invalid"
            else:
                return "错误", str(e), "invalid"

    def update_ui_from_future(self, future, item_id, key):
        """
        从 future 对象获取结果并更新UI。
        """
        try:
            # 从 future 对象获取 validate_key 的返回结果
            status, details, tag = future.result()

            self.key_statuses[key] = tag

            # 更新 Treeview 中的条目
            values = list(self.tree.item(item_id, "values"))
            self.tree.item(item_id, values=(values[0], key, status, details), tags=(tag,))

            self.update_status_summary()
        except tk.TclError:
            # Item might have been deleted, just ignore
            pass
        except Exception as e:
            # Handle potential exceptions from the future (e.g., network errors)
            self.tree.item(item_id, values=(self.tree.item(item_id, "values")[0], key, "执行错误", str(e)), tags=('invalid',))
            self.key_statuses[key] = 'invalid'
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
        valid_keys = [self.tree.item(item_id, "values")[1] for item_id in self.tree.get_children() if 'valid' in self.tree.item(item_id, "tags")]
        if not valid_keys:
            messagebox.showwarning("无有效密钥", "没有可复制的有效密钥。")
            return
        
        keys_string = "\n".join(valid_keys)
        self.root.clipboard_clear()
        self.root.clipboard_append(keys_string)
        self.update_status(f"已复制 {len(valid_keys)} 个有效密钥到剪贴板。")

    def save_to_config(self):
        valid_keys = [self.tree.item(item_id, "values")[1] for item_id in self.tree.get_children() if 'valid' in self.tree.item(item_id, "tags")]
        if not valid_keys:
            messagebox.showwarning("没有密钥", "没有可保存的有效密钥。")
            return

        secrets_config_path = 'secrets.config.json'
        try:
            try:
                with open(secrets_config_path, 'r', encoding='utf-8') as f:
                    config_data = json.load(f)
            except FileNotFoundError:
                config_data = {"poolKeys": []}
            except json.JSONDecodeError:
                messagebox.showerror("错误", f"无法解析 {secrets_config_path}，请检查文件格式。")
                return
            
            if 'poolKeys' not in config_data or not isinstance(config_data['poolKeys'], list):
                config_data['poolKeys'] = []

            existing_keys = set(config_data['poolKeys'])
            new_keys_to_add = [key for key in valid_keys if key not in existing_keys]
            config_data['poolKeys'].extend(new_keys_to_add)

            with open(secrets_config_path, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2, ensure_ascii=False)
            
            messagebox.showinfo("成功", f"已成功将 {len(new_keys_to_add)} 个新密钥添加到 {secrets_config_path}。")
            self.update_status(f"已添加 {len(new_keys_to_add)} 个新密钥到 {secrets_config_path}。")

        except Exception as e:
            messagebox.showerror("保存错误", f"写入 {secrets_config_path} 失败: {e}")
            self.update_status(f"保存失败: {e}")

    def load_from_config(self):
        secrets_config_path = 'secrets.config.json'
        try:
            with open(secrets_config_path, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
            
            pool_keys = config_data.get('poolKeys', [])
            if not isinstance(pool_keys, list):
                 messagebox.showwarning("格式错误", f"{secrets_config_path} 中的 'poolKeys' 不是一个列表。")
                 return

            if not pool_keys:
                messagebox.showinfo("提示", f"{secrets_config_path} 中的密钥池为空。")
                return

            self.keys_input.delete('1.0', tk.END)
            self.keys_input.insert('1.0', "\n".join(pool_keys))
            self.update_status(f"已从 {secrets_config_path} 加载 {len(pool_keys)} 个密钥。")

        except FileNotFoundError:
            messagebox.showerror("错误", f"配置文件 {secrets_config_path} 未找到。")
        except json.JSONDecodeError:
            messagebox.showerror("错误", f"无法解析 {secrets_config_path}。")
        except Exception as e:
            messagebox.showerror("读取错误", f"读取 {secrets_config_path} 失败: {e}")

    def load_gui_config(self):
        try:
            with open(self.config_path, 'r', encoding='utf-8') as f:
                gui_config = json.load(f)
            
            endpoint = gui_config.get("customApiEndpoint")
            if endpoint and isinstance(endpoint, str):
                self.api_endpoint_var.set(endpoint)
                self.update_status("已加载上次使用的自定义端点。")
        except (FileNotFoundError, json.JSONDecodeError):
            # It's okay if the config file doesn't exist or is invalid
            pass

    def save_gui_config(self):
        gui_config = {
            "customApiEndpoint": self.api_endpoint_var.get().strip()
        }
        try:
            with open(self.config_path, 'w', encoding='utf-8') as f:
                json.dump(gui_config, f, indent=2, ensure_ascii=False)
        except Exception as e:
            # Non-critical error, so we don't show a popup
            self.update_status(f"保存界面配置失败: {e}")

    def on_closing(self):
        self.save_gui_config()
        self.executor.shutdown(wait=False, cancel_futures=True)
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
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        messagebox.showerror("缺少依赖", "检测到缺少 'google-genai' 库。\n\n请在终端中使用以下命令安装:\npip install google-genai")
        genai = None

    root = tk.Tk()
    app = ElegantGeminiKeyChecker(root)

    if not genai:
        app.check_button.config(state=tk.DISABLED)
        app.update_status("错误: 缺少 'google-genai' 库。请安装后重启。")
        
    root.mainloop()