// src/manage_api.ts
import { Hono, Context } from "hono";
import { cors } from "hono/middleware";
import * as kvOps from "./replacekeys.ts";
import { ensureKv } from "./replacekeys.ts"; // [新增] 导入 ensureKv

// --- 辅助函数 (从 deno_index.ts 复制，理想状态应导入或使用 c.json) ---
/** 创建 JSON 错误响应 */
function createErrorPayload(message: string, status: number = 500): Response {
	return new Response(JSON.stringify({ error: message }), {
		status: status,
		headers: { "Content-Type": "application/json" },
	});
}

/** 创建 JSON 成功响应 */
function createSuccessPayload(data: Record<string, any>, status: number = 200): Response {
	return new Response(JSON.stringify(data), {
		status: status,
		headers: { "Content-Type": "application/json" },
	});
}
// --- 结束 辅助函数 ---


// 管理员密码认证中间件
const adminAuthMiddleware = async (c: Context, next: () => Promise<void>) => {
	try {
		// [新增] 确保 KV 连接在执行管理操作前已建立
		await ensureKv();
	} catch (kvError) {
		console.error("Manage API: Failed to ensure KV connection in auth middleware:", kvError);
		return c.json({ error: "Internal Server Error: Could not connect to data store." }, 500);
	}

	const adminPassword = c.req.header('X-Admin-Password');
	if (!adminPassword) {
		return c.json({ error: "Unauthorized: Missing X-Admin-Password header" }, 401);
	}
	// kvOps.verifyAdminPassword 现在是 async，需要 await
	const isValid = await kvOps.verifyAdminPassword(adminPassword);
	if (!isValid) {
		return c.json({ error: "Unauthorized: Invalid X-Admin-Password" }, 401);
	}
	await next();
};

// 应用密码中间件和 CORS 到后续管理路由组
const manageApi = new Hono();
// Define CORS options (same as before)
const corsOptions = {
	origin: '*', // 允许所有来源
	allowMethods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
	allowHeaders: ['Authorization', 'Content-Type', 'X-Admin-Password', 'Accept', 'User-Agent', 'x-goog-api-key', 'x-goog-api-client'],
	credentials: true,
};
manageApi.use('*', cors(corsOptions)); // Apply CORS to manage API routes
manageApi.use('*', adminAuthMiddleware); // Apply auth middleware after CORS

// Helper to wrap management API calls with try-catch and success/error payloads
async function handleManageApiCall<T>(
	logic: () => Promise<T>,
	successMessage: string | ((result: T) => string),
	errorMessagePrefix: string
): Promise<Response> {
	try {
		const result = await logic();
		const message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
		const payloadData = (result !== null && typeof result === 'object') ? result : { data: result };
		return createSuccessPayload({ ...payloadData, message });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = error instanceof TypeError ? 400 : 500; // Basic error type check
		return createErrorPayload(`${errorMessagePrefix}: ${message}`, status);
	}
}

// Trigger Keys 路由
manageApi.get('/trigger-keys', (c) => handleManageApiCall(
	async () => ({ keys: Array.from(await kvOps.getTriggerKeys()) }),
	() => "Trigger keys fetched successfully.",
	"Failed to get trigger keys"
));
manageApi.post('/trigger-keys', async (c) => {
	const { key } = await c.req.json();
	return handleManageApiCall(() => kvOps.addTriggerKey(key), "Trigger key added.", "Failed to add trigger key");
});
manageApi.delete('/trigger-keys', async (c) => {
	const { key } = await c.req.json();
	return handleManageApiCall(() => kvOps.removeTriggerKey(key), "Trigger key removed.", "Failed to remove trigger key");
});

// Pool Keys 路由
manageApi.get('/pool-keys', (c) => handleManageApiCall(
	async () => ({ keys: await kvOps.getPoolKeys() }),
	() => "Pool keys fetched successfully.",
	"Failed to get pool keys"
));
manageApi.post('/pool-keys', async (c) => {
	const { keys } = await c.req.json();
	return handleManageApiCall(() => kvOps.addPoolKeys(keys), "Pool keys added.", "Failed to add pool keys");
});
manageApi.delete('/pool-keys', async (c) => {
	const { key } = await c.req.json();
	return handleManageApiCall(() => kvOps.removePoolKey(key), "Pool key removed.", "Failed to remove pool key");
});
manageApi.delete('/pool-keys/all', (c) => handleManageApiCall(
	kvOps.clearPoolKeys,
	"All pool keys cleared.",
	"Failed to clear pool keys"
));

