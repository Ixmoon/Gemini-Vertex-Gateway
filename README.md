# 智能 LLM API 网关

## 这是什么?

一个为 Google Gemini 和 Vertex AI API 设计的智能 API 网关，旨在简化访问、认证和密钥管理，提升安全性和可用性。

此网关充当一个智能中转站。将发往 Google Gemini 或 Vertex AI 的请求指向此网关的 `/gemini` 路径，网关会依据配置，自动处理认证（包括 Gemini Key 轮换和 GCP 凭证轮换）、根据模型名称进行智能路由，并将请求安全地转发给 Google 的相应服务。

同时，它也提供基础的 HTTP 代理功能，可配置其他路径前缀以转发请求至任意网络服务，但这部分功能不包含下述为 Google LLM 设计的高级管理特性。

## 核心解决 (针对 Google LLM API)

*   **密钥/凭证安全**: 避免在客户端或应用程序代码中暴露 Google API 密钥或 GCP 服务账号凭证。
*   **简化认证**: 客户端仅需使用统一的“触发密钥”即可通过网关访问。
*   **Gemini 密钥管理**: 通过密钥池实现 Gemini API Key 的自动轮换和失败重试，应对额度限制和单点故障。
*   **Vertex AI 凭证管理**: 实现 GCP 服务账号凭证的自动轮换，简化 Vertex AI 认证流程。
*   **智能路由**: 根据模型名称自动将请求路由至 Gemini API、Vertex AI 端点或使用指定的 Fallback Key。

## 核心优势 (针对 `/gemini` 端点)

本项目通过 `/gemini` 路径为 Google Gemini 和 Vertex AI API 调用提供以下核心优势：

*   **模型驱动的智能路由**:
    *   根据模型名称自动识别并路由到 **Vertex AI** 端点，使用轮换的 GCP 服务账号凭证进行认证。
    *   根据模型名称将请求路由到指定的 **Fallback Key**。此功能常用于将特定请求（如使用付费模型、需要特殊权限的模型）导向专用密钥，从而允许密钥池处理其他请求（如使用免费模型），以实现成本优化或精细化访问控制。
*   **Gemini 密钥轮换与重试**: 对于发往 Gemini API 的请求（未被 Fallback Key 或 Vertex AI 路由规则匹配时），自动从“主密钥池”中轮流选择 API Key，并在调用失败时根据配置尝试池中其他密钥。
*   **增强安全性**: 将真实的 Google API 密钥和 GCP 服务账号凭证安全存储于后端 (Deno KV)。
*   **统一入口与简化认证**: 使用 `/gemini` 作为访问 Google LLM 服务的统一路径，客户端仅需管理和使用简单的“触发密钥”。
*   **网页配置**: 提供直观的 Web UI ([`/manage`](src/manage.html:1)) 进行策略配置。

**(次要功能)**: 支持通过配置**其他 API 路径映射**，将请求基础地转发到任意 HTTP/S 服务，但这部分功能**不提供**上述密钥轮换、凭证轮换、模型路由等高级特性。

## 适合谁用?

*   需要调用 Google Gemini 或 Vertex AI API 的开发者。
*   寻求简化和保护 Google API 密钥及 GCP 凭证管理的个人或团队。
*   希望提高 Google LLM API 调用稳定性和可用性的用户。
*   偏好通过 Web 界面直观配置复杂调用策略的用户。

## 快速部署 (推荐: Deno Deploy)

部署到 Deno Deploy 是最简单的方式。

