# 智能 LLM API 网关

## 这是什么?

一个为 Google Gemini 和 Vertex AI API 设计的、通过**构建时生成的配置文件**配置的无状态 API 网关。它旨在简化访问、认证和密钥管理，提升安全性和可用性。

此网关充当一个智能中转站。将发往 Google 的请求指向此网关配置的路径（如 `/gemini` 或 `/vertex`），网关会依据配置文件，自动处理认证（包括 Gemini Key 轮换和 GCP 凭证轮换）、根据模型名称或路径进行智能路由，并将请求安全地转发给 Google 的相应服务。

同时，它也提供基础的 HTTP 代理功能，可配置其他路径前缀以转发请求至任意网络服务。

## 核心解决 (针对 Google LLM API)

*   **密钥/凭证安全**: 避免在客户端或应用代码中暴露 Google API 密钥或 GCP 服务账号凭证。
*   **简化认证**: 客户端仅需使用统一的“触发密钥”即可通过网关访问。
*   **Gemini 密钥管理**: 通过密钥池实现 Gemini API Key 的自动轮换和失败重试，应对额度限制。
*   **Vertex AI 凭证管理**: 实现 GCP 服务账号凭证的自动轮换，简化 Vertex AI 认证。
*   **智能路由**:
    *   通过专用路径 `/vertex` 直达 Vertex AI。
    *   通过 `/gemini` 路径，根据请求格式自动适配 **Gemini 原生 API** 或 **OpenAI 兼容 API**。
    *   根据模型名称将请求路由至指定的 **Fallback Key**。

## 核心优势

*   **OpenAI API 兼容层**: 通过 `/gemini` 路径，可直接使用兼容 OpenAI `v1/chat/completions` 等接口的客户端访问 Gemini 模型。
*   **专用 Vertex AI 端点**: 使用 `/vertex` 路径，为 Vertex AI 提供专属、清晰的请求路由。
*   **模型驱动的路由**:
    *   根据模型名称将请求路由到指定的 **Fallback Key**。此功能常用于将特定请求（如使用付费模型）导向专用密钥，实现成本优化或精细化访问控制。
*   **Gemini 密钥轮换与重试**: 对于发往 Gemini API 的请求，自动从“主密钥池”中轮流选择 API Key，并在调用失败时根据配置尝试池中其他密钥。
*   **增强安全性**: 将真实的 Google API 密钥和 GCP 服务账号凭证与应用代码解耦，通过在构建时注入的方式保证安全。
*   **统一入口与简化认证**: 使用 `/gemini`, `/vertex` 等作为访问 Google LLM 服务的统一路径，客户端仅需管理和使用简单的“触发密钥”。
*   **无状态与易于部署**: 无需数据库或外部存储，配置在构建时被打包，极大简化了部署和扩展。

## 适合谁用?

*   需要调用 Google Gemini 或 Vertex AI API 的开发者。
*   寻求简化和保护 Google API 密钥及 GCP 凭证管理的个人或团队。
*   希望提高 Google LLM API 调用稳定性和可用性的用户。

## 快速部署 (推荐: 通过 GitHub Actions 部署到 Deno Deploy)

本项目配置了通过 GitHub Actions 自动部署。

