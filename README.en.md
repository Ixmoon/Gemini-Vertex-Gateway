# Intelligent API Gateway for Google Gemini & Vertex AI

## What is this?

A stateless, build-time configured API gateway designed specifically for Google's Gemini and Vertex AI services. It acts as a smart, secure relay that simplifies authentication, manages API keys and credentials, and provides intelligent routing—all without needing a database.

Direct your requests to this gateway's unified endpoints (e.g., `/gemini`, `/vertex`). Based on a single configuration file injected at build time, the gateway transparently handles authentication (including Gemini Key rotation and GCP credential rotation), routes requests based on their format or model, and securely forwards them to the appropriate Google service. It also supports advanced features like WebSocket proxying and resumable file uploads.

## Core Problems Solved

*   **Key & Credential Security**: Prevents exposure of Google API keys or GCP service account credentials in client-side code. Secrets are injected securely during the build process.
*   **Simplified Authentication**: Clients only need a single, unified "trigger key" to access all configured backend services through the gateway.
*   **Quota Management**: Mitigates Gemini API quota limits by automatically rotating through a pool of API keys for stateless requests.
*   **Availability & Retries**: Improves service reliability by automatically retrying failed requests with different keys or credentials from the pool.
*   **Stateful Operation Safety**: Ensures operations like file uploads or model fine-tuning are handled consistently by routing them to a dedicated, non-rotating key.

## Core Features

*   **Unified Endpoints**: Provides `/gemini` and `/vertex` as clean, consistent entry points for all Google LLM services.
*   **Intelligent Gemini Routing**: The `/gemini` endpoint automatically distinguishes between **Gemini Native API** requests (e.g., `/v1beta/...`) and **OpenAI-Compatible API** requests (e.g., `/v1/chat/completions`), routing them correctly.
*   **Comprehensive Vertex AI Support**: The `/vertex` endpoint supports both **Vertex AI Native API** and **OpenAI-Compatible** requests, simplifying integration.
*   **Advanced Key Management**:
    *   **Gemini Key Rotation & Retry**: For stateless requests, automatically rotates keys from a pool (`poolKeys`) to manage quotas and retries on failure.
    *   **Stateful Request Safety**: Automatically routes stateful operations (file uploads, fine-tuning) to a dedicated `fallbackKey` to ensure consistency.
    *   **GCP Credential Rotation**: For Vertex AI, automatically rotates through a pool of GCP service account credentials for enhanced security and availability.
*   **Advanced Feature Support**:
    *   **Transparent File Uploads**: Correctly handles Gemini's resumable file upload workflow by rewriting upload URLs.
    *   **Native WebSocket Proxy**: Provides native support for Gemini's bidirectional streaming endpoints (e.g., for music generation), a feature many proxies lack.
*   **Stateless & Easy Deployment**: Requires no database or external storage. Configuration is bundled at build time, making deployment and scaling trivial.

## Who is it for?

*   Developers building applications on top of Google's Gemini or Vertex AI APIs.
*   Teams looking to centralize, secure, and simplify their Google API key and GCP credential management.
*   Users who need to improve the reliability and availability of their LLM API calls through automatic retries and key rotation.

## Quick Deployment (Recommended: Via GitHub Actions to Deno Deploy)

This project is configured for automatic deployment via GitHub Actions.

