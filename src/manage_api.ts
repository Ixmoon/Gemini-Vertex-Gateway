/**
 * @file 后台管理 API
 * @description
 * 提供了一套受密码保护的 RESTful API，用于管理网关的所有配置项。
 * 使用 Hono 子应用实现，并通过中间件进行统一的 CORS 和密码认证处理。
 */
import { Hono, Context } from "hono";
import { cors } from "hono/middleware";
import * as kvOps from "./replacekeys.ts";
import { ensureKv } from "./replacekeys.ts";

// --- 辅助函数：创建标准化的 JSON 响应 ---
function createErrorPayload(message: string, status = 500) {
	return new Response(JSON.stringify({ error: message, success: false }), {
		status, headers: { "Content-Type": "application/json" },
	});
}
function createSuccessPayload(data: Record<string, any>, status = 200) {
	return new Response(JSON.stringify({ ...data, success: true }), {
		status, headers: { "Content-Type": "application/json" },
	});
}

// --- 中间件 ---

/** 管理员密码认证中间件 */
const adminAuthMiddleware = async (c: Context, next: () => Promise<void>) => {
	// 确保 KV 连接已建立，因为管理操作会直接读写 KV
	try {
		await ensureKv();
	} catch (kvError) {
		return c.json({ error: "Internal Server Error: Could not connect to data store." }, 500);
	}

	const adminPassword = c.req.header('X-Admin-Password');
	if (!adminPassword) {
		return c.json({ error: "Unauthorized: Missing X-Admin-Password header" }, 401);
	}
	// `verifyAdminPassword` 直接访问 KV 进行验证
	const isValid = await kvOps.verifyAdminPassword(adminPassword);
	if (!isValid) {
		return c.json({ error: "Unauthorized: Invalid X-Admin-Password" }, 401);
	}
	await next();
};

// --- Hono 子应用实例 ---
export const manageApp = new Hono();

// 对所有管理 API 路由应用 CORS 和认证中间件
manageApp.use('*', cors({ origin: '*' }));
manageApp.use('*', adminAuthMiddleware);

// --- API 路由定义 ---

// 统一的 API 调用处理器，封装了 try-catch 和标准响应格式
async function handleManageApiCall<T>(
	logic: () => Promise<T>,
	successMessage: string | ((result: T) => string),
	errorMessagePrefix: string
): Promise<Response> {
	try {
		const result = await logic();
		const message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
		const payloadData = (result !== null && typeof result === 'object' && !Array.isArray(result)) ? result : { data: result };
		return createSuccessPayload({ ...payloadData, message });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return createErrorPayload(`${errorMessagePrefix}: ${message}`, error instanceof TypeError ? 400 : 500);
	}
}

// 辅助函数，用于处理接收 JSON 数组的 POST 请求
async function handleJsonListPost<T>(c: Context, key: string, handler: (items: T[]) => Promise<void>, successMsg: string, errorMsg: string) {
	try {
		const body = await c.req.json();
		const items = body[key];
		if (!Array.isArray(items)) return createErrorPayload(`Invalid input: '${key}' must be an array.`, 400);
		return handleManageApiCall(() => handler(items), successMsg, errorMsg);
	} catch (e) {
		return createErrorPayload(`Invalid JSON body: ${e.message}`, 400);
	}
}

// 触发密钥
manageApp.get('/trigger-keys', (c) => handleManageApiCall(async () => ({ keys: Array.from(await kvOps.getTriggerKeys()) }), "Trigger keys fetched.", "Failed to get trigger keys"));
manageApp.post('/trigger-keys', async (c) => handleManageApiCall(() => kvOps.addTriggerKey((await c.req.json()).key), "Trigger key added.", "Failed to add trigger key"));
manageApp.delete('/trigger-keys', async (c) => handleManageApiCall(() => kvOps.removeTriggerKey((await c.req.json()).key), "Trigger key removed.", "Failed to remove trigger key"));

