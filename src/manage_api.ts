/**
 * L3 - 应用层 (管理API)
 * 提供用于管理配置的 RESTful API 端点。
 */
import { Hono } from "hono";
import { cors } from "hono/middleware";
import * as logic from "./config_logic.ts";

const manageApp = new Hono();

// --- 中间件 ---
manageApp.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'X-Admin-Password'],
}));
manageApp.use('*', async (c, next) => {
	if (c.req.path.endsWith('/login')) {
		return await next();
	}
	const password = c.req.header('X-Admin-Password');
	if (!password || !(await logic.verifyAdminPassword(password))) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
});

// --- 辅助函数 ---
const handleApi = async <T>(
    handler: () => Promise<T>,
    successMessage: string | ((result: T) => string),
    errorMessagePrefix: string,
    c: any // Hono Context for returning response directly
): Promise<Response> => {
    try {
        const result = await handler();
        const message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
        const payloadData = (result !== null && typeof result === 'object') ? result : { data: result };
        return c.json({ message, ...payloadData }, 200);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = (e instanceof TypeError || message.toLowerCase().includes("invalid") || message.toLowerCase().includes("must be")) ? 400 : 500;
        return c.json({ error: `${errorMessagePrefix}: ${message}` }, status);
    }
};

// --- 路由定义 ---

// 登录
manageApp.post('/login', async (c) => {
	const { password } = await c.req.json();
	if (!password || typeof password !== 'string') {
        return c.json({ success: false, error: "Password must be a string." }, 400);
    }
	const hash = await logic.getAdminPasswordHash();
	if (hash) {
		if (await logic.verifyAdminPassword(password)) {
			return c.json({ success: true, message: "Login successful." });
		}
		return c.json({ success: false, error: "Invalid password." }, 401);
	} else {
		if (password.length >= 8) {
			try {
                await logic.setAdminPassword(password);
                return c.json({ success: true, message: "Admin password set and logged in." });
            } catch (e) {
                return c.json({ success: false, error: `Failed to set password: ${e instanceof Error ? e.message : String(e)}` }, 500);
            }
		}
		return c.json({ success: false, error: "Admin password not set. Provide a password (min 8 chars) to set it." }, 401);
	}
});

// 触发密钥
manageApp.get('/trigger-keys', (c) => handleApi(async () => ({ keys: Array.from(await logic.getTriggerKeys()) }), "Trigger keys fetched.", "Failed to fetch trigger keys", c));
manageApp.post('/trigger-keys', async (c) => { // Bulk update
	const { keys } = await c.req.json();
	if (!Array.isArray(keys) || !keys.every(k => typeof k === 'string')) return c.json({ error: "Invalid input: keys must be an array of strings." }, 400);
	return handleApi(() => logic.setTriggerKeys(keys), "Trigger keys list updated.", "Failed to update trigger keys list", c);
});
manageApp.post('/trigger-keys/add', async (c) => {
    const { key } = await c.req.json();
    if (!key || typeof key !== 'string' || !key.trim()) return c.json({ error: "Invalid key provided." }, 400);
    return handleApi(async () => {
        const keys = await logic.getTriggerKeys();
        keys.add(key.trim());
        await logic.setTriggerKeys(Array.from(keys));
    }, `Trigger key "${key.trim()}" added.`, "Failed to add trigger key", c);
});
manageApp.delete('/trigger-keys/remove', async (c) => {
    const { key } = await c.req.json();
    if (!key || typeof key !== 'string' || !key.trim()) return c.json({ error: "Invalid key provided." }, 400);
    return handleApi(async () => {
        const keys = await logic.getTriggerKeys();
        keys.delete(key.trim());
        await logic.setTriggerKeys(Array.from(keys));
    }, `Trigger key "${key.trim()}" removed.`, "Failed to remove trigger key", c);
});
manageApp.delete('/trigger-keys/all', (c) => handleApi(() => logic.setTriggerKeys([]), "All trigger keys cleared.", "Failed to clear trigger keys", c));


// 主密钥池
manageApp.get('/pool-keys', (c) => handleApi(async () => ({ keys: await logic.getPoolKeys() }), "Pool keys fetched.", "Failed to fetch pool keys", c));
manageApp.post('/pool-keys', async (c) => { // Bulk update
	const { keys } = await c.req.json();
	if (!Array.isArray(keys) || !keys.every(k => typeof k === 'string')) return c.json({ error: "Invalid input: keys must be an array of strings." }, 400);
	return handleApi(() => logic.setPoolKeys(keys), "Pool keys list updated.", "Failed to update pool keys list", c);
});
manageApp.post('/pool-keys/add', async (c) => {
    const { key } = await c.req.json();
    if (!key || typeof key !== 'string' || !key.trim()) return c.json({ error: "Invalid key provided." }, 400);
    return handleApi(async () => {
        const keys = await logic.getPoolKeys(); // Array
        const trimmedKey = key.trim();
        if (!keys.includes(trimmedKey)) {
            keys.push(trimmedKey);
        }
        await logic.setPoolKeys(keys);
    }, `Pool key added.`, "Failed to add pool key", c);
});
manageApp.delete('/pool-keys/remove', async (c) => {
    const { key } = await c.req.json();
    if (!key || typeof key !== 'string' || !key.trim()) return c.json({ error: "Invalid key provided." }, 400);
    return handleApi(async () => {
        let keys = await logic.getPoolKeys();
        keys = keys.filter(k => k !== key.trim());
        await logic.setPoolKeys(keys);
    }, `Pool key removed.`, "Failed to remove pool key", c);
});
manageApp.delete('/pool-keys/all', (c) => handleApi(() => logic.setPoolKeys([]), "All pool keys cleared.", "Failed to clear pool keys", c));


