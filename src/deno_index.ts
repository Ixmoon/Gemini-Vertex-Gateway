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
 * 根据请求路径确定请求类型和相关细节。
 * @param req Hono 请求对象
 * @returns 返回一个包含请求类型、路径前缀和处理路径的对象。
 */
const determineRequestType = (req: Request): { type: RequestType | "UNKNOWN", prefix: string | null, path: string } => {
    const { pathname } = new URL(req.url);

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
    const { type, ...details } = determineRequestType(originalReq);

    if (type === "UNKNOWN") {
        return c.json({ error: `No route for path: ${new URL(originalReq.url).pathname}` }, 404);
    }

    try {
        const strategy = await strategyManager.get(type);

        // --- Body Caching Logic for Retries ---
        let bodyBufferPromise: Promise<ArrayBuffer | null> | null = null;
        let requestForFirstAttempt = originalReq;

        // 只有在需要重试的请求方法中才缓存 body
        if (originalReq.body && (originalReq.method === 'POST' || originalReq.method === 'PUT' || originalReq.method === 'PATCH')) {
            const [stream1, stream2] = originalReq.body.tee();
            requestForFirstAttempt = new Request(originalReq, { body: stream1 });
            bodyBufferPromise = (async () => {
                try {
                    return await new Response(stream2).arrayBuffer();
                } catch (e) {
                    console.error("Error buffering request body:", e);
                    return null; // 如果缓存失败则返回 null
                }
            })();
        }
        // --- End of Body Caching Logic ---

        let attempts = 0, maxRetries = 1, lastError: Response | null = null;

        while (attempts < maxRetries) {
            attempts++;
            try {
                let currentRequest = requestForFirstAttempt;
                // 对于重试，使用缓存的 body
                if (attempts > 1) {
                    if (!bodyBufferPromise) {
                        throw new Error("Cannot retry request: original body was not buffered.");
                    }
                    const bodyBuffer = await bodyBufferPromise;
                    if (bodyBuffer === null) {
                        throw new Error("Cannot retry request: body buffering failed.");
                    }
                    currentRequest = new Request(originalReq, { body: bodyBuffer });
                }

                const context: StrategyContext = {
                    originalUrl: new URL(currentRequest.url),
                    originalRequest: currentRequest,
                    ...details
                };

                const auth = await strategy.getAuthenticationDetails(c, context, attempts);
                
                if (attempts === 1) {
                    maxRetries = auth.maxRetries;
                }

                const [targetUrl, targetBody, targetHeaders] = await Promise.all([
                    Promise.resolve(strategy.buildTargetUrl(context, auth)),
                    Promise.resolve(strategy.processRequestBody(context)),
                    Promise.resolve(strategy.buildRequestHeaders(context, auth))
                ]);

                const res = await fetch(targetUrl, {
                    method: currentRequest.method,
                    headers: targetHeaders,
                    body: targetBody,
                    signal: currentRequest.signal,
                });

                if (!res.ok) {
                    const errorBodyText = await res.text();
                    console.error(`Upstream request to ${targetUrl.hostname} FAILED. Status: ${res.status}. Body: ${errorBodyText}`);
                    lastError = new Response(errorBodyText, { status: res.status, statusText: res.statusText, headers: res.headers });
                    // 对于客户端错误 (4xx)，除非是 429 (Too Many Requests)，否则不应重试
                    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                        break;
                    }
                    if (attempts >= maxRetries) break; else continue;
                }
                
                const finalContext: StrategyContext = {
                    originalUrl: new URL(originalReq.url),
                    originalRequest: originalReq,
                    ...details
                };
                return strategy.handleResponse ? await strategy.handleResponse(res, finalContext) : res;

            } catch (error) {
                if (error instanceof Response) {
                    lastError = error;
                    // 确保消费或取消 body，避免 Deno 中的资源泄漏警告
                    if (error.body && !error.bodyUsed) await error.body.cancel();
                    if (error.status >= 400 && error.status < 500) break;
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