1.  **Fork the Repository**: Fork this project to your GitHub account.
2.  **Create a Deno Deploy Project**:
    *   Go to the [Deno Deploy website](https://deno.com/deploy) and log in with your GitHub account.
    *   Click "New Project" and select an **"Empty" project**. Do not link a Git repository.
    *   Take note of your project name (e.g., `funky-lion-42`).
3.  **Set up GitHub Secrets**:
    *   In your forked repository, go to `Settings` > `Secrets and variables` > `Actions`.
    *   Create a new Repository Secret named `SECRETS_CONFIG_JSON`.
    *   Paste the **entire content** of your `secrets.config.json` file as the value for this secret.
4.  **Update the Deployment Workflow**:
    *   Open the `.github/workflows/deploy.yml` file.
    *   Replace `"your-deno-project-name"` in `project: "your-deno-project-name"` with the project name you got from Deno Deploy.
5.  **Trigger Deployment**:
    *   Commit and push your changes to the `main` branch.
    *   GitHub Actions will automatically run, build, and deploy your gateway.
6.  **Get Your URL**: Find your deployment URL on your Deno Deploy project dashboard.

## How to Configure (Via `secrets.config.json`)

All configuration is managed through the `secrets.config.json` file in the project root. For deployment, the content of this file must be set as a GitHub Repository Secret.

**Important**: This file should not be committed to Git. A rule for this is already included in `.gitignore`.

### Configuration File Structure

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

### Field Descriptions

*   **`apiMappings` (Required)**: Defines mappings from path prefixes to target URLs.
    *   **Example**: `"apiMappings": { "/gemini": "https://generativelanguage.googleapis.com", "/other": "https://api.example.com" }`
    *   **Note**: Must include a mapping for Gemini. `/vertex` is a special built-in path and does not need to be configured here.

*   **`triggerKeys` (Required)**: A list of "passcodes" that clients use to call the gateway.
    *   **Format**: An array of strings, `["key1", "key2"]`

*   **`poolKeys` (For Gemini)**: A pool of Google API keys for Gemini API rotation and retries on stateless requests.
    *   **Format**: An array of strings, `["g_api_key1", "g_api_key2"]`

*   **`fallbackKey` & `fallbackModels` (Optional but Recommended)**:
    *   `fallbackKey`: A dedicated Google API key. **Crucially, this key is used for all stateful requests (like file uploads or fine-tuning) to ensure session consistency.** It's also used for models listed in `fallbackModels`.
    *   `fallbackModels`: A list of model names. Requests for these models will be routed directly to the `fallbackKey`.
    *   **Format**: `fallbackKey` is a string or `null`; `fallbackModels` is an array of strings.

*   **`gcpCredentials` (For Vertex AI)**: An array containing one or more GCP service account credential objects (JSON format). These are rotated for each request.
    *   **Format**: `[{...cred1...}, {...cred2...}]`

*   **`gcpDefaultLocation` (For Vertex AI)**: The region for your GCP project.
    *   **Format**: A string, e.g., `"us-central1"`.
    *   **Default**: `"global"`

*   **`apiRetryLimit` (Optional)**: The maximum number of different keys/credentials to try from a pool (`poolKeys` or `gcpCredentials`) upon failure.
    *   **Format**: A number, e.g., `3`.
    *   **Default**: `1`

## How to Call APIs

### Calling Vertex AI (via `/vertex`)

1.  **Construct URL**: `https://<your-gateway-url>/vertex/<original-vertex-ai-api-path>`
    *   *Native Example*: `.../vertex/v1/projects/.../locations/.../publishers/google/models/gemini-1.0-pro:streamGenerateContent`
    *   *OpenAI-Compatible Example*: `.../vertex/openai/v1/chat/completions`
2.  **Add Authentication**: Include `Authorization: Bearer <your_trigger_key>` in the request headers.
3.  **Send Request**: The gateway authenticates using rotated GCP credentials and forwards the request.

### Calling Google Gemini (via `/gemini`)

This endpoint intelligently handles multiple request types:

*   **Native API Requests**:
    *   **URL**: `https://<your-gateway-url>/gemini/v1beta/models/gemini-pro:generateContent`
*   **OpenAI-Compatible Requests**:
    *   **URL**: `https://<your-gateway-url>/gemini/v1/chat/completions`
*   **File Uploads (Stateful)**:
    *   **URL**: `https://<your-gateway-url>/gemini/upload/v1beta/files`
*   **WebSocket (Stateful)**:
    *   **URL**: `wss://<your-gateway-url>/ws/google.ai.generativelanguage.v1alpha.GenerativeService/BidiGenerateMusic`

**Authentication**: Include `Authorization: Bearer <your_trigger_key>` in the request headers. The gateway will automatically select the correct key (from the pool or the fallback key) based on the request type.

### Calling Other Services (via Custom Prefix)

1.  **Construct URL**: `https://<your-gateway-url>/<your-custom-prefix>/<target-service-path>`
2.  **Add Authentication**: Include `Authorization: Bearer <your_trigger_key>` in the request headers.
3.  **Send Request**: The gateway performs basic URL forwarding.

## (Optional) Running Locally

1.  **Install Deno**: See [Deno's official website](https://deno.land/).
2.  **Create Configuration File**: Create a `secrets.config.json` file in the project root and fill in your configuration.
3.  **Generate Configuration Module**: Run the build script to generate `src/config_data.ts`.
    ```bash
    deno run -A build.ts
    ```
4.  **Run the Service**:
    ```bash
    deno run --allow-net ./src/deno_index.ts
    ```
5.  **Access**: The service runs at `http://localhost:8000` by default.

## Updating Secrets and Redeploying

When you modify the `secrets.config.json` file locally, you need to sync these changes to GitHub Secrets and trigger a new deployment. We provide a batch script to automate this process.

### Using the `redeploy.bat` script

This script is designed for Windows users to streamline the update and redeployment process.

1.  **Prerequisites: GitHub CLI**
    *   You must have the [GitHub CLI](https://cli.github.com/) installed.
    *   You must be authenticated with the CLI. Run `gh auth login` in your terminal and follow the prompts if you haven't already.

2.  **How to Run**
    *   Simply run the `redeploy.bat` file from the project's root directory. You can do this by typing `./redeploy.bat` in a terminal (like CMD or PowerShell) or by double-clicking the file in Windows Explorer.

3.  **What It Does**
    The script automates two key steps:
    *   It reads your local `secrets.config.json` file and securely updates the `SECRETS_CONFIG_JSON` secret in your GitHub repository.
    *   It then triggers a new run of the `deploy.yml` GitHub Actions workflow, which will use the updated secret to build and deploy your gateway.

You can monitor the progress of the new deployment in the "Actions" tab of your GitHub repository.