// 指定密钥 (Fallback Key)
manageApp.get('/fallback-key', (c) => handleApi(async () => ({ key: await logic.getFallbackKey() }), "Fallback key fetched.", "Failed to fetch fallback key", c));
manageApp.post('/fallback-key', async (c) => {
	const { key } = await c.req.json(); // key can be null or empty string to clear
    if (key !== null && typeof key !== 'string') return c.json({ error: "Invalid key provided, must be a string or null." }, 400);
	return handleApi(() => logic.setFallbackKey(key), "Fallback key updated.", "Failed to update fallback key", c);
});

// 指定模型 (Fallback Models)
manageApp.get('/fallback-models', (c) => handleApi(async () => ({ models: Array.from(await logic.getFallbackModels()) }), "Fallback models fetched.", "Failed to fetch fallback models", c));
manageApp.post('/fallback-models', async (c) => { // Bulk update
	const { models } = await c.req.json();
	if (!Array.isArray(models) || !models.every(m => typeof m === 'string')) return c.json({ error: "Invalid input: models must be an array of strings." }, 400);
	return handleApi(() => logic.setFallbackModels(models), "Fallback models updated.", "Failed to update fallback models", c);
});
manageApp.post('/fallback-models/add', async (c) => {
    const { model } = await c.req.json();
    if (!model || typeof model !== 'string' || !model.trim()) return c.json({ error: "Invalid model name provided." }, 400);
    return handleApi(async () => {
        const models = await logic.getFallbackModels(); // Set
        models.add(model.trim());
        await logic.setFallbackModels(Array.from(models));
    }, `Fallback model "${model.trim()}" added.`, "Failed to add fallback model", c);
});
manageApp.delete('/fallback-models/remove', async (c) => {
    const { model } = await c.req.json();
    if (!model || typeof model !== 'string' || !model.trim()) return c.json({ error: "Invalid model name provided." }, 400);
    return handleApi(async () => {
        const models = await logic.getFallbackModels(); // Set
        models.delete(model.trim());
        await logic.setFallbackModels(Array.from(models));
    }, `Fallback model "${model.trim()}" removed.`, "Failed to remove fallback model", c);
});
manageApp.delete('/fallback-models/all', (c) => handleApi(() => logic.setFallbackModels([]), "All fallback models cleared.", "Failed to clear fallback models", c));


// 重试次数
manageApp.get('/retry-limit', (c) => handleApi(async () => ({ limit: await logic.getApiRetryLimit() }), "Retry limit fetched.", "Failed to fetch retry limit", c));
manageApp.post('/retry-limit', async (c) => {
	const { limit } = await c.req.json();
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) return c.json({ error: "Invalid limit: must be a positive integer." }, 400);
	return handleApi(() => logic.setApiRetryLimit(limit), "Retry limit updated.", "Failed to update retry limit", c);
});

// GCP 配置
manageApp.get('/gcp-settings', (c) => handleApi(async () => ({
	credentials: await logic.getGcpCredentialsString(),
	location: await logic.getGcpDefaultLocation(),
}), "GCP settings fetched.", "Failed to fetch GCP settings", c));
manageApp.post('/gcp-settings', async (c) => {
	const { credentials, location } = await c.req.json();
    if (credentials !== undefined && credentials !== null && typeof credentials !== 'string') return c.json({ error: "Invalid credentials: must be a string or null." }, 400);
    if (location !== undefined && (typeof location !== 'string' || !location.trim())) return c.json({ error: "Invalid location: must be a non-empty string." }, 400);

	return handleApi(async () => {
		if (credentials !== undefined) await logic.setGcpCredentialsString(credentials); // Allow null to clear
		if (location !== undefined) await logic.setGcpDefaultLocation(location.trim());
	}, "GCP settings updated.", "Failed to update GCP settings", c);
});

// API 路径映射
manageApp.get('/api-mappings', (c) => handleApi(async () => ({ mappings: await logic.getApiMappings() }), "API mappings fetched.", "Failed to fetch API mappings", c));
manageApp.post('/api-mappings', async (c) => {
	const { mappings } = await c.req.json();
    if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) {
        return c.json({ error: "Invalid mappings: must be an object." }, 400);
    }
	if (mappings['/gemini'] || mappings['/vertex']) { // Reserved paths
		return c.json({ error: "Cannot override reserved paths: /gemini, /vertex" }, 400);
	}
    // Add more validation for prefixes (start with /) and URLs if needed
    for (const prefix in mappings) {
        if (!prefix.startsWith('/')) {
            return c.json({ error: `Invalid prefix "${prefix}": must start with /.` }, 400);
        }
        try {
            new URL(mappings[prefix]);
        } catch {
            return c.json({ error: `Invalid URL for prefix "${prefix}": ${mappings[prefix]}.` }, 400);
        }
    }
	return handleApi(() => logic.setApiMappings(mappings), "API mappings updated.", "Failed to update API mappings", c);
});

export { manageApp };