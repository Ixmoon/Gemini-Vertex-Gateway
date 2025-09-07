# 智能 Gemini & Vertex AI API 网关

## 这是什么?

一个专为 Google Gemini 和 Vertex AI 服务设计的、通过**构建时配置**的**无状态** API 网关。它充当一个智能、安全的中继，旨在简化认证、管理 API 密钥和凭证，并提供智能路由——所有这些都无需数据库。

将您的请求指向此网关的统一端点（如 `/gemini`、`/vertex`）。网关会依据在构建时注入的单一配置文件，透明地处理认证（包括 Gemini 密钥轮换和 GCP 凭证轮换）、根据请求格式或模型进行路由，并将请求安全地转发给相应的 Google 服务。它还支持 WebSocket 代理和可续传文件上传等高级功能。

## 核心解决的问题

*   **密钥与凭证安全**: 防止在客户端代码中暴露 Google API 密钥或 GCP 服务账号凭证。所有机密信息在构建过程中被安全注入。
*   **简化认证**: 客户端仅需一个统一的“触发密钥”即可通过网关访问所有已配置的后端服务。
*   **配额管理**: 通过为无状态请求自动轮换 API 密钥池，有效缓解 Gemini API 的配额限制问题。
*   **可用性与重试**: 当请求失败时，自动使用池中的其他密钥或凭证进行重试，从而提高服务的可靠性。
*   **有状态操作安全**: 确保文件上传、模型微调等操作被路由到专用的、非轮换的密钥，以保证操作的一致性。

## 核心特性

*   **统一的 API 端点**: 提供 `/gemini` 和 `/vertex` 作为访问所有 Google LLM 服务的清晰、一致的入口。
*   **智能 Gemini 路由**: `/gemini` 端点能自动区分 **Gemini 原生 API** 请求（如 `/v1beta/...`）和 **OpenAI 兼容 API** 请求（如 `/v1/chat/completions`），并进行正确路由。
*   **全面的 Vertex AI 支持**: `/vertex` 端点同时支持 **Vertex AI 原生 API** 和 **OpenAI 兼容** 请求，简化集成工作。
*   **高级密钥管理**:
    *   **Gemini 密钥轮换与重试**: 对无状态请求，自动从密钥池 (`poolKeys`) 中轮换密钥，以管理配额并在失败时重试。
    *   **有状态请求安全**: 自动将有状态操作（如文件上传、微调）路由到专用的 `fallbackKey`，确保会话一致性。
    *   **GCP 凭证轮换**: 对 Vertex AI 的调用，自动轮换 GCP 服务账号凭证池，增强安全性与可用性。
*   **高级功能支持**:
    *   **透明的文件上传处理**: 通过重写上传 URL，正确处理 Gemini 的可续传文件上传工作流。
    *   **原生 WebSocket 代理**: 为 Gemini 的双向流式端点（如音乐生成）提供原生支持，这是许多代理所不具备的功能。
*   **无状态与易于部署**: 无需数据库或外部存储。配置在构建时被打包，使得部署和扩展极为简单。

## 适合谁用?

*   基于 Google Gemini 或 Vertex AI API 构建应用的开发者。
*   寻求集中化、安全且简化地管理 Google API 密钥和 GCP 凭证的团队。
*   希望通过自动重试和密钥轮换来提高 LLM API 调用可靠性和可用性的用户。

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

*   **`poolKeys` (用于 Gemini)**: 存放 Google API 密钥的池，用于 Gemini API 无状态请求的轮换和重试。
    *   **格式**: 字符串数组, `["g_api_key1", "g_api_key2"]`

*   **`fallbackKey` & `fallbackModels` (可选但推荐)**:
    *   `fallbackKey`: 一个专用的 Google API 密钥。**至关重要的是，此密钥用于所有有状态请求（如文件上传或微调）以确保会话一致性。** 它也用于 `fallbackModels` 中列出的模型。
    *   `fallbackModels`: 一个模型名称列表。对这些模型的请求将被直接路由到 `fallbackKey`。
    *   **格式**: `fallbackKey` 为字符串或 `null`；`fallbackModels` 为字符串数组。

