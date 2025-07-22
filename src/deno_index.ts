// src/deno_index.ts
//
// 该文件是 LLM 网关服务的核心入口和请求协调器。
//
// 核心职责:
// 1. **服务器设置**: 使用 Hono 框架初始化 Web 服务器并定义路由。
// 2. **请求分发**: `determineRequestType` 函数根据请求 URL 识别出请求类型。
// 3. **中央处理**: `handleGenericProxy` 作为所有代理请求的统一入口点，它：
//    a. 从 `strategyManager` 获取对应的处理策略。
//    b. 管理请求重试逻辑，包括对请求体的缓存。
//    c. 调用策略的不同方法来构建和发送对下游服务的请求。
// 4. **解耦**: 此文件不包含任何具体的业务逻辑（如认证、URL 构建），
//    所有具体实现都已解耦到 `strategies.ts`, `auth.ts`, `managers.ts` 等模块中。

import { Hono, Context } from "hono";
import { configManager, strategyManager } from "./managers.ts";
import type { RequestType, StrategyContext } from "./types.ts";
import { GeminiNativeStrategy } from "./strategies.ts";

// =================================================================================
// --- 1. 策略选择器与主处理函数 ---
// =================================================================================

/**
 * 根据请求的 URL 对象确定请求类型和相关细节。
 * @param url 解析后的 URL 对象
 * @returns 返回一个包含请求类型、路径前缀和处理路径的对象。
 */
const determineRequestType = (c: Context): { type: RequestType | "UNKNOWN", prefix: string | null, path: string } => {
    const url = new URL(c.req.url);
    const { pathname } = url;

    // 0. 检查特殊的 WebSocket (gRPC-Web) 路径
    const wsPrefix = '/ws/google.ai.generativelanguage.';
    if (pathname.startsWith(wsPrefix)) {
        // e.g., /ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic
        // -> /v1alpha.GenerativeService.BidiGenerateMusic
        const servicePath = pathname.slice(wsPrefix.length);
        return { type: "GEMINI_NATIVE", prefix: '/ws', path: `/${servicePath}` };
    }

    // 1. Vertex AI 的路径有特殊前缀
    if (pathname.startsWith('/vertex/')) {
        return { type: "VERTEX_AI", prefix: '/vertex', path: pathname.slice('/vertex'.length) };
    }

    // 2. 检查 Gemini 的特殊路径
    if (pathname.startsWith('/gemini/')) {
        const prefix = '/gemini';
        const path = pathname.slice(prefix.length);
        
        const isGeminiOpenAI = !!c.req.header("Authorization")?.includes('Bearer');
        return { type: isGeminiOpenAI ? "GEMINI_OPENAI" : "GEMINI_NATIVE", prefix, path };
    }

    // 3. 检查通用 API 映射
    const mappings = configManager.getSync().apiMappings;
    const prefix = Object.keys(mappings).find(p => pathname.startsWith(p));
    
    if (!prefix) {
        return { type: "UNKNOWN", prefix: null, path: pathname };
    }
    
    // 4. 其他所有匹配的路径都视为通用代理
    const path = pathname.slice(prefix.length);
    return { type: "GENERIC_PROXY", prefix, path };
};

/**
 * 处理 WebSocket 升级请求并建立双向代理。
 */