1.  **准备代码**: 将项目代码托管在 GitHub 仓库。
2.  **访问 Deno Deploy**: 前往 [Deno Deploy 网站](https://deno.com/deploy) 并使用 GitHub 账号登录。
3.  **创建项目**: 点击 "New Project"。
4.  **关联仓库**: 选择包含此网关代码的 GitHub 仓库。
5.  **选择入口文件**: 指定入口文件为 `src/deno_index.ts`。
6.  **部署**: 点击 "Link" / "Deploy"。
7.  **获取你的专属网址**: 部署成功后，记录下你的部署网址 (例如 `https://<你的项目名>.deno.dev`)。

*注意: Deno Deploy 免费套餐有资源限制。*

## 如何配置 (使用 `/manage` 网页)

通过访问 `https://<你的专属网址>/manage` 进行配置。

1.  **访问与登录**: 首次访问需设置管理员密码 (至少8位)。
2.  **核心配置项详解**:
    *   **API 路径映射 (API Path Mappings)**:
        *   **`/gemini` (必需)**: 启用 Google LLM 高级功能的入口。**必须添加**前缀为 `/gemini` 的映射，目标 URL 指向 Google API 基础地址 (例如 `https://generativelanguage.googleapis.com`)。发往 `<你的网址>/gemini/...` 的请求将由网关智能处理。
        *   **其他前缀 (可选)**: 添加其他前缀可配置基础 HTTP 代理，转发到任意 URL，**不应用**高级功能。
    *   **触发密钥 (Trigger Keys)**: **(必需)** 添加客户端调用网关（任何路径）时所需的“通行证”。
    *   **主密钥池 (Pool Keys)**: **(用于 `/gemini` 的 Gemini 请求)** 存放 Google API 密钥。**仅用于**处理目标为 Gemini API 的 `/gemini` 请求（当模型未匹配 Fallback 或 Vertex 规则时）。支持密钥轮换和重试。
    *   **指定密钥 (Fallback Key) & 指定密钥触发模型 (Fallback Models)**: **(用于 `/gemini` 的特定模型请求)** 设置一个专用 Google API 密钥，并指定哪些模型名称的请求（通过 `/gemini`）应**直接路由至此密钥**。常用于将付费模型或特定功能模型的请求导向指定密钥，与密钥池形成策略组合。此规则优先于主密钥池。
    *   **Vertex AI 模型列表 & GCP 设置**: **(用于 `/gemini` 的 Vertex AI 请求)** 添加需路由到 Vertex AI 的模型名称，并配置 GCP 服务账号凭证（可配置多个以轮换）。当 `/gemini` 请求的模型在此列表时，将使用 GCP 凭证认证并**路由到 Vertex AI**。
    *   **API 重试次数 (API Retry Limit)**: **(用于 `/gemini` 的 Gemini 密钥池)** 设置在使用主密钥池调用 Gemini API 失败时，最多尝试多少个不同的池内密钥。
3.  **保存配置**: 修改后务必点击相应区域的“保存”按钮。

## 如何调用 API

### 调用 Google Gemini / Vertex AI (通过 `/gemini`)

利用网关的智能特性，通过 `/gemini` 路径发起请求：

1.  **构造 URL**: `https://<你的专属网址>/gemini/<原始 Google API 路径>`
    *   *示例 (Gemini)*: `https://<你的网址>/gemini/v1beta/models/gemini-pro:generateContent`
2.  **添加认证**: 请求头加入 `Authorization: Bearer <你的触发密钥>`。
3.  **发送请求**: 网关将根据模型和配置自动处理认证与路由。

### 调用其他服务 (通过自定义前缀)

1.  **构造 URL**: `https://<你的专属网址>/<你自定义的前缀>/<目标服务路径>`
2.  **添加认证**: 请求头加入 `Authorization: Bearer <你的触发密钥>`。
3.  **发送请求**: 网关执行基础 URL 转发。

## (可选) 本地运行

1.  **安装 Deno**: 参考 [Deno 官网](https://deno.land/)。
2.  **运行**:
    ```bash
    deno run --allow-net --allow-read --allow-env --allow-write ./src/deno_index.ts
    ```
3.  **访问**: 服务运行在 `http://localhost:8080`。配置: `http://localhost:8080/manage`。API 调用: `http://localhost:8080/<前缀>/...`。

---

祝使用愉快！