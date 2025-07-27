// src/strategies.ts
//
// 该文件包含了所有请求处理策略 (RequestHandlerStrategy) 的具体实现。
// 每个策略类都封装了与特定后端服务（如 Vertex AI, Gemini）通信所需的所有逻辑。
//
// 核心设计理念：
// 1. **策略模式**: 每个后端服务对应一个策略类，实现了 `RequestHandlerStrategy` 接口。
// 2. **无状态与通用性**: 策略实现不依赖任何特定于下游服务的复杂类型定义。
//    请求体（body）被当作通用的 `Record<string, any>` 对象处理，
//    服务只在必要时（如修改、添加字段）关心其结构，实现了最大程度的解耦。
// 3. **职责单一**: 每个策略只负责认证、URL构建、头信息处理和必要的请求/响应转换。

import type { Context } from "hono";
import { configManager } from "./managers.ts";
import type { AppConfig } from "./managers.ts";
import type { AuthenticationDetails, RequestHandlerStrategy, StrategyContext } from "./types.ts";
import { getApiKeyFromReq, buildBaseProxyHeaders, _getGeminiAuthDetails } from "./auth.ts";
import { createStreamingTextReplacer } from "./utils.ts";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload";
const MAX_BUFFER_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

// =================================================================================
// --- 0. 基础策略与辅助函数 ---
// =================================================================================

/**
 * 在两个 WebSocket 连接之间建立双向代理。
 * @param clientSocket 客户端 WebSocket 连接
 * @param backendSocket 后端服务 WebSocket 连接
 */