const handleWebSocketProxy = async (c: Context): Promise<Response> => {
    const upgradeHeader = c.req.header('Upgrade');
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
        return c.text('Expected Upgrade: websocket', 426);
    }

    const url = new URL(c.req.url);
    const { type, ...details } = determineRequestType(c);

    if (type !== "GEMINI_NATIVE") {
        return c.text(`WebSocket proxy is only supported for GEMINI_NATIVE, but got ${type}`, 400);
    }

    try {
        const strategy = await strategyManager.get(type) as GeminiNativeStrategy;
        const context: StrategyContext = {
            originalUrl: url,
            originalRequest: c.req.raw,
            parsedBody: null,
            isWebSocket: true,
            ...details
        };

        const auth = await strategy.getAuthenticationDetails(c, context, 1);
        if (!auth.key) {
            return c.text("Authentication failed for WebSocket proxy.", 401);
        }
        
        const targetUrl = strategy.buildWebSocketTarget(context);
        targetUrl.searchParams.set('key', auth.key);

        const { response, socket: clientSocket } = Deno.upgradeWebSocket(c.req.raw);

        // Deno 的 WebSocket 构造函数不支持自定义头部。
        // API 密钥通过 URL 查询参数 `key` 传递。
        const googleSocket = new WebSocket(targetUrl);

        clientSocket.onopen = () => console.log("Client WebSocket connected.");
        googleSocket.onopen = () => console.log("Backend WebSocket connected.");

        clientSocket.onmessage = (event) => {
            if (googleSocket.readyState === WebSocket.OPEN) {
                googleSocket.send(event.data);
            }
        };
        googleSocket.onmessage = (event) => {
            if (clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.send(event.data);
            }
        };

        const closeHandler = (event: CloseEvent) => {
            console.log(`WebSocket closed: ${event.code} ${event.reason}`);
            if (clientSocket.readyState !== WebSocket.CLOSED) clientSocket.close(event.code, event.reason);
            if (googleSocket.readyState !== WebSocket.CLOSED) googleSocket.close(event.code, event.reason);
        };
        const errorHandler = (event: Event) => {
            console.error("WebSocket error:", event);
            const reason = event instanceof ErrorEvent ? event.message : "Unknown error";
            if (clientSocket.readyState < WebSocket.CLOSING) clientSocket.close(1011, reason);
            if (googleSocket.readyState < WebSocket.CLOSING) googleSocket.close(1011, reason);
        };

        clientSocket.onclose = closeHandler;
        googleSocket.onclose = closeHandler;
        clientSocket.onerror = errorHandler;
        googleSocket.onerror = errorHandler;

        return response;

    } catch (error) {
        console.error(`Critical error in handleWebSocketProxy:`, error);
        return c.text(`Internal Server Error: ${error instanceof Error ? error.message : "Unknown"}`, 500);
    }
};


/**
 * 通用代理处理函数。
 * 这是所有代理请求的入口点。
 */
const handleGenericProxy = async (c: Context): Promise<Response> => {
    if (c.req.header('Upgrade')?.toLowerCase() === 'websocket') {
        return handleWebSocketProxy(c);
    }
    const originalReq = c.req.raw;
    const url = new URL(originalReq.url); // --- 只解析一次 URL ---
    const { type, ...details } = determineRequestType(c);

    if (type === "UNKNOWN") {
        return c.json({ error: `No route for path: ${url.pathname}` }, 404);
    }

    try {
        const strategy = await strategyManager.get(type);

        // --- Unified Body Caching & Parsing ---
        const MAX_BUFFER_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
        let bodyBuffer: ArrayBuffer | null = null;
        let parsedBody: Record<string, any> | null = null;
        let retriesEnabled = false;

        if (originalReq.body && !originalReq.bodyUsed) {
            try {
                bodyBuffer = await originalReq.arrayBuffer();

                if (bodyBuffer.byteLength >= MAX_BUFFER_SIZE_BYTES) {
                    console.warn(`Request body size (${bodyBuffer.byteLength} bytes) exceeds buffer limit. Retries disabled.`);
                    retriesEnabled = false;
                } else if (bodyBuffer.byteLength > 0) {
                    retriesEnabled = true;
                    if (originalReq.headers.get('content-type')?.includes('application/json')) {
                        // 使用 TextDecoder 将 ArrayBuffer 转换为字符串
                        const bodyText = new TextDecoder().decode(bodyBuffer);
                        parsedBody = JSON.parse(bodyText);
                    }
                } else {
                    // Body is present but empty, disable retries.
                    retriesEnabled = false;
                }
            } catch (e) {
                console.error("Error buffering or parsing request body:", e);
                return c.json({ error: "Invalid request body provided." }, 400);
            }
        }
        // --- End of Unified Caching ---

        let attempts = 0, maxRetries = 1, lastError: Response | null = null;

        while (attempts < maxRetries) {
            attempts++;
            try {
                // 对于重试，必须启用缓存
                if (attempts > 1 && !retriesEnabled) {
                    console.warn("Aborting retry: Retries are not enabled for this request.");
                    break;
                }

                const context: StrategyContext = {
                    originalUrl: url, // --- 复用已解析的 URL 对象 ---
                    originalRequest: originalReq,
                    parsedBody: parsedBody,
                    isWebSocket: false,
                    ...details
                };

                const auth = await strategy.getAuthenticationDetails(c, context, attempts);

                if (attempts === 1) {
                    // 只有当重试启用时，才设置大于1的 maxRetries
                    maxRetries = retriesEnabled ? auth.maxRetries : 1;
                }

                // --- Body Transformation ---
                const transformedBody = strategy.transformRequestBody ? strategy.transformRequestBody(context.parsedBody, context) : context.parsedBody;
                const finalBody = transformedBody ? JSON.stringify(transformedBody) : (bodyBuffer ?? null);
                // --- End Body Transformation ---

                const [targetUrl, targetHeaders] = await Promise.all([
                    Promise.resolve(strategy.buildTargetUrl(context, auth)),
                    Promise.resolve(strategy.buildRequestHeaders(context, auth))
                ]);

                const res = await fetch(targetUrl, {
                    method: originalReq.method,
                    headers: targetHeaders,
                    body: finalBody,
                    signal: originalReq.signal,
                });

                if (!res.ok) {
                    const errorBodyText = await res.text();
                    console.error(`Upstream request to ${targetUrl.hostname} FAILED. Status: ${res.status}. Body: ${errorBodyText}`);
                    lastError = new Response(errorBodyText, { status: res.status, statusText: res.statusText, headers: res.headers });
                    if (attempts >= maxRetries) break; else continue;
                }
                
                const finalContext: StrategyContext = { ...context, parsedBody: transformedBody };
                return strategy.handleResponse ? await strategy.handleResponse(res, finalContext) : res;

            } catch (error) {
                if (error instanceof Response) {
                    lastError = error;
                    // 确保消费或取消 body，避免 Deno 中的资源泄漏警告
                    if (error.body && !error.bodyUsed) await error.body.cancel();
                    if (attempts >= maxRetries) break; else continue;
                }
                // 重新抛出未被捕获的严重错误
                throw error;
            }
        }
        return lastError ?? c.json({ error: "Request failed after all retries." }, 502);

    } catch (error) {
        console.error(`Critical error in handleGenericProxy for ${type}:`, error);
        if (error instanceof Response) {
            return error;
        }
        if (error instanceof Error && error.name === 'AbortError') {
            return new Response("Client disconnected", { status: 499 });
        }
        return c.json({ error: `Internal Server Error: ${error instanceof Error ? error.message : "Unknown"}` }, 500);
    }
};

