# 智能 Gemini & Vertex AI API 网关

## 这是什么?

一个无状态、透明的 API 网关，旨在简化对 Google Gemini 和 Vertex AI 服务的访问。它的核心是一个简单、安全且智能的**透传代理**。

项目的核心理念是**客户端自由**。您可以使用现有的 Gemini 客户端 (Google AI SDK) 或 OpenAI 兼容客户端，只需将请求指向此网关，即可无缝工作。网关会在后台处理复杂的认证（为 Gemini 轮换 API 密钥，为 Vertex AI 轮换 GCP 凭证），因此您只需要一个简单的密钥即可访问所有服务。

## 核心解决的问题

*   **简化 Vertex AI 认证**: 像使用 Gemini API 一样，仅通过一个 API 密钥就能轻松使用 Vertex AI，无需在客户端处理复杂的 GCP 服务账号认证。
*   **密钥与凭证安全**: 防止在客户端代码中暴露您的 Google API 密钥或 GCP 服务账号凭证。
*   **配额管理与可靠性**: 通过自动轮换密钥/凭证池和重试失败请求，有效缓解 API 配额限制并提高服务可靠性。
*   **有状态操作安全**: 保证需要保持一致性的操作（如文件上传或 WebSocket 会话）始终被路由到单个专用的 API 密钥。

## 核心特性

*   **客户端自由**: `/gemini` 和 `/vertex` 两个端点均可接受 **Gemini API 格式**和 **OpenAI API 格式**的请求。您可以使用任何您喜欢的客户端。
*   **统一的端点**:
    *   `/gemini`: 代理至 Google AI Gemini API，使用轮换的 Google API 密钥池进行认证。
    *   `/vertex`: 代理至 Vertex AI API，使用轮换的 GCP 服务账号凭证池进行认证。
*   **高级密钥管理**: 自动为无状态请求使用轮换密钥池 (`poolKeys`)，并为有状态操作（文件上传、WebSocket）使用专用密钥 (`fallbackKey`)，以确保稳定性。
*   **通用透传代理**: `apiMappings` 功能允许您为任何其他 API（如 Anthropic Claude 等）配置简单的透明代理，实现统一的路径路由。
*   **无状态与易于部署**: 无需数据库。配置在构建时被打包，使得部署和扩展极为简单。

## 适合谁用?

*   希望在客户端代码中免除 GCP 认证流程，轻松使用 Vertex AI 的开发者。
*   寻求集中化、安全且简化地管理 Google API 密钥和 GCP 凭证的团队。
*   希望通过自动重试和密钥轮换来提高 LLM API 调用可靠性的用户。

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

所有配置都通过 `secrets.config.json` 文件进行管理。在部署时，该文件的内容需要被设置到 GitHub Repository Secret 中。

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
  "apiMappings": {}
}
```

### 字段说明

*   **`triggerKeys` (必需)**: 网关的“通行证”数组。您的客户端将使用其中一个密钥（而不是真实的 API 密钥）来激活网关的智能功能。
    *   **格式**: `["gateway_key_1", "gateway_key_2"]`

*   **`poolKeys` (用于 `/gemini`)**: 一个由您真实的 Google API 密钥组成的池。`/gemini` 端点将使用此池进行密钥轮换。
    *   **格式**: `["google_api_key_1", "google_api_key_2"]`

*   **`fallbackKey` (有状态操作必需)**: 一个专用的、固定的 Google API 密钥。网关会**自动**将任何有状态请求（如文件上传、WebSocket）路由到此密钥，以保证会话的一致性。
    *   **格式**: 单个字符串, 例如 `"dedicated_google_api_key"`

*   **`fallbackModels` (可选)**: 一个模型名称列表。强制对这些模型的请求始终使用更可靠的 `fallbackKey`。
    *   **格式**: `["gemini-1.5-pro-latest"]`

*   **`gcpCredentials` (用于 `/vertex`)**: 一个 GCP 服务账号凭证对象 (JSON 格式) 的数组。`/vertex` 端点将使用此池进行凭证轮换。
    *   **格式**: `[{...cred1...}, {...cred2...}]`

*   **`gcpDefaultLocation` (用于 `/vertex`)**: GCP 项目的默认区域。
    *   **格式**: 字符串, 例如 `"us-central1"`。默认值: `"global"`

*   **`apiRetryLimit` (可选)**: 在调用失败时，从池中最多尝试多少个不同的密钥/凭证。
    *   **格式**: 数字, 例如 `3`。默认值: `1`

*   **`apiMappings` (可选)**: 为任何其他 API 定义简单的透明透传代理。键是路径前缀，值是目标基础 URL。
    *   **示例**: `{ "/claude": "https://api.anthropic.com" }`

## 如何使用网关

您可以使用现有的 **Gemini 客户端** 或 **OpenAI 客户端**。只需在客户端配置中更改 API 密钥和接口地址即可。

### 使用 `/gemini` 端点
*   **功能**: 使用您轮换的 `poolKeys` 代理到 Google AI Gemini API。
*   **适用客户端**: Gemini 客户端, OpenAI 客户端。
*   **如何使用**:
    *   将 **API 密钥** 设置为您的 `triggerKey`。
    *   将 **接口地址 / Base URL** 设置为 `https://<你的网关网址>/gemini`。

### 使用 `/vertex` 端点
*   **功能**: 使用您轮换的 `gcpCredentials` 代理到 Vertex AI API，简化认证流程。
*   **适用客户端**: Gemini 客户端, OpenAI 客户端。
*   **如何使用**:
    *   将 **API 密钥** 设置为您的 `triggerKey`。
    *   将 **接口地址 / Base URL** 设置为 `https://<你的网关网址>/vertex`。

### 使用自定义 `apiMappings` (例如 `/claude`)
*   **功能**: 一个简单的透传代理，将请求转发到您定义的目标 URL。
*   **适用客户端**: 任何与目标 API 匹配的客户端 (例如 Anthropic 的 SDK)。
*   **如何使用**:
    *   将 **接口地址 / Base URL** 设置为 `https://<你的网关网址>/claude`。
    *   认证信息会直接透传，因此请根据目标服务的要求在客户端中配置 API 密钥。

## (可选) 本地运行

1.  **安装 Deno**: 参考 [Deno 官网](https://deno.land/)。
2.  **创建配置文件**: 在项目根目录创建一个 `secrets.config.json` 文件并填入配置。
3.  **生成配置模块**: `deno run -A build.ts`
4.  **运行服务**: `deno run --allow-net ./src/deno_index.ts`
5.  **访问**: 服务默认运行在 `http://localhost:8000`。

## 更新机密与重新部署

当您在本地修改了 `secrets.config.json` 文件后，可以使用提供的脚本来同步更改并重新部署。

### 使用 `redeploy.bat` 脚本 (Windows)

1.  **前提条件**: 安装 [GitHub CLI](https://cli.github.com/) 并通过 `gh auth login` 登录。
2.  **运行**: 直接双击 `redeploy.bat` 文件，或在终端中运行 `./redeploy.bat`。
3.  **功能**: 脚本会自动将您本地的配置安全地更新到 GitHub 的 `SECRETS_CONFIG_JSON`，并触发一次新的部署工作流。您可以在仓库的 "Actions" 选项卡中查看部署进度。