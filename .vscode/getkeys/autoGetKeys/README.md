# 软件授权系统 - 部署与使用指南

本指南说明了如何部署和使用基于机器码和 Deno KV 的软件授权系统。

## 系统组成

1.  **客户端 (`gui.py`)**: 一个 Python GUI 应用程序，它在启动时会进行授权验证。
2.  **服务器 (`server.ts`)**: 一个 Deno 边缘函数，负责处理授权请求，并使用 Deno KV 数据库来存储和验证授权码。

### **重要概念：两种密钥的区别**

为了避免混淆，请务必理解系统中的两种“密钥”：

-   **`AES_KEY` (加密密钥)**:
    -   **作用**: 用于加密客户端和服务器之间的通信。
    -   **谁持有**: 仅由您（开发者）持有。它被硬编码在客户端，并作为秘密环境变量存储在服务器上。
    -   **性质**: **高度机密，绝不能泄露给用户**。这是整个系统安全的基础。

-   **`license_key` (授权码)**:
    -   **作用**: 软件的使用凭证，用于验证用户是否有权使用软件。
    -   **谁持有**: 您生成并出售给最终用户。
    -   **性质**: 用户在首次运行时通过弹窗输入。

## 部署步骤

### 第一步：准备客户端 (`gui.py`)

1.  **安装依赖**:
    确保你已经安装了所有必需的 Python 库。
    ```bash
    pip install requests pycryptodomex customtkinter
    ```

2.  **配置加密密钥**:
    打开 `gui.py` 文件，找到 `AES_KEY` 常量。
    ```python
    # file: gui.py
    AES_KEY = b'YourSecretKey12345678901234567890' # 32字节，用于AES-256
    ```
    将其中的 `YourSecretKey12345678901234567890` **替换为你自己的、长度为32字节的强随机密钥**。这个密钥必须与服务器端的密钥完全一致。

3.  **打包成分发版本 (可选)**:
    为了方便分发给最终用户，你可以使用 PyInstaller 将 `gui.py` 打包成一个可执行文件。
    ```bash
    pyinstaller --onefile --windowed --name "YourAppName" gui.py
    ```

### 第二步：部署服务器 (`server.ts`) 到 Deno Deploy

1.  **创建 Deno Deploy 项目**:
    -   访问 [Deno Deploy](https://dash.deno.com/new) 并使用你的 GitHub 账户登录。
    -   创建一个新项目。
    -   将你的代码（至少包含 `server.ts`）上传到一个 GitHub 仓库，并将 Deno Deploy 项目链接到这个仓库。

2.  **设置环境变量**:
    -   在你的 Deno Deploy 项目设置中，找到 "Environment Variables" 部分。
    -   添加以下环境变量：
        -   `AES_KEY`: **必须**与你在 `gui.py` 中设置的32字节密钥完全相同。
        -   `ADMIN_PASSWORD`: 用于登录管理后台的密码。如果不设置，默认为 `admin`。建议设置为一个强密码。

3.  **获取部署URL**:
    -   部署成功后，Deno Deploy 会为你提供一个唯一的 URL，例如 `https://my-auth-server.deno.dev`。

### 第三步：最终配置客户端

1.  **更新服务器URL**:
    -   回到 `gui.py` 文件，找到 `AUTH_SERVER_URL` 常量。
    -   将其值更新为你从 Deno Deploy 获取的 URL，并确保路径为 `/auth`。
    ```python
    # file: gui.py
    AUTH_SERVER_URL = "https://my-auth-server.deno.dev/auth" 
    ```

2.  **重新打包 (如果需要)**:
    -   如果你在第一步中打包了应用，请使用更新后的 `gui.py` 重新打包。

## 如何管理授权码

我们提供了一个简单的网页管理后台来方便地增删查改授权码。

### 访问管理后台

1.  打开浏览器，访问你的 Deno Deploy URL，并在后面加上 `/admin`。
    例如：`https://my-auth-server.deno.dev/admin`
2.  输入你在 Deno Deploy 环境变量中设置的 `ADMIN_PASSWORD` 进行登录。

### 使用管理后台

-   **查看所有密钥**: 登录后，所有已添加的授权码会以列表形式展示。
-   **添加新密钥**: 在顶部的输入框中输入新的授权码，然后点击 "添加密钥"。
-   **删除密钥**: 点击对应密钥右侧的 "删除" 按钮。

### 通过命令行管理 (高级)

如果你希望通过命令行进行批量操作，仍然可以参照以下步骤：

1.  **安装 Deno**:
    如果你还没有安装 Deno，请参照 [官方文档](https://deno.land/manual/getting_started/installation) 进行安装。

2.  **设置环境变量**:
    为了让本地 Deno CLI 能够连接到正确的 Deno Deploy KV 数据库，你需要设置以下环境变量：
    -   `DENO_KV_ACCESS_TOKEN`: 在 Deno Deploy 项目的设置页面中可以找到。
    -   `DENO_KV_DATABASE_ID`: 同样在项目设置页面中可以找到。

3.  **管理命令**:

    -   **添加一个新的授权码**:
        将 `YOUR-NEW-LICENSE-KEY` 替换为你想添加的实际密钥。
        ```bash
        deno eval 'const kv = await Deno.openKv(); await kv.set(["licenses", "YOUR-NEW-LICENSE-KEY"], { created_at: new Date().toISOString() }); console.log("Done.");'
        ```

    -   **查看一个授权码**:
        ```bash
        deno eval 'const kv = await Deno.openKv(); const result = await kv.get(["licenses", "YOUR-NEW-LICENSE-KEY"]); console.log(result);'
        ```

    -   **删除一个授权码**:
        ```bash
        deno eval 'const kv = await Deno.openKv(); await kv.delete(["licenses", "YOUR-NEW-LICENSE-KEY"]); console.log("Deleted.");'
        ```

## 用户使用流程

1.  用户运行你的应用程序（打包后的 `.exe` 或直接运行 `gui.py`）。
2.  程序首次运行时，会弹出一个对话框，要求输入授权码。
3.  用户输入你提供给他们的有效授权码。
4.  程序将授权码和生成的机器码发送到服务器进行验证。
5.  验证成功后，授权码会保存在本地的 `license.json` 文件中，程序正常启动。
6.  下次启动时，程序会自动读取 `license.json` 并与服务器进行静默验证，无需用户再次输入。