// =================================================================================
// --- 2. Hono 服务器设置与启动 ---
// =================================================================================

const app = new Hono();

// --- 基础路由 ---
app.get('/', (c: Context) => c.text('LLM Gateway Service is running.'));
app.get('/robots.txt', (c: Context) => c.text('User-agent: *\nDisallow: /'));

// --- 通配符代理路由 ---

// This route specifically handles the resumable upload PUT requests from Gemini.
// It proxies the request to the actual Google Cloud Storage URL.
app.put('/google-upload-proxy/*', async (c: Context): Promise<Response> => {
    const GOOGLE_UPLOAD_HOST = 'https://upload.generativelanguage.googleapis.com';

    try {
        // The original path from Google is appended after '/google-upload-proxy'
        // e.g. /google-upload-proxy/upload/v1beta/files/abc -> /upload/v1beta/files/abc
        const googlePath = c.req.path.replace('/google-upload-proxy', '');

        // Reconstruct the full Google URL
        const targetUrl = new URL(googlePath, GOOGLE_UPLOAD_HOST);
        
        // Append original query parameters from the client request
        const query = c.req.query();
        Object.keys(query).forEach(key => targetUrl.searchParams.set(key, query[key]));

        const res = await fetch(targetUrl.toString(), {
            method: 'PUT',
            headers: {
                // Forward essential headers from the client
                'Content-Type': c.req.header('Content-Type') || '',
                'Content-Length': c.req.header('Content-Length') || '',
                ...Object.fromEntries(
                    [...c.req.raw.headers.entries()].filter(([key]) => key.toLowerCase().startsWith('x-goog-'))
                ),
            },
            body: c.req.raw.body,
        });

        return res;
    } catch (error) {
        console.error(`Gemini upload proxy failed:`, error);
        return c.text('Bad Gateway: Upstream upload request failed', 502);
    }
});

app.all('/*', handleGenericProxy);

// --- 全局错误处理 ---
app.onError((err: Error, c: Context) => {
    console.error(`Global Error Handler:`, err);
    if (err instanceof Response) return err;
    return c.json({ error: `Internal Error: ${err.message}` }, 500);
});

// --- 启动服务器 ---
Deno.serve(app.fetch);