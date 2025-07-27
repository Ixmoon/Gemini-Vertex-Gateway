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
    const statefulEndpoints = ['/files', '/tunedModels', '/operations', '/corpora', '/batches'];
    if (statefulEndpoints.some(p => ctx.path.includes(p))) return true;

    // 检查 generateContent 请求体中是否引用了 fileData 或 file_data
    if (ctx.parsedBody?.contents?.some((c: any) => c.parts?.some((p: any) => 'fileData' in p || 'file_data' in p))) {
        return true;
    }

    return false;
};

export const buildBaseProxyHeaders = (h: Headers): Headers => {
    const n = new Headers(h);
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

    // --- 1. 快速通道：如果用户使用自己的密钥，则直接返回，无需进行状态检查 ---
    // 无论请求是有状态还是无状态，使用自己密钥的逻辑都是相同的。
    if (userApiKey && !isTriggerKey) {
        return { key: userApiKey, source: 'user', gcpToken: null, gcpProject: null, maxRetries: 1 };
    }

    // --- 2. 触发密钥和无密钥请求的逻辑 ---

    // a) 处理有状态请求（此时仅可能是触发密钥或无密钥）
    if (isStatefulRequest(ctx)) {
        if (isTriggerKey) {
            // 对于触发密钥发起的有状态请求，必须使用备用密钥
            if (config.fallbackKey) {
                return { key: config.fallbackKey, source: 'fallback', gcpToken: null, gcpProject: null, maxRetries: 1 };
            } else {
                throw new Response(`Stateful request with Trigger Key cannot be processed: No fallbackKey configured.`, { status: 503 });
            }
        } else {
            // 拒绝无密钥的有状态请求
            // (有密钥但非触发密钥的情况已在上面的快速通道中处理)
            throw new Response(`Stateful requests require an API key.`, { status: 401 });
        }
    }

    // b) 处理无状态请求（此时仅可能是触发密钥或无密钥）
    const isModels = ctx.path.endsWith('/models');
    let result: ApiKeyResult | null = null;

    if (attempt === 1) {
        // 首次尝试：根据模型决定使用备用密钥还是池密钥
        result = getApiKeyForRequest(userApiKey, model);
        if (!result && !isModels) throw new Response(`No valid API key (${name})`, { status: 401 });
    } else if (isTriggerKey) {
        // 重试时（仅对触发密钥有效）：总是从池中获取
        const poolKey = poolKeySelector.next();
        if (poolKey) {
            result = { key: poolKey, source: 'pool' };
        } else if (!isModels) {
            throw new Response(`Key pool exhausted (${name})`, { status: 503 });
        }
    } else if (attempt > 1 && !isModels) {
        // 非触发密钥不应进入重试逻辑，但作为保险措施
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