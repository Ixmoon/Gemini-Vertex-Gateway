# 智能 LLM API 网关

## 这是什么?

一个为 Google Gemini 和 Vertex AI API 设计的、通过**环境变量**配置的无状态 API 网关。它旨在简化访问、认证和密钥管理，提升安全性和可用性。

此网关充当一个智能中转站。将发往 Google 的请求指向此网关配置的路径（如 `/gemini` 或 `/vertex`），网关会依据环境变量配置，自动处理认证（包括 Gemini Key 轮换和 GCP 凭证轮换）、根据模型名称或路径进行智能路由，并将请求安全地转发给 Google 的相应服务。

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
*   **增强安全性**: 将真实的 Google API 密钥和 GCP 服务账号凭证通过环境变量安全地注入到后端。
*   **统一入口与简化认证**: 使用 `/gemini`, `/vertex` 等作为访问 Google LLM 服务的统一路径，客户端仅需管理和使用简单的“触发密钥”。
*   **无状态与易于部署**: 无需数据库或外部存储，所有配置均来自环境变量，极大简化了部署和扩展。

## 适合谁用?

*   需要调用 Google Gemini 或 Vertex AI API 的开发者。
*   寻求简化和保护 Google API 密钥及 GCP 凭证管理的个人或团队。
*   希望提高 Google LLM API 调用稳定性和可用性的用户。
*   偏好通过环境变量进行部署和配置的用户。

## 快速部署 (推荐: Deno Deploy)

部署到 Deno Deploy 是最简单的方式。

1.  **准备代码**: Fork 本项目或将代码托管在你的 GitHub 仓库。
2.  **访问 Deno Deploy**: 前往 [Deno Deploy 网站](https://deno.com/deploy) 并使用 GitHub 账号登录。
3.  **创建项目**: 点击 "New Project"。
4.  **关联仓库**: 选择包含此网关代码的 GitHub 仓库。
5.  **选择入口文件**: 指定入口文件为 `src/deno_index.ts`。
6.  **添加环境变量**: 在 "Environment Variables" 部分，添加下文“如何配置”中描述的变量。
7.  **部署**: 点击 "Link" / "Deploy"。
8.  **获取你的专属网址**: 部署成功后，记录下你的部署网址 (例如 `https://<你的项目名>.deno.dev`)。

*注意: Deno Deploy 免费套餐有资源限制。*

## 如何配置 (通过环境变量)

通过设置环境变量来配置网关的所有功能。

*   **`API_MAPPINGS` (必需)**: 定义路径前缀到目标 URL 的映射。
    *   **格式**: `/<prefix1>:<target_url1>,/<prefix2>:<target_url2>`
    *   **示例**: `/gemini:https://generativelanguage.googleapis.com,/other:https://api.example.com`
    *   **说明**: 必须包含一个用于 Gemini 的映射。`/vertex` 是一个内置的特殊路径，无需在此配置。

*   **`TRIGGER_KEYS` (必需)**: 客户端调用网关时所需的“通行证”，可以设置多个。
    *   **格式**: `<key1>,<key2>,...`
    *   **示例**: `my_secret_key,another_key`

*   **`POOL_KEYS` (用于 Gemini)**: 存放 Google API 密钥的池，用于 Gemini API 的轮换和重试。
    *   **格式**: `<g_api_key1>,<g_api_key2>,...`

*   **`FALLBACK_KEY` & `FALLBACK_MODELS` (可选)**: 设置一个专用的 Google API 密钥，并指定哪些模型的请求应直接路由至此密钥。
    *   `FALLBACK_KEY`: **格式**: `<single_g_api_key>`
    *   `FALLBACK_MODELS`: **格式**: `<model1>,<model2>,...` (例如 `gemini-pro,gemini-ultra`)

*   **`GCP_CREDENTIALS` (用于 Vertex AI)**: 存放一个或多个 GCP 服务账号凭证 (JSON 格式)。
    *   **格式**: `[{...gcp_cred_json...}]` (单个凭证) 或 `[[{...cred1...},{...cred2...}]]` (多个凭证的数组)。
    *   **强烈建议**在 Deno Deploy 等平台将此 JSON 内容设为 "Secret" 类型的环境变量。

*   **`GCP_DEFAULT_LOCATION` (用于 Vertex AI)**: GCP 项目的区域。
    *   **格式**: 字符串，例如 `us-central1` 或 `global`。
    *   **默认值**: `global`

*   **`API_RETRY_LIMIT` (可选)**: 在使用主密钥池或 GCP 凭证调用失败时，最多尝试多少个不同的密钥/凭证。
    *   **格式**: 数字字符串，例如 `3`。
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
2.  **创建 `.env` 文件**: 在项目根目录创建一个 `.env` 文件并填入上述环境变量。
3.  **加载环境变量并运行**:
    ```bash
    # 需要先安装 deno_dotenv
    deno install -A -r https://deno.land/x/dotenv/load.ts
    # 运行
    deno run --allow-net --allow-env ./src/deno_index.ts
    ```
4.  **访问**: 服务默认运行在 `http://localhost:8080`。

---

祝使用愉快！