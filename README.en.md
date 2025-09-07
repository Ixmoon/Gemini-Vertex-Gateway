# Intelligent API Gateway for Google Gemini & Vertex AI

## What is this?

A stateless, transparent API gateway that simplifies access to Google's Gemini and Vertex AI services. It's designed to be a simple, secure, and intelligent passthrough proxy.

The core idea is **client freedom**. You can use your existing Gemini client (Google AI SDK) or OpenAI-compatible client, point it to the gateway, and it just works. The gateway handles the complex authentication (API key rotation for Gemini, GCP credential rotation for Vertex AI) behind the scenes, so you only need a single, simple key to access everything.

## Core Problems Solved

*   **Simplified Vertex AI Authentication**: Use Vertex AI just as easily as the Gemini API, with a single API key, instead of complex GCP service account authentication.
*   **Key & Credential Security**: Prevents exposure of your Google API keys or GCP service account credentials in client-side code.
*   **Quota Management & Reliability**: Mitigates API quota limits and improves reliability by automatically rotating through a pool of keys/credentials and retrying failed requests.
*   **Stateful Operation Safety**: Guarantees that operations requiring consistency (like file uploads or WebSocket sessions) are always routed to a single, dedicated API key.

## Core Features

*   **Client Freedom**: Both the `/gemini` and `/vertex` endpoints accept requests in **both Gemini API format and OpenAI API format**. Use the client you prefer.
*   **Unified Endpoints**:
    *   `/gemini`: Proxies to the Google AI Gemini API, authenticating with a rotating pool of Google API keys.
    *   `/vertex`: Proxies to the Vertex AI API, authenticating with a rotating pool of GCP service account credentials.
*   **Advanced Key Management**: Automatically uses a rotating key pool (`poolKeys`) for stateless requests and a dedicated key (`fallbackKey`) for stateful operations (file uploads, WebSockets) to ensure stability.
*   **Generic Passthrough Proxy**: The `apiMappings` feature allows you to configure simple, transparent proxies for any other API (like Anthropic Claude, etc.), using the same path-based routing.
*   **Stateless & Easy Deployment**: No database required. Configuration is bundled at build time, making deployment and scaling trivial.

## Who is it for?

*   Developers who want to use Vertex AI without the hassle of GCP authentication in their client code.
*   Teams looking to centralize, secure, and simplify their Google API key and GCP credential management.
*   Users who need to improve the reliability of their LLM API calls through automatic retries and key rotation.

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

All configuration is managed through the `secrets.config.json` file. For deployment, this file's content must be set as a GitHub Repository Secret.

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
  "apiMappings": {}
}
```

### Field Descriptions

*   **`triggerKeys` (Required)**: An array of "passwords" for the gateway. Your client will use one of these keys instead of a real API key to activate the gateway's features.
    *   **Format**: `["gateway_key_1", "gateway_key_2"]`

*   **`poolKeys` (For `/gemini`)**: A pool of your actual Google API keys. Used by the `/gemini` endpoint for rotation.
    *   **Format**: `["google_api_key_1", "google_api_key_2"]`

*   **`fallbackKey` (Required for Stateful Operations)**: A single, dedicated Google API key. The gateway **automatically** uses this key for any stateful request (like file uploads, WebSockets) to ensure session consistency.
    *   **Format**: A single string, e.g., `"dedicated_google_api_key"`

*   **`fallbackModels` (Optional)**: A list of model names. Forces requests for these models to always use the more reliable `fallbackKey`.
    *   **Format**: `["gemini-1.5-pro-latest"]`

*   **`gcpCredentials` (For `/vertex`)**: An array of GCP service account credential objects (JSON format). Used by the `/vertex` endpoint for rotation.
    *   **Format**: `[{...cred1...}, {...cred2...}]`

*   **`gcpDefaultLocation` (For `/vertex`)**: The default region for your GCP project.
    *   **Format**: A string, e.g., `"us-central1"`. Default: `"global"`

*   **`apiRetryLimit` (Optional)**: The maximum number of different keys/credentials to try from a pool upon failure.
    *   **Format**: A number, e.g., `3`. Default: `1`

*   **`apiMappings` (Optional)**: Defines simple, transparent passthrough proxies for any other API. The key is the path prefix, the value is the target base URL.
    *   **Example**: `{ "/claude": "https://api.anthropic.com" }`

## How to Use the Gateway

You can use your existing **Gemini client** or **OpenAI client**. Simply change the API key and the endpoint in your client's configuration.

### Using the `/gemini` Endpoint
*   **What it does**: Proxies to the Google AI Gemini API using your rotated `poolKeys`.
*   **Works with**: Gemini Client, OpenAI Client.
*   **How to use**:
    *   Set **API Key** to your `triggerKey`.
    *   Set **Endpoint / Base URL** to `https://<your-gateway-url>/gemini`.

### Using the `/vertex` Endpoint
*   **What it does**: Proxies to the Vertex AI API using your rotated `gcpCredentials`, simplifying authentication.
*   **Works with**: Gemini Client, OpenAI Client.
*   **How to use**:
    *   Set **API Key** to your `triggerKey`.
    *   Set **Endpoint / Base URL** to `https://<your-gateway-url>/vertex`.

### Using Custom `apiMappings` (e.g., `/claude`)
*   **What it does**: A simple passthrough proxy to the target URL you defined.
*   **Works with**: Any client corresponding to the target API (e.g., Anthropic's SDK).
*   **How to use**:
    *   Set **Endpoint / Base URL** to `https://<your-gateway-url>/claude`.
    *   Authentication is passed through directly, so configure your client's API key as required by the target service.

## (Optional) Running Locally

1.  **Install Deno**: See [Deno's official website](https://deno.land/).
2.  **Create Configuration File**: Create a `secrets.config.json` file in the project root and fill it in.
3.  **Generate Configuration Module**: `deno run -A build.ts`
4.  **Run the Service**: `deno run --allow-net ./src/deno_index.ts`
5.  **Access**: The service runs at `http://localhost:8000`.

## Updating Secrets and Redeploying

When you modify `secrets.config.json` locally, use the provided script to sync changes and redeploy.

### Using the `redeploy.bat` script (Windows)

1.  **Prerequisites**: Install [GitHub CLI](https://cli.github.com/) and log in with `gh auth login`.
2.  **Run**: Double-click `redeploy.bat` or run `./redeploy.bat` in your terminal.
3.  **What It Does**: It securely updates the `SECRETS_CONFIG_JSON` on GitHub and triggers a new deployment workflow. You can monitor the progress in your repository's "Actions" tab.