# Intelligent LLM API Gateway

## What is this?

A stateless API gateway for Google Gemini and Vertex AI APIs, configured via a **build-time generated file**. It's designed to simplify access, authentication, and key management while enhancing security and availability.

This gateway acts as a smart relay. Direct your requests intended for Google services to the paths you configure (e.g., `/gemini` or `/vertex`). Based on your configuration file, the gateway automatically handles authentication (including Gemini Key rotation and GCP credential rotation), performs intelligent routing based on model names or paths, and securely forwards the requests to the appropriate Google service.

It also provides basic HTTP proxy functionality. You can configure other path prefixes to forward requests to any web service.

## Core Problems Solved (for Google LLM APIs)

*   **Key/Credential Security**: Avoids exposing Google API keys or GCP service account credentials in client-side or application code.
*   **Simplified Authentication**: Clients only need a unified "trigger key" to access services via the gateway.
*   **Gemini Key Management**: Addresses quota limits by implementing automatic rotation and failure retry for Gemini API Keys via a key pool.
*   **Vertex AI Credential Management**: Simplifies Vertex AI authentication through automatic rotation of GCP service account credentials.
*   **Intelligent Routing**:
    *   Provides a dedicated `/vertex` path for direct access to Vertex AI.
    *   Adapts automatically to **Gemini Native API** or **OpenAI-Compatible API** requests via the `/gemini` path.
    *   Routes requests to a specified **Fallback Key** based on the model name.

## Core Advantages

*   **OpenAI API Compatibility Layer**: Use clients compatible with OpenAI's `/v1/chat/completions` interface to access Gemini models directly through the `/gemini` path.
*   **Dedicated Vertex AI Endpoint**: Offers a clear and dedicated `/vertex` path for all Vertex AI requests.
*   **Model-Driven Routing**:
    *   Routes requests to a designated **Fallback Key** based on the model name. This is often used to direct specific requests (e.g., for paid models) to a dedicated key for cost optimization or fine-grained access control.
*   **Gemini Key Rotation & Retry**: For requests to the Gemini API, automatically selects an API Key from the "Pool Keys" in rotation and attempts retries with other keys upon failure.
*   **Enhanced Security**: Decouples your actual Google API keys and GCP service account credentials from the application code, ensuring security by injecting them at build time.
*   **Unified Entry Point & Simplified Authentication**: Uses `/gemini`, `/vertex`, etc., as unified paths for Google LLM services, requiring clients only to manage simple "trigger keys".
*   **Stateless & Easy Deployment**: Requires no database or external storage. Configuration is bundled at build time, greatly simplifying deployment and scaling.

## Who is it for?

*   Developers calling Google Gemini or Vertex AI APIs.
*   Individuals or teams seeking to simplify and secure their Google API key and GCP credential management.
*   Users looking to improve the stability and availability of their Google LLM API calls.

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

*   **`triggerKeys` (Required)**: A list of "passcodes" that clients need to use to call the gateway.
    *   **Format**: An array of strings, `["key1", "key2"]`

*   **`poolKeys` (For Gemini)**: A pool of Google API keys for Gemini API rotation and retries.
    *   **Format**: An array of strings, `["g_api_key1", "g_api_key2"]`

*   **`fallbackKey` & `fallbackModels` (Optional)**: Set a dedicated Google API key and specify which model requests should be routed directly to it.
    *   `fallbackKey`: **Format**: A single string or `null`
    *   `fallbackModels`: **Format**: An array of strings, `["gemini-pro", "gemini-ultra"]`

*   **`gcpCredentials` (For Vertex AI)**: An array containing one or more GCP service account credential objects (JSON format).
    *   **Format**: `[{...cred1...}, {...cred2...}]`

*   **`gcpDefaultLocation` (For Vertex AI)**: The region for your GCP project.
    *   **Format**: A string, e.g., `"us-central1"`.
    *   **Default**: `"global"`

*   **`apiRetryLimit` (Optional)**: The maximum number of different keys/credentials to try from the pool upon failure.
    *   **Format**: A number, e.g., `3`.
    *   **Default**: `1`

## How to Call APIs

### Calling Vertex AI (via `/vertex`)

1.  **Construct URL**: `https://<your-unique-url>/vertex/<original-vertex-ai-api-path>`
    *   *Example*: `https://<your-url>/vertex/v1/chat/completions` (using OpenAI compatibility mode)
2.  **Add Authentication**: Include `Authorization: Bearer <your_trigger_key>` in the request headers.
3.  **Send Request**: The gateway will authenticate using rotated GCP credentials and forward the request.

### Calling Google Gemini (via `/gemini`)

This endpoint intelligently handles two types of requests:

*   **Native API Requests**: Paths matching `/v1beta/**`.
    *   **URL**: `https://<your-url>/gemini/v1beta/models/gemini-pro:generateContent`
*   **OpenAI-Compatible Requests**: Paths matching `/v1/**` or other non-native paths.
    *   **URL**: `https://<your-url>/gemini/v1/chat/completions`

**Authentication**: Include `Authorization: Bearer <your_trigger_key>` in the request headers. The gateway will handle authentication based on your model and key pool configuration.

### Calling Other Services (via Custom Prefix)

1.  **Construct URL**: `https://<your-unique-url>/<your-custom-prefix>/<target-service-path>`
2.  **Add Authentication**: Include `Authorization: Bearer <your_trigger_key>` in the request headers.
3.  **Send Request**: The gateway performs basic URL forwarding.

## (Optional) Running Locally

1.  **Install Deno**: See [Deno's official website](https://deno.land/).
2.  **Create Configuration File**: Create a `secrets.config.json` file in the project root and fill in your configuration.
3.  **Generate a Configuration Module**: Run the build script to generate `src/config_data.ts`.
    ```bash
    deno run -A build.ts
    ```
4.  **Run the Service**:
    ```bash
    deno run --allow-net ./src/deno_index.ts
    ```
5.  **Access**: The service runs at `http://localhost:8000` by default.

---

Happy proxying!