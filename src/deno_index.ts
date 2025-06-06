// --- 导入 Hono 和相关模块 ---
import { Hono, Context } from "https://deno.land/x/hono@v4.3.11/mod.ts";
import { cors } from "https://deno.land/x/hono@v4.3.11/middleware.ts";
import { serveStatic } from "https://deno.land/x/hono@v4.3.11/middleware.ts";

// --- 导入现有模块 ---
import * as kvOps from "./replacekeys.ts"; // Keep existing kvOps import for other functions
// Import specific functions needed for API Mappings
import {
	getApiMappings,
	setApiMappings,
	clearApiMappings,
	// Keep other necessary imports from kvOps if any are used directly elsewhere,
	// or refactor to use the specific imports consistently.
	// For now, we keep the wildcard import alongside specific ones.
} from "./replacekeys.ts";
// --- 导入新的代理处理模块 ---
// Remove apiMapping import as it's no longer exported/used from proxy_handler
import { handleGenericProxy, loadGcpCreds } from "./proxy_handler.ts";

// --- 辅助函数 (非代理相关) ---
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


// --- Hono 应用实例 ---
const app = new Hono();

// CORS - Will be applied selectively


// --- 静态文件路由 ---
app.get('/manage', serveStatic({ path: './src/manage.html' }));
app.get('/manage.html', serveStatic({ path: './src/manage.html' })); // 别名
app.get('/manage.js', serveStatic({ path: './src/manage.js' }));


// --- 管理 API 路由 ---

// 管理员密码认证中间件
const adminAuthMiddleware = async (c: Context, next: () => Promise<void>) => {
	const adminPassword = c.req.header('X-Admin-Password');
	if (!adminPassword || !(await kvOps.verifyAdminPassword(adminPassword))) {
		return c.json({ error: "Unauthorized: Invalid or missing X-Admin-Password header" }, 401);
	}
	await next();
};

// 不需要密码的登录路由
app.post('/api/manage/login', async (c) => {
	try {
		const { password } = await c.req.json();
		const isValid = await kvOps.verifyAdminPassword(password);
		if (isValid) {
			return createSuccessPayload({ success: true, message: "Login successful" });
		} else {
			const hash = await kvOps.getAdminPasswordHash();
			if (!hash) {
				if (password && password.length >= 8) {
					await kvOps.setAdminPassword(password);
					return createSuccessPayload({ success: true, message: "Initial admin password set successfully." });
				} else {
					return createErrorPayload("Admin password not set. Provide a password (min 8 chars) to set it.", 401);
				}
			}
			return createErrorPayload("Invalid password", 401);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return createErrorPayload(`Login failed: ${message}`, 400); // Bad Request on JSON parse error etc.
	}
});

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
// Helper to wrap management API calls with try-catch and success/error payloads
async function handleManageApiCall<T>(
	logic: () => Promise<T>,
	successMessage: string | ((result: T) => string),
	errorMessagePrefix: string
): Promise<Response> {
	try {
		const result = await logic();
		const message = typeof successMessage === 'function' ? successMessage(result) : successMessage;
		// 如果 result 是简单类型或 null/undefined，包装在 data 字段中
		// 如果 result 本身是对象，直接作为 payload
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

// GCP Credentials 路由 (仅设置，不获取)
manageApi.post('/gcp-credentials', async (c) => {
	const { credentials } = await c.req.json();
	return handleManageApiCall(() => kvOps.setGcpCredentialsString(credentials ?? null), "GCP credentials updated.", "Failed to set GCP credentials");
});
manageApi.get('/gcp-credentials', (c) => handleManageApiCall(
	async () => ({ credentials: await kvOps.getGcpCredentialsString() }), // 假设 kvOps 中有此函数
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
manageApi.get('/api-mappings', (c) => handleManageApiCall(
	async () => ({ mappings: await getApiMappings() }),
	() => "API mappings fetched successfully.",
	"Failed to get API mappings"
));
manageApi.post('/api-mappings', async (c) => {
	const { mappings } = await c.req.json();
	// 基本验证：确保 mappings 是一个对象
	if (typeof mappings !== 'object' || mappings === null) {
		return createErrorPayload("Invalid input: mappings must be an object.", 400);
	}
	// TODO: 可以添加更严格的验证，例如检查键和值是否都是字符串
	return handleManageApiCall(() => setApiMappings(mappings), "API mappings updated.", "Failed to set API mappings");
});
manageApi.delete('/api-mappings', (c) => handleManageApiCall(
	clearApiMappings,
	"API mappings cleared.",
	"Failed to clear API mappings"
));

// 将管理 API 子应用挂载到主应用
app.route('/api/manage', manageApi);


// --- 代理路由 ---
// 移除基于硬编码 apiMapping 的循环路由注册
// 添加一个通配符路由来捕获所有潜在的代理请求
// handleGenericProxy 将在内部查询 KV 并处理路由
// 注意：此路由应放在更具体的静态路由之后


// --- 其他路由 ---
app.get('/', (c) => c.html('Service is running! Hono version.'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'));

// 通用代理通配符路由 (放在具体路由之后)
app.all('/*', (c) => handleGenericProxy(c));


// --- 全局错误处理 ---
app.onError((err, c) => {
	const message = err instanceof Error ? err.message : String(err);
	let status = 500;
	if (err instanceof Deno.errors.NotFound) status = 404;
	// 可以添加更多特定错误类型的检查
	// 返回 Response 对象
	return createErrorPayload(`Internal Server Error: ${message}`, status);
});

// --- 服务器启动 ---

// 确定端口
let port = 8080;
const portFromEnv = Deno.env.get("PORT");
if (portFromEnv) { // 检查是否存在
	try {
		// 使用非空断言 (!) 告知 TypeScript portFromEnv 在这里不是 undefined
		const parsedPort = parseInt(portFromEnv!, 10);
		if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
			port = parsedPort;
		}
	} catch (e) { /* Ignore parse error */ }
}

// 在启动前初始化 KV 和加载 GCP 凭证 (使用导入的函数)
await kvOps.openKv();
await loadGcpCreds(); // 加载 GCP 凭证

// 启动服务器
Deno.serve({ port }, app.fetch);
console.log(`Server running on http://localhost:${port}`);