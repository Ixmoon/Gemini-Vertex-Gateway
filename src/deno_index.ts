// --- 导入 Hono 和相关模块 ---
import { Hono, } from "hono";
import { serveStatic } from "hono/middleware";

// --- 导入现有模块 ---
import * as kvOps from "./replacekeys.ts"; // Keep existing kvOps import for other functions
// --- 导入新的代理处理模块 ---
import { handleGenericProxy } from "./proxy_handler.ts";
import { loadAndCacheAllKvConfigs, initializeAndCacheGcpAuth } from "./cache.ts";

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

// Admin auth middleware moved to manage_api.ts

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

// Management API routes moved to manage_api.ts

// 导入并挂载管理 API 子应用 (在登录路由之后)
import { manageApp } from "./manage_api.ts";
app.route('/api/manage', manageApp);


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

// 在启动前初始化 KV 和加载/缓存 GCP 凭证 (使用导入的函数)
await kvOps.openKv();
console.log("KV opened.");

// 并行加载配置和初始化 GCP Auth (使用导入的函数)
try {
	console.log("Starting parallel loading of KV configs and GCP Auth initialization...");
	await Promise.all([
		loadAndCacheAllKvConfigs(), // 预加载所有 KV 配置到缓存
		initializeAndCacheGcpAuth()  // 基于缓存的凭证初始化 GCP Auth 实例 (会等待凭证缓存就绪)
	]);
	console.log("KV configs cached and GCP Auth initialized successfully.");
} catch (error) {
	console.error("Error during parallel startup initialization:", error);
	// 根据需要决定服务器是否仍应启动或退出
	// 当前选择继续启动，但某些功能可能因初始化失败而受影响
	console.warn("Server might start with incomplete initialization due to errors.");
}

// 启动服务器
Deno.serve({ port }, app.fetch);
console.log(`Server running on http://localhost:${port}`);