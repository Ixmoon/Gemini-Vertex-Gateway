// src/auth.ts
//
// 该文件负责处理所有与认证和授权相关的逻辑。
// 它包括从请求中提取 API 密钥、根据规则选择要使用的密钥（用户、备用、池），
// 以及构建代理请求头等辅助函数。

import type { Context } from "hono";
import { configManager, poolKeySelector } from "./managers.ts";
import type { ApiKeyResult, AuthenticationDetails } from "./types.ts";

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
    // 否则，使用用户密钥作为种子，从密钥池中确定性地取一个密钥
    const poolKey = poolKeySelector.next(userKey);
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
export const _getGeminiAuthDetails = (c: Context, model: string | null, attempt: number, name: string): AuthenticationDetails => {
    const url = new URL(c.req.url); // 这里仍然需要解析，但这是调用链路的深层，暂时接受
    const userApiKey = getApiKeyFromReq(c, url);
    const config = configManager.getSync();
    const isModels = url.pathname.endsWith('/models');
    let result: ApiKeyResult | null = null;

    if (attempt === 1) {
        // 首次尝试
        result = getApiKeyForRequest(userApiKey, model);
        if (!result && !isModels) throw new Response(`No valid API key (${name})`, { status: 401 });
    } else if (userApiKey && config.triggerKeys.has(userApiKey)) {
        // 重试时，如果用户是触发密钥，则使用用户密钥作为种子尝试从池中获取下一个密钥
        // 注意：由于选择是确定性的，这实际上会返回与第一次尝试相同的池密钥。
        // 一个更高级的实现可能会将 'attempt' 数也纳入 key/seed，例如 `next(userApiKey + ':' + attempt)`
        // 但为了保持简单，我们暂时接受这种行为。
        const poolKey = poolKeySelector.next(userApiKey);
        if (poolKey) {
            result = { key: poolKey, source: 'pool' };
        } else if (!isModels) {
            throw new Response(`Key pool exhausted (${name})`, { status: 503 });
        }
    } else if (attempt > 1 && !isModels) {
        // 如果是普通用户的密钥，则不进行重试
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