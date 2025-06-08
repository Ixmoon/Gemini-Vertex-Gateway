// --- 定时任务：每5分钟刷新 Edge Cache (移至顶部) ---
// --- 导入 Hono 和相关模块 ---
import { Hono, } from "hono";
import { serveStatic } from "hono/middleware";

// --- 导入现有模块 ---
import * as kvOps from "./replacekeys.ts"; // Keep existing kvOps import for other functions
// --- 导入新的代理处理模块 ---
import { handleGenericProxy } from "./proxy_handler.ts";
// --- 导入缓存加载函数 ---
import { loadAndCacheAllKvConfigs } from "./cache.ts";

// --- 冷启动刷新缓存 ---
setTimeout(async () => {
	//console.log("[Timeout] Starting initial Edge Cache refresh...");
	try {
		await loadAndCacheAllKvConfigs();
		//console.log("[Timeout] Initial Edge Cache refresh finished successfully.");
	} catch (error) {
		console.error("[Timeout] Initial Edge Cache refresh failed:", error);
	}
}, 10 * 1000); // 

// --- 辅助函数 (非代理相关) (保持不变) ---
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
app.get('/manage', serveStatic({ path: './src/manage.html' }));
app.get('/manage.html', serveStatic({ path: './src/manage.html' })); // 别名
app.get('/manage.js', serveStatic({ path: './src/manage.js' }));


// --- 管理 API 路由 ---

// 不需要密码的登录路由
app.post('/api/manage/login', async (c) => {
	try {
		const { password } = await c.req.json();
		// 使用 await 调用异步的 verifyAdminPassword
		const isValid = await kvOps.verifyAdminPassword(password);
		if (isValid) {
			return createSuccessPayload({ success: true, message: "Login successful" });
		} else {
			// 使用 await 调用异步的 getAdminPasswordHash
			const hash = await kvOps.getAdminPasswordHash();
			if (!hash) {
				if (password && password.length >= 8) {
					// setAdminPassword 内部会 reload cache
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


// --- 其他路由 (保持不变) ---
app.get('/', (c) => c.html('Service is running! Hono version.'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'));

// 通用代理通配符路由 (放在具体路由之后)
app.all('/*', (c) => handleGenericProxy(c));


// --- 全局错误处理 (保持不变) ---
app.onError((err, c) => {
	const message = err instanceof Error ? err.message : String(err);
	let status = 500;
	// 检查是否是 Response 实例 (可能由代理逻辑抛出)
	if (err instanceof Response) {
		// 如果是 Response，直接返回它
		console.error(`Caught Response error: ${err.status} ${err.statusText}`);
		return err;
	}
	// 检查 Deno 特定的错误
	if (err instanceof Deno.errors.NotFound) status = 404;
	// 可以添加更多特定错误类型的检查

	// 记录更详细的错误信息，包括堆栈跟踪
	console.error(`Global Error Handler: ${status} - ${message}`, err instanceof Error ? err.stack : '(No stack trace)');

	// 返回标准的 JSON 错误响应
	return createErrorPayload(`Internal Server Error: ${message}`, status);
});

// --- 服务器启动 ---

// KV 连接将通过 ensureKv() 在首次需要时懒加载避免阻塞冷启动

// 启动服务器 (端口将由 Deno Deploy 等环境自动设置)
Deno.serve(app.fetch);
//console.log(`Server running on default port`);