// src/auth.ts
//
// 该文件负责处理所有与认证和授权相关的逻辑。
// 它包括从请求中提取 API 密钥、根据规则选择要使用的密钥（用户、备用、池），
// 以及构建代理请求头等辅助函数。

import type { Context } from "hono";
import { configManager, poolKeySelector } from "./managers.ts";
import type { ApiKeyResult, AuthenticationDetails, StrategyContext } from "./types.ts";

/**
 * 从请求中提取 API 密钥。
 * 支持从 URL 查询参数 'key'、Authorization Bearer Token 或 'x-goog-api-key' 头中获取。
 * @param c Hono 上下文对象
 * @param url 解析后的 URL 对象
 * @returns 提取到的 API 密钥，如果未找到则返回 null。
 */
export const getApiKeyFromReq = (c: Context, url: URL): string | null => {
    return url.searchParams.get('key') || c.req.header("Authorization")?.replace(/^bearer\s+/i, '') || c.req.header("x-goog-api-key") || null;
};

/**
 * 构建基础的代理请求头。
 * 主要是复制原始请求头并移除 'host' 头，以避免下游服务器出现问题。
 * @param h 原始请求的 Headers 对象
 * @returns 新的 Headers 对象
 */
/**
 * 根据我们最终确定的清单，判断一个请求是否为有状态的。
 * @param ctx 策略上下文对象
 * @returns 如果请求被视为有状态，则返回 true，否则返回 false。
 */
export const isStatefulRequest = (ctx: StrategyContext): boolean => {
    // 检查 WebSocket
    if (ctx.isWebSocket) return true;

    // 检查路径中是否包含有状态的 API 端点名称，忽略版本号
    const statefulEndpoints = ['/files', '/tunedModels', '/operations', '/corpora'];
    if (statefulEndpoints.some(p => ctx.path.includes(p))) return true;

    // 检查 generateContent 请求体中是否引用了 fileData
    if (ctx.parsedBody?.contents?.some((c: any) => c.parts?.some((p: any) => 'fileData' in p))) {
        return true;
    }

    return false;
};

export const buildBaseProxyHeaders = (h: Headers): Headers => {
    const n = new Headers();
    h.forEach((value, key) => {
        n.set(key, value);
    });
    n.delete('host');
    return n;
};

/**
 * 根据用户密钥和模型，决定本次请求应使用哪个 API 密钥。
 * @param userKey 从请求中提取的用户 API 密钥。
 * @param model 请求中指定的模型名称。
 * @returns 返回一个包含密钥和来源的对象，如果无可用密钥则返回 null。
 */
const getApiKeyForRequest = (userKey: string | null, model: string | null): ApiKeyResult | null => {
    if (!userKey) return null;
    const config = configManager.getSync();
    // 如果用户密钥不是触发密钥，则直接使用用户自己的密钥
    if (!config.triggerKeys.has(userKey)) return { key: userKey, source: 'user' };
    // 如果模型在备用模型列表中，则优先使用备用密钥
    if (model && config.fallbackModels.has(model.trim())) {
        if (config.fallbackKey) return { key: config.fallbackKey, source: 'fallback' };
    }
    // 否则，从密钥池中取一个密钥
    const poolKey = poolKeySelector.next();
    if (poolKey) return { key: poolKey, source: 'pool' };
    // 如果密钥池也用尽，则返回 null
    return null;
};

/**
 * 为 Gemini 相关的请求获取认证详情。
 * 这是 GeminiNative 和 GeminiOpenAI 策略共享的逻辑。
 * @param c Hono 上下文
 * @param model 模型名称
 * @param attempt 当前重试次数
 * @param name 策略名称（用于日志）
 * @returns 返回认证详情对象
 */
export const _getGeminiAuthDetails = (c: Context, ctx: StrategyContext, model: string | null, attempt: number, name: string): AuthenticationDetails => {
            const config = configManager.getSync();
            const userApiKey = getApiKeyFromReq(c, ctx.originalUrl);
            const isTriggerKey = userApiKey ? config.triggerKeys.has(userApiKey) : false;

            // 1. 如果是真实密钥用户，直接使用他们的密钥，不进行任何拦截。
            if (userApiKey && !isTriggerKey) {
                return { key: userApiKey, source: 'user', gcpToken: null, gcpProject: null, maxRetries: 1 };
            }

            // 2. 如果是触发密钥用户，则根据请求是否有状态来决定策略。
            if (isTriggerKey && isStatefulRequest(ctx)) {
                if (config.fallbackKey) {
                    // 对于有状态请求，强制使用备用密钥，不进行重试。
                    return { key: config.fallbackKey, source: 'fallback', gcpToken: null, gcpProject: null, maxRetries: 1 };
                } else {
                    // 如果没有配置备用密钥，则无法处理有状态请求。
                    throw new Response(`Stateful request with Trigger Key cannot be processed: No fallbackKey configured.`, { status: 503 });
                }
            }

            // 3. 对于触发密钥的无状态请求（或没有提供密钥的请求），执行现有的轮询和重试逻辑。
            const isModels = ctx.path.endsWith('/models');
            let result: ApiKeyResult | null = null;
        
            if (attempt === 1) {
                result = getApiKeyForRequest(userApiKey, model);
                if (!result && !isModels) throw new Response(`No valid API key (${name})`, { status: 401 });
            } else if (isTriggerKey) { // 重试只对触发密钥有效
                const poolKey = poolKeySelector.next();
                if (poolKey) {
                    result = { key: poolKey, source: 'pool' };
                } else if (!isModels) {
                    throw new Response(`Key pool exhausted (${name})`, { status: 503 });
                }
            } else if (attempt > 1 && !isModels) {
                throw new Response(`Request failed, non-trigger key won't be retried (${name})`, { status: 503 });
            }
        
            return {
                key: result?.key || null,
                source: result?.source || null,
                gcpToken: null,
                gcpProject: null,
                maxRetries: result?.source === 'pool' ? config.apiRetryLimit : 1
            };
        };