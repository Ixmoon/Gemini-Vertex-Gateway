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

// =================================================================================
// --- 1. 策略选择器与主处理函数 ---
// =================================================================================

/**
 * 根据请求的 URL 对象确定请求类型和相关细节。
 * @param url 解析后的 URL 对象
 * @returns 返回一个包含请求类型、路径前缀和处理路径的对象。
 */
const determineRequestType = (url: URL): { type: RequestType | "UNKNOWN", prefix: string | null, path: string } => {
    const { pathname } = url;

    // 1. Vertex AI 的路径有特殊前缀
    if (pathname.startsWith('/vertex/')) {
        return { type: "VERTEX_AI", prefix: '/vertex', path: pathname.slice('/vertex'.length) };
    }

    // 2. 检查 Gemini 的特殊路径
    if (pathname.startsWith('/gemini/')) {
        const prefix = '/gemini';
        const path = pathname.slice(prefix.length);
        // 根据路径是否包含 /v1beta/ 来区分是 OpenAI 兼容模式还是原生模式
        return { type: path.startsWith('/v1beta/') ? "GEMINI_NATIVE" : "GEMINI_OPENAI", prefix, path };
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
 * 通用代理处理函数。
 * 这是所有代理请求的入口点。
 */
const handleGenericProxy = async (c: Context): Promise<Response> => {
    const originalReq = c.req.raw;
    const url = new URL(originalReq.url); // --- 只解析一次 URL ---
    const { type, ...details } = determineRequestType(url);

    if (type === "UNKNOWN") {
        return c.json({ error: `No route for path: ${url.pathname}` }, 404);
    }

    try {
        const strategy = await strategyManager.get(type);

        // --- Unified Body Caching & Parsing ---
        const MAX_BUFFER_SIZE_BYTES = 1 * 1024 * 1024; // 1MB
        let bodyBuffer: ArrayBuffer | null = null;
        let parsedBody: Record<string, any> | null = null;
        let retriesEnabled = false;

        if (originalReq.body) {
            const contentLength = parseInt(originalReq.headers.get('content-length') || '0', 10);
            if (contentLength > 0 && contentLength < MAX_BUFFER_SIZE_BYTES) {
                try {
                    bodyBuffer = await originalReq.arrayBuffer();
                    retriesEnabled = true;
                    if (originalReq.headers.get('content-type')?.includes('application/json')) {
                        // 使用 TextDecoder 将 ArrayBuffer 转换为字符串
                        const bodyText = new TextDecoder().decode(bodyBuffer);
                        parsedBody = JSON.parse(bodyText);
                    }
                } catch (e) {
                    console.error("Error buffering or parsing request body:", e);
                    return c.json({ error: "Invalid request body provided." }, 400);
                }
            } else {
                if (contentLength >= MAX_BUFFER_SIZE_BYTES) {
                    console.warn(`Request body size (${contentLength} bytes) exceeds limit. Retries disabled.`);
                } else {
                     console.warn(`Request body size is unknown or zero. Retries disabled.`);
                }
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
app.all('/*', handleGenericProxy);

// --- 全局错误处理 ---
app.onError((err: Error, c: Context) => {
    console.error(`Global Error Handler:`, err);
    if (err instanceof Response) return err;
    return c.json({ error: `Internal Error: ${err.message}` }, 500);
});

// --- 启动服务器 ---
Deno.serve(app.fetch);