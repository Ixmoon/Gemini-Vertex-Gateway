# Intelligent LLM API Gateway

## What is this?

An intelligent API gateway designed for Google Gemini and Vertex AI APIs, aiming to simplify access, authentication, and key management while enhancing security and availability.

This gateway acts as a smart relay. Direct your requests intended for Google Gemini or Vertex AI to the gateway's `/gemini` path. Based on your configuration, the gateway automatically handles authentication (including Gemini Key rotation and GCP credential rotation), performs intelligent routing based on the model name, and securely forwards the request to the appropriate Google service.

It also provides basic HTTP proxy functionality. You can configure other path prefixes to forward requests to any web service, but this part of the functionality does not include the advanced management features designed for Google LLMs mentioned below.

## Core Problems Solved (for Google LLM APIs)

*   **Key/Credential Security**: Avoids exposing Google API keys or GCP service account credentials in client-side or application code.
*   **Simplified Authentication**: Clients only need a unified "trigger key" to access services via the gateway.
*   **Gemini Key Management**: Addresses quota limits and single-point-of-failure issues by implementing automatic rotation and failure retry for Gemini API Keys via a key pool.
*   **Vertex AI Credential Management**: Simplifies Vertex AI authentication through automatic rotation of GCP service account credentials.
*   **Intelligent Routing**: Automatically routes requests to the Gemini API, Vertex AI endpoints, or uses a specified Fallback Key based on the model name.

## Core Advantages (Targeting the `/gemini` Endpoint)

This project offers the following core advantages for Google Gemini and Vertex AI API calls made via the `/gemini` path:

*   **Model-Driven Intelligent Routing**:
	*   Automatically identifies and routes requests to **Vertex AI** endpoints based on the model name, authenticating with rotated GCP service account credentials.
	*   Routes requests to a designated **Fallback Key** based on the model name. This is often used to direct specific requests (e.g., using paid models, models requiring special permissions) to a dedicated key, allowing the key pool to handle other requests (e.g., using free models), thus enabling cost optimization or fine-grained access control.
*   **Gemini Key Rotation & Retry**: For requests targeting the Gemini API (when not matched by Fallback Key or Vertex AI routing rules), automatically selects an API Key from the "Pool Keys" in rotation and attempts retries with other keys from the pool upon failure, according to configuration.
*   **Enhanced Security**: Securely stores actual Google API keys and GCP service account credentials on the backend (Deno KV).
*   **Unified Entry Point & Simplified Authentication**: Uses `/gemini` as the unified path for accessing Google LLM services, requiring clients only to manage and use simple "trigger keys".
*   **Web Configuration**: Provides an intuitive Web UI ([`/manage`](src/manage.html:1)) for configuring policies.

**(Secondary Functionality)**: Supports basic request forwarding to any HTTP/S service by configuring **other API Path Mappings**. This functionality **does not provide** the advanced features like key rotation, credential rotation, or model routing mentioned above.

## Who is it for?

*   Developers calling Google Gemini or Vertex AI APIs.
*   Individuals or teams seeking to simplify and secure their Google API key and GCP credential management.
*   Users looking to improve the stability and availability of their Google LLM API calls.
*   Users who prefer configuring complex calling strategies through an intuitive web interface.

## Quick Deployment (Recommended: Deno Deploy)

Deploying to Deno Deploy is the simplest method.

1.  **Prepare Code**: Host the project code in a GitHub repository.
2.  **Visit Deno Deploy**: Go to the [Deno Deploy website](https://deno.com/deploy) and log in with GitHub.
3.  **Create Project**: Click "New Project".
4.  **Link Repository**: Select the GitHub repository containing the gateway code.
5.  **Set Entry Point**: Specify the entry point file as `src/deno_index.ts`.
6.  **Deploy**: Click "Link" / "Deploy".
7.  **Get Your URL**: Note down your deployment URL (e.g., `https://<your-project-name>.deno.dev`).

*Note: Deno Deploy's free tier has resource limitations.*

## How to Configure (Using the `/manage` Webpage)

Access `https://<your-unique-url>/manage` after deployment to configure.

1.  **Access & Login**: Set an admin password (min. 8 characters) on first access.
2.  **Core Configuration Options Explained**:
	*   **API Path Mappings**:
		*   **`/gemini` (Required)**: The entry point for advanced Google LLM features. You **must add** a mapping with the prefix `/gemini`, targeting the Google API base address (e.g., `https://generativelanguage.googleapis.com`). Requests to `<your-url>/gemini/...` will be intelligently processed by the gateway.
		*   **Other Prefixes (Optional)**: Add other prefixes to configure basic HTTP proxy forwarding to any URL; advanced features **do not apply**.
	*   **Trigger Keys**: **(Required)** Add the "passcodes" clients need to call the gateway (any path).
	*   **Pool Keys**: **(For `/gemini` Gemini Requests)** Store Google API keys here. Used **only** for `/gemini` requests targeting the Gemini API (when the model doesn't match Fallback or Vertex rules). Supports key rotation and retry.
	*   **Fallback Key & Fallback Models**: **(For specific `/gemini` Model Requests)** Set a dedicated Google API key and specify which model names (requested via `/gemini`) should be **routed directly to use this key**. Often used to direct requests for paid or specific-capability models to this key, complementing the pool key strategy. This rule takes precedence over the Pool Keys.
	*   **Vertex AI Model List & GCP Settings**: **(For `/gemini` Vertex AI Requests)** Add model names that need routing to Vertex AI, and configure GCP service account credentials (multiple can be added for rotation). When a `/gemini` request's model is in this list, it will be authenticated using GCP credentials and **routed to Vertex AI**.
	*   **API Retry Limit**: **(For `/gemini` Gemini Pool Keys)** Sets the maximum number of *different* keys from the Pool Keys to try when a Gemini API call (using the pool) fails.
3.  **Save Configuration**: Always click the "Save" button for the respective section after making changes.

## How to Call APIs

### Calling Google Gemini / Vertex AI (via `/gemini`)

Leverage the gateway's intelligent features by making requests via the `/gemini` path:

1.  **Construct URL**: `https://<your-unique-url>/gemini/<original-google-api-path>`
	*   *Example (Gemini)*: `https://<your-url>/gemini/v1beta/models/gemini-pro:generateContent`
2.  **Add Authentication**: Include `Authorization: Bearer <your_trigger_key>` in the request headers.
3.  **Send Request**: The gateway handles authentication and routing based on the model and configuration.

### Calling Other Services (via Custom Prefix)

1.  **Construct URL**: `https://<your-unique-url>/<your-custom-prefix>/<target-service-path>`
2.  **Add Authentication**: Include `Authorization: Bearer <your_trigger_key>` in the request headers.
3.  **Send Request**: The gateway performs basic URL forwarding.

## (Optional) Running Locally

1.  **Install Deno**: See [Deno's official website](https://deno.land/).
2.  **Run**:
	```bash
	deno run --allow-net --allow-read --allow-env --allow-write ./src/deno_index.ts
	```
3.  **Access**: Service runs at `http://localhost:8080`. Config: `http://localhost:8080/manage`. API calls: `http://localhost:8080/<prefix>/...`.

---

Happy proxying!