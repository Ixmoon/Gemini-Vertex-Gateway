/**
 * @file 服务主入口文件 (Entry Point)
 * @description
 * 负责初始化 Hono 应用，设置静态文件服务、API 路由、定时任务和全局错误处理。
 * 这是整个应用的启动点，协调各个模块的运行。
 */

// --- 导入 Hono 和相关中间件 ---
import { Hono } from "hono";
import { serveStatic } from "hono/middleware";

// --- 导入业务模块 ---
import * as kvOps from "./replacekeys.ts";
import { handleGenericProxy } from "./proxy_handler.ts";
import { loadAndCacheAllKvConfigs } from "./cache.ts";
import { manageApp } from "./manage_api.ts";

// --- 服务启动时预加载配置到 Edge Cache ---
// 在服务启动时立即执行一次，以减少首次请求的延迟。
console.log("[Startup] Preloading all KV configs to Edge Cache...");
loadAndCacheAllKvConfigs().catch(error => {
	console.error("[Startup] Initial cache preloading failed:", error);
});


// --- 定时任务：每5分钟刷新 Edge Cache ---
// Deno.cron 是 Deno Deploy 提供的标准功能，用于定期执行任务。
// 这确保了即使在没有管理操作的情况下，缓存也能与 KV 中的数据保持最终一致。
Deno.cron("Edge Cache Refresh", "*/5 * * * *", async () => {
	console.log("[Cron] Starting Edge Cache refresh...");
	try {
		await loadAndCacheAllKvConfigs();
		console.log("[Cron] Edge Cache refresh finished successfully.");
	} catch (error) {
		console.error("[Cron] Edge Cache refresh failed:", error);
	}
});

// --- 辅助函数：创建标准化的 JSON 响应 (保持不变) ---
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

// --- 静态文件路由 (保持不变) ---
// 为管理后台界面提供服务
app.get('/manage', serveStatic({ path: './src/manage.html' }));
app.get('/manage.html', serveStatic({ path: './src/manage.html' }));
app.get('/manage.js', serveStatic({ path: './src/manage.js' }));

// --- 管理 API 路由 ---

/**
 * 登录路由 (无需密码验证)
 * 这是进入管理后台的唯一入口。它处理两种情况：
 * 1. 首次设置密码：如果管理员密码未设置，用户提供的第一个有效密码将被设为初始密码。
 * 2. 正常登录：验证用户提供的密码是否与存储的哈希匹配。
 */
app.post('/api/manage/login', async (c) => {
	try {
		const { password } = await c.req.json();
		// kvOps 中的函数已重构为直接访问 KV，因为密码验证不应被缓存。
		const isValid = await kvOps.verifyAdminPassword(password);
		if (isValid) {
			return createSuccessPayload({ success: true, message: "Login successful" });
		} else {
			const hash = await kvOps.getAdminPasswordHash();
			// 如果哈希不存在，说明是首次设置
			if (!hash) {
				if (password && password.length >= 8) {
					// setAdminPassword 内部会写入 KV 并更新缓存
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
		return createErrorPayload(`Login failed: ${message}`, 400);
	}
});

// 挂载所有受密码保护的管理 API 子应用
app.route('/api/manage', manageApp);

// --- 其他路由 (保持不变) ---
app.get('/', (c) => c.html('Service is running! Hono version.'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'));

/**
 * 通用代理通配符路由
 * 这是整个网关的核心功能入口，捕获所有未被特定路由匹配的请求。
 * 它必须放在所有具体路由之后，作为 "catch-all"。
 * 所有复杂的代理、认证、重试逻辑都在 handleGenericProxy 函数中处理。
 */
app.all('/*', (c) => handleGenericProxy(c));

// --- 全局错误处理 (保持不变) ---
app.onError((err, c) => {
	const message = err instanceof Error ? err.message : String(err);
	let status = 500;
	// 如果错误本身就是一个 Response 对象（通常由代理逻辑主动抛出），则直接返回它。
	if (err instanceof Response) {
		console.error(`Caught Response error: ${err.status} ${err.statusText}`);
		return err;
	}
	// 处理 Deno 特定的错误类型
	if (err instanceof Deno.errors.NotFound) status = 404;

	// 记录详细的错误信息，包括堆栈跟踪，以便于调试
	console.error(`Global Error Handler: ${status} - ${message}`, err instanceof Error ? err.stack : '(No stack trace)');

	return createErrorPayload(`Internal Server Error: ${message}`, status);
});

// --- 服务器启动 ---

// 从环境变量读取端口，提供灵活性
let port = 8080;
const portFromEnv = Deno.env.get("PORT");
if (portFromEnv) {
	try {
		const parsedPort = parseInt(portFromEnv!, 10);
		if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
			port = parsedPort;
		}
	} catch (e) {
		console.warn("Failed to parse PORT from environment variable, using default 8080.");
	}
}

// 启动 Hono 服务器
Deno.serve({ port }, app.fetch);
console.log(`Server running on http://localhost:${port}`);