// Fallback Key 路由
manageApi.get('/fallback-key', (c) => handleManageApiCall(
	async () => ({ key: await kvOps.getFallbackKey() }),
	() => "Fallback key fetched successfully.",
	"Failed to get fallback key"
));
manageApi.post('/fallback-key', async (c) => {
	const { key } = await c.req.json();
	return handleManageApiCall(() => kvOps.setFallbackKey(key), "Fallback key updated.", "Failed to update fallback key");
});

// Fallback Models 路由
manageApi.get('/fallback-models', (c) => handleManageApiCall(
	async () => ({ models: Array.from(await kvOps.getFallbackModels()) }),
	() => "Fallback models fetched successfully.",
	"Failed to get fallback models"
));
manageApi.post('/fallback-models', async (c) => {
	const { models } = await c.req.json();
	return handleManageApiCall(() => kvOps.addFallbackModels(models), "Fallback models added.", "Failed to add fallback models");
});
manageApi.delete('/fallback-models/all', (c) => handleManageApiCall(
	kvOps.clearFallbackModels,
	"All fallback models cleared.",
	"Failed to clear fallback models"
));

// Retry Limit 路由
manageApi.get('/retry-limit', (c) => handleManageApiCall(
	async () => ({ limit: await kvOps.getApiRetryLimit() }),
	() => "API retry limit fetched successfully.",
	"Failed to get API retry limit"
));
manageApi.post('/retry-limit', async (c) => {
	const { limit } = await c.req.json();
	return handleManageApiCall(() => kvOps.setApiRetryLimit(limit), "API retry limit updated.", "Failed to set API retry limit");
});

// GCP Credentials 路由
manageApi.post('/gcp-credentials', async (c) => {
	const { credentials } = await c.req.json();
	return handleManageApiCall(async () => {
		await kvOps.setGcpCredentialsString(credentials ?? null);
	}, "GCP credentials updated.", "Failed to set GCP credentials");
});
manageApi.get('/gcp-credentials', (c) => handleManageApiCall(
	async () => ({ credentials: await kvOps.getGcpCredentialsString() }),
	() => "GCP credentials fetched successfully.",
	"Failed to get GCP credentials"
));

// GCP Default Location 路由
manageApi.get('/gcp-location', (c) => handleManageApiCall(
	async () => ({ location: await kvOps.getGcpDefaultLocation() }),
	() => "GCP default location fetched successfully.",
	"Failed to get GCP default location"
));
manageApi.post('/gcp-location', async (c) => {
	const { location } = await c.req.json();
	return handleManageApiCall(() => kvOps.setGcpDefaultLocation(location), "GCP default location updated.", "Failed to set GCP default location");
});

// Vertex Models 路由
manageApi.get('/vertex-models', (c) => handleManageApiCall(
	async () => ({ models: Array.from(await kvOps.getVertexModels()) }),
	() => "Vertex models fetched successfully.",
	"Failed to get Vertex models"
));
manageApi.post('/vertex-models', async (c) => {
	const { models } = await c.req.json();
	if (!Array.isArray(models)) {
		return createErrorPayload("Invalid input: models must be an array.", 400);
	}
	return handleManageApiCall(async () => {
		await kvOps.clearVertexModels();
		await kvOps.addVertexModels(models);
	}, "Vertex models list updated.", "Failed to set Vertex models");
});
manageApi.delete('/vertex-models/all', (c) => handleManageApiCall(
	kvOps.clearVertexModels,
	"All Vertex models cleared.",
	"Failed to clear Vertex models"
));

// API Mappings 路由
// 需要导入 getApiMappings, setApiMappings, clearApiMappings
import { getApiMappings, setApiMappings, clearApiMappings } from "./replacekeys.ts";

manageApi.get('/api-mappings', (c) => handleManageApiCall(
	async () => ({ mappings: await getApiMappings() }),
	() => "API mappings fetched successfully.",
	"Failed to get API mappings"
));
manageApi.post('/api-mappings', async (c) => {
	const { mappings } = await c.req.json();
	if (typeof mappings !== 'object' || mappings === null) {
		return createErrorPayload("Invalid input: mappings must be an object.", 400);
	}
	return handleManageApiCall(async () => {
		await setApiMappings(mappings);
	}, "API mappings updated.", "Failed to set API mappings");
});
manageApi.delete('/api-mappings', (c) => handleManageApiCall(
	async () => {
		await clearApiMappings();
	},
	"API mappings cleared.",
	"Failed to clear API mappings"
));


// 导出 Hono 实例
export const manageApp = manageApi;