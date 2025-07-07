# Intelligent LLM API Gateway

## What is this?

A stateless API gateway for Google Gemini and Vertex AI APIs, configured entirely via **environment variables**. It's designed to simplify access, authentication, and key management while enhancing security and availability.

This gateway acts as a smart relay. Direct your requests intended for Google services to the paths you configure (e.g., `/gemini` or `/vertex`). Based on environment variable settings, the gateway automatically handles authentication (including Gemini Key rotation and GCP credential rotation), performs intelligent routing based on model names or paths, and securely forwards the requests to the appropriate Google service.

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
*   **Enhanced Security**: Securely injects your actual Google API keys and GCP service account credentials via environment variables on the backend.
*   **Unified Entry Point & Simplified Authentication**: Uses `/gemini`, `/vertex`, etc., as unified paths for Google LLM services, requiring clients only to manage simple "trigger keys".
*   **Stateless & Easy Deployment**: Requires no database or external storage. All configuration comes from environment variables, greatly simplifying deployment and scaling.

## Who is it for?

*   Developers calling Google Gemini or Vertex AI APIs.
*   Individuals or teams seeking to simplify and secure their Google API key and GCP credential management.
*   Users looking to improve the stability and availability of their Google LLM API calls.
*   Users who prefer configuring deployments via environment variables.

## Quick Deployment (Recommended: Deno Deploy)

Deploying to Deno Deploy is the simplest method.

1.  **Prepare Code**: Fork this project or host the code in your own GitHub repository.
2.  **Visit Deno Deploy**: Go to the [Deno Deploy website](https://deno.com/deploy) and log in with GitHub.
3.  **Create Project**: Click "New Project".
4.  **Link Repository**: Select the GitHub repository containing the gateway code.
5.  **Set Entry Point**: Specify the entry point file as `src/deno_index.ts`.
6.  **Add Environment Variables**: In the "Environment Variables" section, add the variables described in the "How to Configure" section below.
7.  **Deploy**: Click "Link" / "Deploy".
8.  **Get Your URL**: Note down your deployment URL (e.g., `https://<your-project-name>.deno.dev`).

*Note: Deno Deploy's free tier has resource limitations.*

## How to Configure (Via Environment Variables)

Configure all gateway features by setting environment variables.

*   **`API_MAPPINGS` (Required)**: Defines mappings from path prefixes to target URLs.
    *   **Format**: `/<prefix1>:<target_url1>,/<prefix2>:<target_url2>`
    *   **Example**: `/gemini:https://generativelanguage.googleapis.com,/other:https://api.example.com`
    *   **Note**: Must include a mapping for Gemini. `/vertex` is a special built-in path and does not need to be configured here.

*   **`TRIGGER_KEYS` (Required)**: The "passcodes" clients need to call the gateway. Multiple keys can be set.
    *   **Format**: `<key1>,<key2>,...`
    *   **Example**: `my_secret_key,another_key`

*   **`POOL_KEYS` (For Gemini)**: A pool of Google API keys for Gemini API rotation and retries.
    *   **Format**: `<g_api_key1>,<g_api_key2>,...`

*   **`FALLBACK_KEY` & `FALLBACK_MODELS` (Optional)**: Set a dedicated Google API key and specify which model requests should be routed directly to it.
    *   `FALLBACK_KEY`: **Format**: `<single_g_api_key>`
    *   `FALLBACK_MODELS`: **Format**: `<model1>,<model2>,...` (e.g., `gemini-pro,gemini-ultra`)

*   **`GCP_CREDENTIALS` (For Vertex AI)**: Contains one or more GCP service account credentials (in JSON format).
    *   **Format**: `[{...gcp_cred_json...}]` (for a single credential) or `[[{...cred1...},{...cred2...}]]` (for an array of multiple credentials).
    *   **It is strongly recommended** to set this as a "Secret" type environment variable on platforms like Deno Deploy.

*   **`GCP_DEFAULT_LOCATION` (For Vertex AI)**: The region for your GCP project.
    *   **Format**: A string, e.g., `us-central1` or `global`.
    *   **Default**: `global`

*   **`API_RETRY_LIMIT` (Optional)**: The maximum number of different keys/credentials to try from the pool upon failure.
    *   **Format**: A numeric string, e.g., `3`.
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
2.  **Create a `.env` file**: Create a `.env` file in the project root and populate it with the environment variables described above.
3.  **Load Environment Variables and Run**:
    ```bash
    # You may need to install deno_dotenv first
    deno install -A -r https://deno.land/x/dotenv/load.ts
    # Run the server
    deno run --allow-net --allow-env ./src/deno_index.ts
    ```
4.  **Access**: The service runs at `http://localhost:8080` by default.

---

Happy proxying!