import { Hono, Context } from "hono";
import { cors } from "hono/middleware";
import { ensureKv } from "./config.ts";
import { verifyAdminPassword, manage as manageService } from "./services.ts";

// --- 中间件 ---
const adminAuthMiddleware = async (c: Context, next: () => Promise<void>) => {
	await ensureKv(); // 确保 KV 已连接
	const adminPassword = c.req.header('X-Admin-Password');
	if (!adminPassword || !(await verifyAdminPassword(adminPassword))) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
};

// --- Hono 子应用 ---
const manageApp = new Hono();
manageApp.use('*', cors({ origin: '*' }));
manageApp.use('*', adminAuthMiddleware);

// --- 辅助函数：简化 try-catch 和响应 ---
async function handleApiCall<T>(logic: () => Promise<T>, successMessage: string): Promise<Response> {
	try {
		const data = await logic();
		// 对 Set 类型特殊处理，转换为数组
		const responseData = data instanceof Set ? { data: Array.from(data) } : { data };
		return new Response(JSON.stringify({ success: true, message: successMessage, ...responseData }), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (error) {
		return new Response(JSON.stringify({ success: false, error: error.message }), {
			status: error instanceof TypeError ? 400 : 500,
			headers: { "Content-Type": "application/json" },
		});
	}
}

// --- API 路由定义 ---
// Trigger Keys
manageApp.get('/trigger-keys', (c) => handleApiCall(manageService.getTriggerKeys, "触发密钥获取成功"));
manageApp.post('/trigger-keys', async (c) => {
	const { key } = await c.req.json();
	return handleApiCall(() => manageService.addTriggerKey(key), "触发密钥添加成功");
});
manageApp.delete('/trigger-keys', async (c) => {
	const { key } = await c.req.json();
	return handleApiCall(() => manageService.removeTriggerKey(key), "触发密钥删除成功");
});

// Pool Keys
manageApp.get('/pool-keys', (c) => handleApiCall(manageService.getPoolKeys, "密钥池获取成功"));
manageApp.post('/pool-keys', async (c) => {
	const { keys } = await c.req.json();
	return handleApiCall(() => manageService.addPoolKeys(keys), "密钥池添加成功");
});
manageApp.delete('/pool-keys/all', (c) => handleApiCall(manageService.clearPoolKeys, "密钥池已清空"));
manageApp.delete('/pool-keys', async (c) => { // 单个删除
    const { key } = await c.req.json();
    return handleApiCall(() => manageService.removePoolKey(key), "密钥池密钥删除成功");
});


// Fallback Key
manageApp.get('/fallback-key', (c) => handleApiCall(manageService.getFallbackKeyDirect, "指定密钥获取成功"));
manageApp.post('/fallback-key', async (c) => {
	const { key } = await c.req.json();
	return handleApiCall(() => manageService.setFallbackKey(key), "指定密钥设置成功");
});

// Fallback Models
manageApp.get('/fallback-models', (c) => handleApiCall(manageService.getFallbackModels, "回退模型获取成功"));
manageApp.post('/fallback-models', async (c) => {
	const { models } = await c.req.json();
	return handleApiCall(() => manageService.addFallbackModels(models), "回退模型添加成功");
});
manageApp.delete('/fallback-models/all', (c) => handleApiCall(manageService.clearFallbackModels, "回退模型已清空"));

// Retry Limit
manageApp.get('/retry-limit', (c) => handleApiCall(manageService.getApiRetryLimitDirect, "重试次数获取成功"));
manageApp.post('/retry-limit', async (c) => {
	const { limit } = await c.req.json();
	return handleApiCall(() => manageService.setApiRetryLimit(limit), "重试次数设置成功");
});

// GCP Credentials
manageApp.get('/gcp-credentials', (c) => handleApiCall(manageService.getGcpCredentialsString, "GCP凭证获取成功"));
manageApp.post('/gcp-credentials', async (c) => {
	const { credentials } = await c.req.json();
	return handleApiCall(() => manageService.setGcpCredentialsString(credentials), "GCP凭证设置成功");
});

// GCP Location
manageApp.get('/gcp-location', (c) => handleApiCall(manageService.getGcpDefaultLocationDirect, "GCP Location获取成功"));
manageApp.post('/gcp-location', async (c) => {
	const { location } = await c.req.json();
	return handleApiCall(() => manageService.setGcpDefaultLocation(location), "GCP Location设置成功");
});

// Vertex Models
manageApp.get('/vertex-models', (c) => handleApiCall(manageService.getVertexModels, "Vertex模型获取成功"));
manageApp.post('/vertex-models', async (c) => {
	const { models } = await c.req.json();
	return handleApiCall(() => manageService.setVertexModels(models), "Vertex模型设置成功");
});
manageApp.delete('/vertex-models/all', (c) => handleApiCall(manageService.clearVertexModels, "Vertex模型已清空"));

// API Mappings
manageApp.get('/api-mappings', (c) => handleApiCall(manageService.getApiMappingsDirect, "API映射获取成功"));
manageApp.post('/api-mappings', async (c) => {
	const { mappings } = await c.req.json();
	return handleApiCall(() => manageService.setApiMappings(mappings), "API映射设置成功");
});
manageApp.delete('/api-mappings', (c) => handleApiCall(manageService.clearApiMappings, "API映射已清空"));


export { manageApp };