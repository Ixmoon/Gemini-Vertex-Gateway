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
 * 处理 WebSocket 升级请求的通用分发器。
 */
const handleWebSocketProxy = async (c: Context): Promise<Response> => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
        return c.text('Expected Upgrade: websocket', 426);
    }

    const { type, ...details } = determineRequestType(c);

    if (type === "UNKNOWN") {
        return c.text(`WebSocket proxy not available for unknown route`, 404);
    }

    try {
        const strategy = await strategyManager.get(type);
        if (!strategy.handleWebSocketProxy) {
            return c.text(`WebSocket proxy is not implemented for the '${type}' strategy.`, 501);
        }

        const context: StrategyContext = {
            originalUrl: new URL(c.req.url),
            originalRequest: c.req.raw,
            parsedBody: null,
            isWebSocket: true,
            ...details
        };

        // 将处理逻辑完全委托给策略
        return await strategy.handleWebSocketProxy(c, context);

    } catch (error) {
        console.error(`Critical error in handleWebSocketProxy for type ${type}:`, error);
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

        const { bodyForFirstAttempt, getCachedBodyForRetry, parsedBodyPromise, retriesEnabled } = await strategy.prepareRequestBody(originalReq);

        let attempts = 0, maxRetries = 1, lastError: Response | null = null;
        let bodyForCurrentAttempt = bodyForFirstAttempt;

        while (attempts < maxRetries) {
            attempts++;
            try {
                if (attempts > 1) {
                    const cachedBody = await getCachedBodyForRetry();
                    if (!cachedBody) {
                        console.warn("Aborting retry: Body was not cached or cache failed.");
                        break;
                    }
                    bodyForCurrentAttempt = cachedBody;
                }

                const context: StrategyContext = {
                    originalUrl: url,
                    originalRequest: originalReq,
                    // 注意：我们现在异步等待解析后的 body
                    parsedBody: await parsedBodyPromise,
                    isWebSocket: false,
                    ...details
                };

                const auth = await strategy.getAuthenticationDetails(c, context, attempts);
                
                if (attempts === 1) {
                    maxRetries = retriesEnabled ? auth.maxRetries : 1;
                }
                
                const transformedBody = strategy.transformRequestBody
                    ? strategy.transformRequestBody(context.parsedBody, context)
                    : context.parsedBody;
                
                const bodyToSend = transformedBody && (typeof transformedBody === 'object')
                    ? JSON.stringify(transformedBody)
                    : bodyForCurrentAttempt;

                const [targetUrl, targetHeaders] = await Promise.all([
                    Promise.resolve(strategy.buildTargetUrl(context, auth)),
                    Promise.resolve(strategy.buildRequestHeaders(context, auth))
                ]);

                const res = await fetch(targetUrl, {
                    method: originalReq.method,
                    headers: targetHeaders,
                    body: bodyToSend,
                    signal: originalReq.signal,
                });

                if (!res.ok) {
                    const errorBodyText = await res.text();
                    console.error(`Upstream request to ${targetUrl.hostname} FAILED. Status: ${res.status}. Body: ${errorBodyText}`);
                    lastError = new Response(errorBodyText, { status: res.status, statusText: res.statusText, headers: res.headers });
                    if (attempts >= maxRetries) break; else continue;
                }
                
                const finalContext: StrategyContext = { ...context, parsedBody: transformedBody };
                return strategy.handleResponse ? await strategy.handleResponse(res, finalContext, auth) : res;

            } catch (error) {
                if (error instanceof Response) {
                    // 克隆响应以避免 "body already consumed" 错误。
                    // 我们读取 body 文本，然后为 lastError 创建一个新的 Response 对象。
                    const errorBodyText = await error.text(); // 消费原始错误响应的 body
                    lastError = new Response(errorBodyText, { // 创建一个全新的响应
                        status: error.status,
                        statusText: error.statusText,
                        headers: error.headers,
                    });

                    if (attempts >= maxRetries) break; else continue;
                }
                // 如果不是 Response 实例，则重新抛出，因为这是意外错误。
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