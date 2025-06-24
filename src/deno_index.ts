import { Hono } from "hono";
import { serveStatic } from "hono/middleware";
import { loadAllConfigsToCache } from "./config.ts";
import { verifyAdminPassword, setAdminPassword, getAdminPasswordHash } from "./services.ts";
import { handleGenericProxy } from "./proxy_handler.ts";
import { manageApp } from "./manage_api.ts";

// --- 应用初始化 ---
const app = new Hono();

// --- 辅助函数 ---
const createJsonResponse = (data: object, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// --- 定时任务：每5分钟刷新 Edge Cache ---
Deno.cron("Edge Cache Refresh", "*/5 * * * *", async () => {
	console.log("[Cron] Starting Edge Cache refresh...");
	try {
		await loadAllConfigsToCache();
		console.log("[Cron] Edge Cache refresh finished successfully.");
	} catch (error) {
		console.error("[Cron] Edge Cache refresh failed:", error);
	}
});

// --- 服务启动时，预加载一次配置到缓存 ---
loadAllConfigsToCache().catch(e => console.error("[Startup] Initial cache load failed:", e));

// --- 静态文件路由 ---
app.get('/manage', serveStatic({ path: './src/manage.html' }));
app.get('/manage.html', serveStatic({ path: './src/manage.html' }));
app.get('/manage.js', serveStatic({ path: './src/manage.js' }));

// --- 核心 API 路由 ---
// 登录 (无需认证)
app.post('/api/manage/login', async (c) => {
	try {
		const { password } = await c.req.json();
		if (await verifyAdminPassword(password)) {
			return createJsonResponse({ success: true, message: "登录成功" });
		}
		// 检查是否是首次设置密码
		if (!(await getAdminPasswordHash())) {
			if (password && password.length >= 8) {
				await setAdminPassword(password);
				return createJsonResponse({ success: true, message: "初始管理员密码设置成功" });
			}
			return createJsonResponse({ error: "管理员密码未设置，请输入一个至少8位的密码以完成设置" }, 401);
		}
		return createJsonResponse({ error: "密码无效" }, 401);
	} catch (error) {
		return createJsonResponse({ error: `登录失败: ${error.message}` }, 400);
	}
});

// 挂载需要认证的管理 API 子应用
app.route('/api/manage', manageApp);

// 通用代理通配符路由 (必须放在最后)
app.all('/*', handleGenericProxy);

// --- 全局错误处理 ---
app.onError((err, c) => {
	console.error(`[Global Error] Path: ${c.req.path}, Error:`, err);
	if (err instanceof Response) return err; // 如果是 Response 对象，直接返回
	return createJsonResponse({ error: `内部服务器错误: ${err.message}` }, 500);
});


// --- 服务器启动 ---
const port = parseInt(Deno.env.get("PORT") || "8080", 10);
Deno.serve({ port }, app.fetch);
console.log(`LLM Gateway is running on http://localhost:${port}`);