*   **`gcpCredentials` (用于 Vertex AI)**: 存放一个或多个 GCP 服务账号凭证 (JSON 对象) 的数组。每次请求都会轮换使用。
    *   **格式**: `[{...cred1...}, {...cred2...}]`

*   **`gcpDefaultLocation` (用于 Vertex AI)**: GCP 项目的区域。
    *   **格式**: 字符串, 例如 `"us-central1"`。
    *   **默认值**: `"global"`

*   **`apiRetryLimit` (可选)**: 在调用失败时，从池 (`poolKeys` 或 `gcpCredentials`) 中最多尝试多少个不同的密钥/凭证。
    *   **格式**: 数字, 例如 `3`。
    *   **默认值**: `1`

## 如何调用 API

### 调用 Vertex AI (通过 `/vertex`)

1.  **构造 URL**: `https://<你的网关网址>/vertex/<原始 Vertex AI API 路径>`
    *   *原生示例*: `.../vertex/v1/projects/.../locations/.../publishers/google/models/gemini-1.0-pro:streamGenerateContent`
    *   *OpenAI 兼容示例*: `.../vertex/openai/v1/chat/completions`
2.  **添加认证**: 请求头加入 `Authorization: Bearer <你的触发密钥>`。
3.  **发送请求**: 网关将使用轮换的 GCP 凭证进行认证并转发。

### 调用 Google Gemini (通过 `/gemini`)

此端点智能处理多种请求类型：

*   **原生 API 请求**:
    *   **URL**: `https://<你的网关网址>/gemini/v1beta/models/gemini-pro:generateContent`
*   **OpenAI 兼容请求**:
    *   **URL**: `https://<你的网关网址>/gemini/v1/chat/completions`
*   **文件上传 (有状态)**:
    *   **URL**: `https://<你的网关网址>/gemini/upload/v1beta/files`
*   **WebSocket (有状态)**:
    *   **URL**: `wss://<你的网关网址>/ws/google.ai.generativelanguage.v1alpha.GenerativeService/BidiGenerateMusic`

**认证**: 请求头加入 `Authorization: Bearer <你的触发密钥>`。网关将根据请求类型自动选择正确的密钥（从密钥池或备用密钥中选择）。

### 调用其他服务 (通过自定义前缀)

1.  **构造 URL**: `https://<你的网关网址>/<你自定义的前缀>/<目标服务路径>`
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

## 更新机密与重新部署

当您在本地修改了 `secrets.config.json` 文件后，需要将这些更改同步到 GitHub Secrets 并触发一次新的部署。我们提供了一个批处理脚本来自动化这个流程。

### 使用 `redeploy.bat` 脚本

此脚本专为 Windows 用户设计，旨在简化更新和重新部署的流程。

1.  **前提条件: GitHub CLI**
    *   您必须已安装 [GitHub CLI](https://cli.github.com/)。
    *   您必须已通过 CLI 进行了身份验证。如果尚未操作，请在终端中运行 `gh auth login` 并按照提示完成登录。

2.  **如何运行**
    *   在项目根目录，直接运行 `redeploy.bat` 文件即可。您可以在终端（如 CMD 或 PowerShell）中输入 `./redeploy.bat` 来执行，或者在 Windows 文件资源管理器中直接双击它。

3.  **脚本功能**
    该脚本会自动完成两个关键步骤：
    *   读取您本地的 `secrets.config.json` 文件，并安全地更新您 GitHub 仓库中的 `SECRETS_CONFIG_JSON` 机密信息。
    *   接着，它会触发一次 `deploy.yml` GitHub Actions 工作流的新运行，该工作流将使用您刚刚更新的机密来构建和部署您的网关。

您可以在 GitHub 仓库的 "Actions" 选项卡中查看到新的部署进度。