const _proxyWebSocket = (client: WebSocket, backend: WebSocket) => {
    let hasClosed = false;

    // 统一的清理函数，确保两个连接都被关闭并移除监听器
    const cleanup = (code = 1001, reason = "Proxy connection closed") => {
        if (hasClosed) return;
        hasClosed = true;
        
        // 移除所有事件监听器以防止内存泄漏和意外行为
        client.onmessage = backend.onmessage = null;
        client.onerror = backend.onerror = null;
        client.onclose = backend.onclose = null;
        
        // 根据 WebSocket 规范验证关闭代码。
        // 无效代码（如 1005, 1006, 1015）不能被程序化地设置。
        // 我们将它们映射到一个通用的“代理关闭”代码。
        const validCode = (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000;

        // 如果连接尚未关闭，则使用提供的代码和原因关闭它
        if (client.readyState < WebSocket.CLOSING) client.close(validCode, reason);
        if (backend.readyState < WebSocket.CLOSING) backend.close(validCode, reason);
    };

    client.onmessage = (event) => {
        // 在转发消息前检查后端连接是否打开
        if (backend.readyState === WebSocket.OPEN) {
            backend.send(event.data);
        } else {
            cleanup(1011, "Backend connection not open");
        }
    };

    backend.onmessage = (event) => {
        // 在转发消息前检查客户端连接是否打开
        if (client.readyState === WebSocket.OPEN) {
            client.send(event.data);
        } else {
            cleanup(1011, "Client connection not open");
        }
    };
    
    // 当任一连接关闭时，确保另一个也关闭，并传递关闭事件
    client.onclose = (event) => cleanup(event.code, event.reason);
    backend.onclose = (event) => cleanup(event.code, event.reason);

    // 当任一连接出错时，记录错误并关闭两个连接
    client.onerror = (event) => {
        console.error("Client WebSocket error:", event instanceof ErrorEvent ? event.error : event);
        cleanup(1011, "Client-side error");
    };
    backend.onerror = (event) => {
        console.error("Backend WebSocket error:", event instanceof ErrorEvent ? event.error : event);
        cleanup(1011, "Backend-side error");
    };
};

abstract class BaseStrategy implements RequestHandlerStrategy {
    abstract getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails>;
    abstract buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL | Promise<URL>;
    abstract buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers;

    // 为需要重试的策略提供可重用的请求体缓冲方法
    // 通过 Teeing 实现流式传输与异步缓存并行
    protected _bufferStreamInBackground(req: Request): {
        bodyForFirstAttempt: ReadableStream<Uint8Array> | null;
        getCachedBodyForRetry: () => Promise<ArrayBuffer | null>;
        parsedBodyPromise: Promise<Record<string, any> | null>;
        retriesEnabled: boolean;
    } {
        if (!req.body) {
            return {
                bodyForFirstAttempt: null,
                getCachedBodyForRetry: () => Promise.resolve(null),
                parsedBodyPromise: Promise.resolve(null),
                retriesEnabled: false,
            };
        }

        const [stream1, stream2] = req.body.tee();

        const cachePromise = (async () => {
            try {
                const reader = stream2.getReader();
                const chunks: Uint8Array[] = [];
                let totalSize = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    totalSize += value.length;
                    if (totalSize > MAX_BUFFER_SIZE_BYTES) {
                        await reader.cancel();
                        throw new Error(`Request body exceeds max buffer size of ${MAX_BUFFER_SIZE_BYTES} bytes.`);
                    }
                    chunks.push(value);
                }
                const buffer = new Uint8Array(totalSize);
                let offset = 0;
                for (const chunk of chunks) {
                    buffer.set(chunk, offset);
                    offset += chunk.length;
                }
                return buffer.buffer;
            } catch (e) {
                console.error("Error buffering stream in background:", e);
                return null;
            }
        })();

        const parsedBodyPromise = (async () => {
            const buffer = await cachePromise;
            if (buffer && buffer.byteLength > 0 && req.headers.get('content-type')?.includes('application/json')) {
                try {
                    return JSON.parse(new TextDecoder().decode(buffer));
                } catch (e) {
                    console.error("Error parsing buffered body:", e);
                }
            }
            return null;
        })();

        return {
            bodyForFirstAttempt: stream1,
            getCachedBodyForRetry: () => cachePromise,
            parsedBodyPromise,
            retriesEnabled: true,
        };
    }
    
    async prepareRequestBody(req: Request, c: Context) {
        if (!req.body) {
            return { bodyForFirstAttempt: null, getCachedBodyForRetry: () => Promise.resolve(null), parsedBodyPromise: Promise.resolve(null), retriesEnabled: false };
        }

        // 关键优化：只有在可能需要重试时（即使用触发密钥时），才考虑缓冲请求体。
        // 这样可以防止在使用真实密钥时，因不必要的缓冲尝试而导致大文件上传失败。
        const config = configManager.getSync();
        const userApiKey = getApiKeyFromReq(c, new URL(c.req.url));
        const isTriggerKey = userApiKey ? config.triggerKeys.has(userApiKey) : false;

        // 如果用户使用自己的真实密钥，则绝不进行缓冲，始终以流式方式处理。
        if (userApiKey && !isTriggerKey) {
            return {
                bodyForFirstAttempt: req.body,
                getCachedBodyForRetry: () => Promise.resolve(null),
                parsedBodyPromise: Promise.resolve(null), // 不解析，因为不需要
                retriesEnabled: false,
            };
        }

        // 对于触发密钥或无密钥的请求，我们默认它们都应该被考虑重试。
        // 后台缓存机制自身包含了 100MB 的大小安全检查。
        return this._bufferStreamInBackground(req);
    }

    transformRequestBody?(body: Record<string, any> | null, _ctx: StrategyContext): Record<string, any> | null {
        return body;
    }

    handleResponse?(res: Response, _ctx: StrategyContext): Promise<Response> {
        return Promise.resolve(res);
    }

    handleWebSocketProxy?(c: Context, _ctx: StrategyContext): Promise<Response> {
        return Promise.resolve(c.text("WebSocket proxy not implemented for this strategy", 501));
    }
}


// =================================================================================
// --- 1. Vertex AI 策略 ---
// =================================================================================

export class VertexAIStrategy extends BaseStrategy {
    private readonly config: AppConfig;
    private readonly gcpAuth: () => Promise<{ token: string; projectId: string; } | null>;

    constructor(config: AppConfig, gcpAuth: () => Promise<{ token: string; projectId: string; } | null>) {
        super();
        this.config = config;
        this.gcpAuth = gcpAuth;
    }

