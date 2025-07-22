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
import type { AppConfig } from "./managers.ts";
import type { AuthenticationDetails, RequestHandlerStrategy, StrategyContext } from "./types.ts";
import { getApiKeyFromReq, buildBaseProxyHeaders, _getGeminiAuthDetails } from "./auth.ts";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload";

// =================================================================================
// --- 1. Vertex AI 策略 ---
// =================================================================================

export class VertexAIStrategy implements RequestHandlerStrategy {
    private readonly config: AppConfig;
    private readonly gcpAuth: () => Promise<{ token: string; projectId: string; } | null>;

    constructor(config: AppConfig, gcpAuth: () => Promise<{ token: string; projectId: string; } | null>) {
        this.config = config;
        this.gcpAuth = gcpAuth;
    }

    async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
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

    buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL {
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

    buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers {
        if (!auth.gcpToken) throw new Error("Vertex AI requires a GCP Token.");
        const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
        headers.delete('authorization');
        headers.set('Authorization', `Bearer ${auth.gcpToken}`);
        return headers;
    }

    transformRequestBody(body: Record<string, any> | null): Record<string, any> | null {
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

export class GeminiOpenAIStrategy implements RequestHandlerStrategy {
    // This strategy no longer needs AppConfig
    constructor() {}

    getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
        const model = ctx.parsedBody?.model ?? null;
        return Promise.resolve(_getGeminiAuthDetails(c, ctx, model, attempt, "Gemini OpenAI"));
    }
    buildTargetUrl(ctx: StrategyContext): URL {
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
    buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers {
        const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
        headers.delete('authorization'); headers.delete('x-goog-api-key');
        if (auth.key) headers.set('Authorization', `Bearer ${auth.key}`);
        return headers;
    }

    // No transformation needed for the request body

    async handleResponse(res: Response, ctx: StrategyContext): Promise<Response> {
        if (!ctx.path.endsWith('/models') || !res.headers.get("content-type")?.includes("json")) return res;
        try {
            const body = await res.json();
            if (body?.data?.length) {
                body.data.forEach((m: Record<string, any>) => {
                    if (m.id?.startsWith('models/')) {
                        m.id = m.id.slice(7);
                    }
                });
                const newBody = JSON.stringify(body);
                const h = new Headers(res.headers);
                h.delete('Content-Encoding');
                h.set('Content-Length', String(new TextEncoder().encode(newBody).byteLength));
                return new Response(newBody, { status: res.status, statusText: res.statusText, headers: h });
            }
            return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers: res.headers });
        } catch { return res; }
    }
}

// =================================================================================
// --- 3. Gemini (Native) 策略 ---
// =================================================================================

export class GeminiNativeStrategy implements RequestHandlerStrategy {
    // This strategy no longer needs AppConfig
    constructor() {}

    getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
        // For native requests, the model is in the URL path, not the body.
        const model = ctx.path.match(/\/models\/([^:]+):/)?.[1] ?? null;
        return Promise.resolve(_getGeminiAuthDetails(c, ctx, model, attempt, "Gemini Native"));
    }
    buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL {
        // 文件上传请求 (POST a file) 使用一个特殊的 upload URL.
        const isUpload = ctx.originalRequest.method === 'POST' && ctx.path.startsWith('/v1beta/files');

        const baseUrl = isUpload ? GEMINI_UPLOAD_URL : GEMINI_BASE_URL;
        const url = new URL(ctx.path, baseUrl);

        // 将原始请求中的所有查询参数（除了 'key'）复制到目标 URL 中
        ctx.originalUrl.searchParams.forEach((v, k) => {
            if (k.toLowerCase() !== 'key') {
                url.searchParams.set(k, v);
            }
        });

        return url;
    }
    buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails) {
        const h = buildBaseProxyHeaders(ctx.originalRequest.headers);
        h.delete('authorization'); h.delete('x-goog-api-key');
        if (auth.key) {
            h.set('x-goog-api-key', auth.key);
        }
        return h;
    }
    public buildWebSocketTarget(ctx: StrategyContext): URL {
        const url = new URL(GEMINI_BASE_URL);
        url.protocol = 'wss:';
        url.pathname = ctx.path;
    
        // 复制所有查询参数，除了用于用户认证的 'key'
        ctx.originalUrl.searchParams.forEach((v, k) => {
            if (k.toLowerCase() !== 'key') {
                url.searchParams.set(k, v);
            }
        });
    
        return url;
    }
    // No transformation needed for the request body
}

// =================================================================================
// --- 4. 通用代理策略 ---
// =================================================================================

export class GenericProxyStrategy implements RequestHandlerStrategy {
    private readonly config: AppConfig;

    constructor(config: AppConfig) {
        this.config = config;
    }

    getAuthenticationDetails(): Promise<AuthenticationDetails> { return Promise.resolve({ key: null, source: null, gcpToken: null, gcpProject: null, maxRetries: 1 }); }
    buildTargetUrl(ctx: StrategyContext): URL {
        if (!ctx.prefix || !this.config.apiMappings[ctx.prefix]) throw new Response(`Proxy target for prefix '${ctx.prefix}' not in API_MAPPINGS.`, { status: 503 });
        const url = new URL(ctx.path, this.config.apiMappings[ctx.prefix]);
        ctx.originalUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
        return url;
    }
    buildRequestHeaders(ctx: StrategyContext, _auth: AuthenticationDetails) { return buildBaseProxyHeaders(ctx.originalRequest.headers); }
    // No transformation needed for the request body
}