// 密钥池
manageApp.get('/pool-keys', (c) => handleManageApiCall(async () => ({ keys: await kvOps.getPoolKeys() }), "Pool keys fetched.", "Failed to get pool keys"));
manageApp.post('/pool-keys', (c) => handleJsonListPost(c, 'keys', kvOps.addPoolKeys, "Pool keys updated.", "Failed to update pool keys"));
manageApp.delete('/pool-keys/all', (c) => handleManageApiCall(kvOps.clearPoolKeys, "All pool keys cleared.", "Failed to clear pool keys"));

// 指定密钥
manageApp.get('/fallback-key', (c) => handleManageApiCall(async () => ({ key: await kvOps.getFallbackKey() }), "Fallback key fetched.", "Failed to get fallback key"));
manageApp.post('/fallback-key', async (c) => handleManageApiCall(() => kvOps.setFallbackKey((await c.req.json()).key), "Fallback key updated.", "Failed to update fallback key"));

// 指定密钥触发模型
manageApp.get('/fallback-models', (c) => handleManageApiCall(async () => ({ models: Array.from(await kvOps.getFallbackModels()) }), "Fallback models fetched.", "Failed to get fallback models"));
manageApp.post('/fallback-models', (c) => handleJsonListPost(c, 'models', kvOps.addFallbackModels, "Fallback models updated.", "Failed to update fallback models"));
manageApp.delete('/fallback-models/all', (c) => handleManageApiCall(kvOps.clearFallbackModels, "All fallback models cleared.", "Failed to clear fallback models"));

// 重试次数
manageApp.get('/retry-limit', (c) => handleManageApiCall(async () => ({ limit: await kvOps.getApiRetryLimit() }), "Retry limit fetched.", "Failed to get retry limit"));
manageApp.post('/retry-limit', async (c) => handleManageApiCall(() => kvOps.setApiRetryLimit((await c.req.json()).limit), "Retry limit updated.", "Failed to set retry limit"));

// GCP 设置
manageApp.get('/gcp-credentials', (c) => handleManageApiCall(async () => ({ credentials: await kvOps.getGcpCredentialsString() }), "GCP credentials fetched.", "Failed to get GCP credentials"));
manageApp.post('/gcp-credentials', async (c) => handleManageApiCall(() => kvOps.setGcpCredentialsString((await c.req.json()).credentials), "GCP credentials updated.", "Failed to set GCP credentials"));
manageApp.get('/gcp-location', (c) => handleManageApiCall(async () => ({ location: await kvOps.getGcpDefaultLocation() }), "GCP location fetched.", "Failed to get GCP location"));
manageApp.post('/gcp-location', async (c) => handleManageApiCall(() => kvOps.setGcpDefaultLocation((await c.req.json()).location), "GCP location updated.", "Failed to set GCP location"));

// Vertex 模型
manageApp.get('/vertex-models', (c) => handleManageApiCall(async () => ({ models: Array.from(await kvOps.getVertexModels()) }), "Vertex models fetched.", "Failed to get Vertex models"));
manageApp.post('/vertex-models', (c) => handleJsonListPost(c, 'models', kvOps.addVertexModels, "Vertex models list updated.", "Failed to update Vertex models"));
manageApp.delete('/vertex-models/all', (c) => handleManageApiCall(kvOps.clearVertexModels, "All Vertex models cleared.", "Failed to clear Vertex models"));

// API 路径映射
manageApp.get('/api-mappings', (c) => handleManageApiCall(async () => ({ mappings: await kvOps.getApiMappings() }), "API mappings fetched.", "Failed to get API mappings"));
manageApp.post('/api-mappings', async (c) => {
	const { mappings } = await c.req.json();
	return handleManageApiCall(() => kvOps.setApiMappings(mappings), "API mappings updated.", "Failed to set API mappings");
});
manageApp.delete('/api-mappings', (c) => handleManageApiCall(kvOps.clearApiMappings, "API mappings cleared.", "Failed to clear API mappings"));