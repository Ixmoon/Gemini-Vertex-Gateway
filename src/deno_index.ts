// --- 导入 Hono 和相关模块 ---
import { Hono, } from "hono";
import { serveStatic } from "hono/middleware";

// --- 导入现有模块 ---
import * as kvOps from "./replacekeys.ts"; // Keep existing kvOps import for other functions
// --- 导入新的代理处理模块 ---
import { handleGenericProxy } from "./proxy_handler.ts";
// --- 导入缓存和队列相关 ---
import { loadAndCacheAllKvConfigs } from "./cache.ts";
import { ensureKv } from "./replacekeys.ts"; // [新增] 导入 ensureKv 用于队列

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

// CORS - Will be applied selectively


// --- 静态文件路由 (保持不变) ---
app.get('/manage', serveStatic({ path: './src/manage.html' }));
app.get('/manage.html', serveStatic({ path: './src/manage.html' })); // 别名
app.get('/manage.js', serveStatic({ path: './src/manage.js' }));


// --- 管理 API 路由 ---

// Admin auth middleware moved to manage_api.ts

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


// --- 代理路由 (保持不变) ---
// 移除基于硬编码 apiMapping 的循环路由注册
// 添加一个通配符路由来捕获所有潜在的代理请求
// handleGenericProxy 将在内部查询 KV 并处理路由
// 注意：此路由应放在更具体的静态路由之后


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

// 确定端口 (保持不变)
let port = 8080;
const portFromEnv = Deno.env.get("PORT");
if (portFromEnv) {
	try {
		const parsedPort = parseInt(portFromEnv!, 10);
		if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort < 65536) {
			port = parsedPort;
		}
	} catch (e) { /* Ignore parse error */ }
}

// --- 确保 KV 在启动时打开 ---
console.log("Ensuring KV store is open for startup operations...");
try {
await kvOps.openKv(); // <--- 重新添加显式打开 KV
console.log("KV opened successfully.");
} catch (kvError) {
console.error("FATAL: Failed to open KV store during startup:", kvError);
// 也许应该在这里退出？取决于需求
throw new Error("Failed to initialize KV store."); // 抛出错误阻止启动
}

// --- [移除] 移除所有启动时预加载缓存的逻辑 ---
// 缓存将在第一个请求处理完成后通过 waitUntil 在后台填充

// 启动服务器 (保持不变)
// --- Queue Listener ---
async function startQueueListener() {
	try {
		const kv = await ensureKv(); // 获取 KV 实例
		console.log("Starting Deno KV Queue listener for 'refreshCache' tasks...");
		kv.listenQueue(async (msg: unknown) => {
			// 基本类型检查
			if (typeof msg === 'object' && msg !== null && 'type' in msg && msg.type === 'refreshCache') {
				console.log("[Queue] Received 'refreshCache' task. Processing...");
				try {
					await loadAndCacheAllKvConfigs();
					console.log("[Queue] Background cache refresh task completed successfully.");
				} catch (error) {
					console.error("[Queue] Error executing background cache refresh task:", error);
					// Deno Queues 应该会自动重试失败的消息
				}
			} else {
				console.warn("[Queue] Received unknown message:", msg);
				// 可以考虑将未知消息移到死信队列或其他处理
			}
		});
		console.log("Deno KV Queue listener started.");
	} catch (error) {
		console.error("FATAL: Failed to start Deno KV Queue listener:", error);
		// 如果监听器启动失败，可能需要阻止服务器启动
		throw new Error("Failed to start KV Queue listener.");
	}
}

// 在服务器启动前启动队列监听器
startQueueListener();

Deno.serve({ port }, app.fetch);
console.log(`Server running on http://localhost:${port}`);