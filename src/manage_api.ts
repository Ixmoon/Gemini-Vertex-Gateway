/**
 * L3 - 应用层 (管理API)
 * 提供用于管理配置的 RESTful API 端点。
 */
import { Hono, Context } from "hono";
import { cors } from "hono/middleware";
import * as logic from "./config_logic.ts";

const manageApp = new Hono();

// --- 中间件 ---
manageApp.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'X-Admin-Password'],
}));

const authMiddleware = async (c: Context, next: () => Promise<void>) => {
    // 登录路由本身不需要认证
	if (c.req.path === '/login') {
		return await next();
	}
	const password = c.req.header('X-Admin-Password');
	if (!password || !(await logic.verifyAdminPassword(password))) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
};
// Apply middleware to all routes except /login
manageApp.use('*', authMiddleware);


// --- 辅助函数 ---
const handleApi = async <T>(
    c: Context, // Pass context first
    handler: () => Promise<T>,
    successMessage: string | ((result: T) => string),
    errorMessagePrefix: string
): Promise<Response> => {
    try {
        const result = await handler();
        const message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
        // Ensure result is always wrapped in an object for consistent responses
        const payloadData = (result !== null && typeof result === 'object' && !Array.isArray(result)) ? result : { data: result };
        return c.json({ success: true, message, ...payloadData }, 200);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = (e instanceof TypeError || message.toLowerCase().includes("invalid") || message.toLowerCase().includes("must be")) ? 400 : 500;
        return c.json({ success: false, error: `${errorMessagePrefix}: ${message}` }, status);
    }
};

// --- 路由定义 ---

// 登录
manageApp.post('/login', async (c) => {
	const { password } = await c.req.json().catch(() => ({ password: null }));
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

// --- List-based configs (Trigger Keys, Pool Keys, Fallback Models) ---
// This generic handler creates all necessary endpoints for a list-based configuration
const createListEndpoints = (
    path: string,
    name: string,
    getter: () => Promise<Set<string> | string[]>,
    setter: (items: string[]) => Promise<void>
) => {
    manageApp.get(`/${path}`, (c) => handleApi(c, async () => ({ [path]: Array.from(await getter()) }), `${name} fetched.`, `Failed to fetch ${name}`));
    manageApp.post(`/${path}`, async (c) => {
        const body = await c.req.json().catch(() => null);
        const items = body?.[path];
        if (!Array.isArray(items) || !items.every(i => typeof i === 'string')) return c.json({ error: `Invalid input: ${path} must be an array of strings.` }, 400);
        return handleApi(c, () => setter(items), `${name} list updated.`, `Failed to update ${name} list`);
    });
    manageApp.delete(`/${path}/all`, (c) => handleApi(c, () => setter([]), `All ${name} cleared.`, `Failed to clear ${name}`));
};

createListEndpoints('trigger-keys', 'Trigger Keys', logic.getTriggerKeys, logic.setTriggerKeys);
createListEndpoints('pool-keys', 'Pool Keys', logic.getPoolKeys, logic.setPoolKeys);
createListEndpoints('fallback-models', 'Fallback Models', logic.getFallbackModels, logic.setFallbackModels);

// 指定密钥 (Fallback Key)
manageApp.get('/fallback-key', (c) => handleApi(c, async () => ({ key: await logic.getFallbackKey() }), "Fallback key fetched.", "Failed to fetch fallback key"));
manageApp.post('/fallback-key', async (c) => {
	const { key } = await c.req.json().catch(() => ({ key: undefined })); // key can be null or empty string to clear
    if (key !== undefined && key !== null && typeof key !== 'string') return c.json({ error: "Invalid key provided, must be a string or null." }, 400);
	return handleApi(c, () => logic.setFallbackKey(key), "Fallback key updated.", "Failed to update fallback key");
});

// 重试次数
manageApp.get('/retry-limit', (c) => handleApi(c, async () => ({ limit: await logic.getApiRetryLimit() }), "Retry limit fetched.", "Failed to fetch retry limit"));
manageApp.post('/retry-limit', async (c) => {
	const { limit } = await c.req.json().catch(() => ({ limit: null }));
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) return c.json({ error: "Invalid limit: must be a positive integer." }, 400);
	return handleApi(c, () => logic.setApiRetryLimit(limit), "Retry limit updated.", "Failed to update retry limit");
});

// GCP 配置
manageApp.get('/gcp-settings', (c) => handleApi(c, async () => ({
	credentials: await logic.getGcpCredentialsString(),
	location: await logic.getGcpDefaultLocation(),
}), "GCP settings fetched.", "Failed to fetch GCP settings"));
manageApp.post('/gcp-settings', async (c) => {
	const { credentials, location } = await c.req.json().catch(() => ({}));
    if (credentials !== undefined && credentials !== null && typeof credentials !== 'string') return c.json({ error: "Invalid credentials: must be a string or null." }, 400);
    if (location !== undefined && (typeof location !== 'string' || !location.trim())) return c.json({ error: "Invalid location: must be a non-empty string." }, 400);

	return handleApi(c, async () => {
		const promises = [];
		if (credentials !== undefined) promises.push(logic.setGcpCredentialsString(credentials));
		if (location !== undefined) promises.push(logic.setGcpDefaultLocation(location.trim()));
		await Promise.all(promises);
	}, "GCP settings updated.", "Failed to update GCP settings");
});

// API 路径映射
manageApp.get('/api-mappings', (c) => handleApi(c, async () => ({ mappings: await logic.getApiMappings() }), "API mappings fetched.", "Failed to fetch API mappings"));
manageApp.post('/api-mappings', async (c) => {
	const { mappings } = await c.req.json().catch(() => ({}));
    if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) {
        return c.json({ error: "Invalid mappings: must be an object." }, 400);
    }
	if (mappings['/gemini'] || mappings['/vertex']) { // Reserved paths
		return c.json({ error: "Cannot override reserved paths: /gemini, /vertex" }, 400);
	}
    for (const prefix in mappings) {
        if (!prefix.startsWith('/')) return c.json({ error: `Invalid prefix "${prefix}": must start with /.` }, 400);
        try { new URL(mappings[prefix]); } catch { return c.json({ error: `Invalid URL for prefix "${prefix}": ${mappings[prefix]}.` }, 400); }
    }
	return handleApi(c, () => logic.setApiMappings(mappings), "API mappings updated.", "Failed to update API mappings");
});

export { manageApp };