1.  **Fork 仓库**: Fork 本项目到你的 GitHub 账号。
2.  **创建 Deno Deploy 项目**:
    *   前往 [Deno Deploy 网站](https://deno.com/deploy) 并使用 GitHub 账号登录。
    *   点击 "New Project"，但**选择 "Empty" 项目**，不要关联 Git 仓库。
    *   记录下你的项目名称 (例如 `funky-lion-42`)。
3.  **在 GitHub 中设置 Secrets**:
    *   在你的 Fork 后的仓库中，进入 `Settings` > `Secrets and variables` > `Actions`。
    *   创建一个名为 `SECRETS_CONFIG_JSON` 的 Repository Secret。
    *   将你的 `secrets.config.json` 文件的**全部内容**作为这个 Secret 的值粘贴进去。
4.  **更新部署工作流**:
    *   打开 `.github/workflows/deploy.yml` 文件。
    *   将 `project: "your-deno-project-name"` 中的 `"your-deno-project-name"` 替换为你在 Deno Deploy 上获取的项目名称。
5.  **触发部署**:
    *   提交并推送你的修改到 `main` 分支。
    *   GitHub Actions 将自动运行，构建并部署你的网关。
6.  **获取你的专属网址**: 部署成功后，你可以在 Deno Deploy 仪表盘上找到你的项目网址。

## 如何配置 (通过 `secrets.config.json`)

所有配置都通过项目根目录下的 `secrets.config.json` 文件进行管理。在部署时，该文件的内容需要被设置到 GitHub Repository Secret 中。

**重要**: 这个文件不应被提交到 Git。`.gitignore` 中已包含此规则。

### 配置文件结构

```json
{
  "gcpCredentials": [],
  "poolKeys": [],
  "triggerKeys": [],
  "fallbackKey": null,
  "fallbackModels": [],
  "apiRetryLimit": 1,
  "gcpDefaultLocation": "global",
  "apiMappings": {
    "/gemini": "https://generativelanguage.googleapis.com"
  }
}
```

### 字段说明

*   **`apiMappings` (必需)**: 定义路径前缀到目标 URL 的映射。
    *   **示例**: `"apiMappings": { "/gemini": "https://generativelanguage.googleapis.com", "/other": "https://api.example.com" }`
    *   **说明**: 必须包含一个用于 Gemini 的映射。`/vertex` 是一个内置的特殊路径，无需在此配置。

*   **`triggerKeys` (必需)**: 客户端调用网关时所需的“通行证”列表。
    *   **格式**: 字符串数组, `["key1", "key2"]`

*   **`poolKeys` (用于 Gemini)**: 存放 Google API 密钥的池，用于 Gemini API 的轮换和重试。
    *   **格式**: 字符串数组, `["g_api_key1", "g_api_key2"]`

*   **`fallbackKey` & `fallbackModels` (可选)**: 设置一个专用的 Google API 密钥，并指定哪些模型的请求应直接路由至此密钥。
    *   `fallbackKey`: **格式**: 单个字符串或 `null`
    *   `fallbackModels`: **格式**: 字符串数组, `["gemini-pro", "gemini-ultra"]`

*   **`gcpCredentials` (用于 Vertex AI)**: 存放一个或多个 GCP 服务账号凭证 (JSON 对象) 的数组。
    *   **格式**: `[{...cred1...}, {...cred2...}]`

*   **`gcpDefaultLocation` (用于 Vertex AI)**: GCP 项目的区域。
    *   **格式**: 字符串, 例如 `"us-central1"`。
    *   **默认值**: `"global"`

*   **`apiRetryLimit` (可选)**: 在使用主密钥池或 GCP 凭证调用失败时，最多尝试多少个不同的密钥/凭证。
    *   **格式**: 数字, 例如 `3`。
    *   **默认值**: `1`

## 如何调用 API

### 调用 Vertex AI (通过 `/vertex`)

1.  **构造 URL**: `https://<你的专属网址>/vertex/<原始 Vertex AI API 路径>`
    *   *示例*: `https://<你的网址>/vertex/v1/chat/completions` (使用 OpenAI 兼容模式)
2.  **添加认证**: 请求头加入 `Authorization: Bearer <你的触发密钥>`。
3.  **发送请求**: 网关将使用轮换的 GCP 凭证进行认证并转发。

### 调用 Google Gemini (通过 `/gemini`)

此端点智能处理两种请求：

*   **原生 API 请求**: 路径匹配 `/v1beta/**`。
    *   **URL**: `https://<你的网址>/gemini/v1beta/models/gemini-pro:generateContent`
*   **OpenAI 兼容请求**: 路径匹配 `/v1/**` 或其他非原生路径。
    *   **URL**: `https://<你的网址>/gemini/v1/chat/completions`

**认证**: 请求头加入 `Authorization: Bearer <你的触发密钥>`。网关将根据模型和密钥池配置自动处理。

### 调用其他服务 (通过自定义前缀)

1.  **构造 URL**: `https://<你的专属网址>/<你自定义的前缀>/<目标服务路径>`
2.  **添加认证**: 请求头加入 `Authorization: Bearer <你的触发密钥>`。
3.  **发送请求**: 网关执行基础 URL 转发。

## (可选) 本地运行

1.  **安装 Deno**: 参考 [Deno 官网](https://deno.land/)。
2.  **创建配置文件**: 在项目根目录创建一个 `secrets.config.json` 文件，并填入你的配置。
3.  **生成配置模块**: 运行构建脚本来生成 `src/config_data.ts`。
    ```bash
    deno run -A build.ts
    ```
4.  **运行服务**:
    ```bash
    deno run --allow-net ./src/deno_index.ts
    ```
5.  **访问**: 服务默认运行在 `http://localhost:8000`。

---

祝使用愉快！
## 更新机密与重新部署

当您在本地修改了 `secrets.config.json` 文件后，需要将这些更改同步到 GitHub Secrets 并触发一次新的部署。我们提供了一个批处理脚本来自动化这个流程。

### 使用 `redeploy.bat` 脚本

1.  **确保 GitHub CLI 已安装并登录**
    *   如果您尚未安装 GitHub CLI，或者在终端中运行 `gh` 命令时提示找不到命令，请参考[官方文档](https://cli.github.com/)进行安装和配置。
    *   确保您已经通过 `gh auth login` 成功登录。

2.  **运行脚本**
    *   在项目根目录，直接运行 `redeploy.bat` 文件。
    *   您可以在 CMD 或 PowerShell 终端中执行 `./redeploy.bat`，或者直接在文件资源管理器中双击它。

脚本会自动完成以下两件事：
1.  将您本地 `secrets.config.json` 的内容更新到 GitHub 仓库中名为 `SECRETS_CONFIG_JSON` 的机密。
2.  触发一次新的部署工作流，该工作流将使用您刚刚更新的机密。

您可以在 GitHub 仓库的 "Actions" 选项卡中查看到新的部署进度。