    override async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
        const userKey = getApiKeyFromReq(c, ctx.originalUrl) || 'N/A';
        if (!this.config.triggerKeys.has(userKey)) {
            throw new Response("Forbidden: A valid trigger key is required for the /vertex endpoint.", { status: 403 });
        }
        const auth = await this.gcpAuth();
        if (!auth && attempt === 1) {
            throw new Response("GCP authentication failed on first attempt. Check GCP_CREDENTIALS.", { status: 503 });
        }
        return { key: null, source: null, gcpToken: auth?.token || null, gcpProject: auth?.projectId || null, maxRetries: this.config.apiRetryLimit };
    }

    override buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL {
        if (!auth.gcpProject) throw new Error("Vertex AI requires a GCP Project ID.");
        const loc = this.config.gcpDefaultLocation;
        const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
        const baseUrl = `https://${host}/v1beta1/projects/${auth.gcpProject}/locations/${loc}/endpoints/openapi`;

        let targetPath = ctx.path;
        if (targetPath.startsWith('/v1/')) {
            targetPath = targetPath.slice(3); // Removes "/v1" leaving "/chat/completions"
        }

        const url = new URL(`${baseUrl}${targetPath}`);
        ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
        return url;
    }

    override buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers {
        if (!auth.gcpToken) throw new Error("Vertex AI requires a GCP Token.");
        const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
        headers.delete('authorization');
        headers.set('Authorization', `Bearer ${auth.gcpToken}`);
        return headers;
    }

    override transformRequestBody(body: Record<string, any> | null): Record<string, any> | null {
        if (!body) return null;

        const bodyToModify = { ...body };
        if (bodyToModify.model && typeof bodyToModify.model === 'string' && !bodyToModify.model.startsWith('google/')) {
            bodyToModify.model = `google/${bodyToModify.model}`;
        }
        if (bodyToModify.reasoning_effort === 'none') {
            delete bodyToModify.reasoning_effort;
        }
        bodyToModify.google = {
            ...(bodyToModify.google || {}),
            safety_settings: [
                { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF" },
                { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF" },
                { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF" },
                { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF" },
            ]
        };
        return bodyToModify;
    }
}

// =================================================================================
// --- 2. Gemini (OpenAI-Compatible) 策略 ---
// =================================================================================

export class GeminiOpenAIStrategy extends BaseStrategy {
    constructor() {
        super();
    }


    override getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
        const model = ctx.parsedBody?.model ?? null;
        return Promise.resolve(_getGeminiAuthDetails(c, ctx, model, attempt, "Gemini OpenAI"));
    }
    override buildTargetUrl(ctx: StrategyContext): URL {
        // 从原始路径中移除可选的 /v1 前缀，以获得标准的 OpenAI 路径
        let openAIPath = ctx.path;
        if (openAIPath.startsWith('/v1/')) {
            openAIPath = openAIPath.slice(3); // e.g., /v1/chat/completions -> /chat/completions
        }

        // 构建符合 Gemini OpenAI 兼容层要求的正确路径
        const geminiPath = `/v1beta/openai${openAIPath}`;

        const url = new URL(geminiPath, GEMINI_BASE_URL);
        ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
        return url;
    }
    override buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers {
        const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
        headers.delete('authorization'); headers.delete('x-goog-api-key');
        if (auth.key) headers.set('Authorization', `Bearer ${auth.key}`);
        return headers;
    }

    override async handleResponse(res: Response, ctx: StrategyContext): Promise<Response> {
        // 优化的流式处理：仅当路径匹配时，才通过流式替换器处理响应。
        if (ctx.path.endsWith('/models') && res.body && res.headers.get("content-type")?.includes("json")) {
            const replacer = createStreamingTextReplacer({ '"models/': '"' });
            const newHeaders = new Headers(res.headers);
            newHeaders.delete('content-length');
            newHeaders.delete('content-encoding');
            
            return new Response(res.body.pipeThrough(replacer), {
                status: res.status,
                statusText: res.statusText,
                headers: newHeaders
            });
        }
        // 对于所有其他情况，直接返回原始响应。
        return res;
    }
}

// =================================================================================
// --- 3. Gemini (Native) 策略 ---
// =================================================================================

export class GeminiNativeStrategy extends BaseStrategy {
    constructor() {
        super();
    }


    override getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
        // For native requests, the model is in the URL path, not the body.
        const model = ctx.path.match(/\/models\/([^:]+):/)?.[1] ?? null;
        return Promise.resolve(_getGeminiAuthDetails(c, ctx, model, attempt, "Gemini Native"));
    }
    override buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL {
        // Resumable Upload PUT requests are sent to a path like /gemini/upload/v1beta/files...
        // The ctx.path will be /upload/v1beta/files...
        if (ctx.originalRequest.method === 'PUT' && ctx.path.startsWith('/upload/')) {
            const targetUrl = new URL(GEMINI_UPLOAD_URL); // e.g. https://generativelanguage.googleapis.com/upload
            targetUrl.pathname = ctx.path; // e.g. /upload/v1beta/files
            targetUrl.search = ctx.originalUrl.search; // all original query params
            return targetUrl;
        }

        // For other requests, including the initial POST to create an upload session
        const isUpload = ctx.originalRequest.method === 'POST' && ctx.path.includes('/files');
        const baseUrl = isUpload ? GEMINI_UPLOAD_URL : GEMINI_BASE_URL;
        const url = new URL(ctx.path, baseUrl);

        // Copy search params from original request, excluding auth key
        ctx.originalUrl.searchParams.forEach((v, k) => {
            if (k.toLowerCase() !== 'key') {
                url.searchParams.set(k, v);
            }
        });

        return url;
    }
    override buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails) {
        const h = buildBaseProxyHeaders(ctx.originalRequest.headers);
        h.delete('authorization'); h.delete('x-goog-api-key');
        if (auth.key) {
            h.set('x-goog-api-key', auth.key);
        }
        return h;
    }
    override async handleResponse(res: Response, ctx: StrategyContext): Promise<Response> {
        const uploadUrlHeader = res.headers.get('x-goog-upload-url');

        if (uploadUrlHeader) {
            try {
                const googleUploadUrl = new URL(uploadUrlHeader);
                const proxyUrl = new URL(ctx.originalUrl);

                proxyUrl.pathname = `${ctx.prefix}${googleUploadUrl.pathname}`;
                proxyUrl.search = googleUploadUrl.search;

                // 将 API 密钥嵌入重写后的 URL，以便后续的 PUT 请求能够被认证。
                const userApiKey = getApiKeyFromReq({ req: { header: (name: string) => ctx.originalRequest.headers.get(name) } } as Context, ctx.originalUrl);
                if (userApiKey) {
                    proxyUrl.searchParams.set('key', userApiKey);
                }

                const newHeaders = new Headers(res.headers);
                newHeaders.set('x-goog-upload-url', proxyUrl.toString());
                // Body 为空，但以防万一还是清理这些头。
                newHeaders.delete('content-encoding');
                newHeaders.delete('content-length');

                return new Response(res.body, {
                    status: res.status,
                    statusText: res.statusText,
                    headers: newHeaders
                });
            } catch (e) {
                console.error("Failed to rewrite x-goog-upload-url:", e);
                // 失败时返回原始响应
                return res;
            }
        }

        return res;
    }

    override async handleWebSocketProxy(c: Context, ctx: StrategyContext): Promise<Response> {
        const auth = await this.getAuthenticationDetails(c, ctx, 1);
        if (!auth.key) {
            return c.text("Authentication failed for WebSocket proxy.", 401);
        }

        const targetUrl = new URL(GEMINI_BASE_URL);
        targetUrl.protocol = 'wss:';
        targetUrl.pathname = ctx.path;
        ctx.originalUrl.searchParams.forEach((v, k) => {
            if (k.toLowerCase() !== 'key') {
                targetUrl.searchParams.set(k, v);
            }
        });
        targetUrl.searchParams.set('key', auth.key);

        const { response, socket: clientSocket } = Deno.upgradeWebSocket(c.req.raw);
        const backendSocket = new WebSocket(targetUrl);

        _proxyWebSocket(clientSocket, backendSocket);

        return response;
    }
}

// =================================================================================
// --- 4. 通用代理策略 ---
// =================================================================================

export class GenericProxyStrategy extends BaseStrategy {
    private readonly config: AppConfig;

    constructor(config: AppConfig) {
        super();
        this.config = config;
    }

    override getAuthenticationDetails(): Promise<AuthenticationDetails> { return Promise.resolve({ key: null, source: null, gcpToken: null, gcpProject: null, maxRetries: 1 }); }
    override buildTargetUrl(ctx: StrategyContext): URL {
        if (!ctx.prefix || !this.config.apiMappings[ctx.prefix]) throw new Response(`Proxy target for prefix '${ctx.prefix}' not in API_MAPPINGS.`, { status: 503 });
        const url = new URL(ctx.path, this.config.apiMappings[ctx.prefix]);
        ctx.originalUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
        return url;
    }
    override buildRequestHeaders(ctx: StrategyContext, _auth: AuthenticationDetails) { return buildBaseProxyHeaders(ctx.originalRequest.headers); }
}