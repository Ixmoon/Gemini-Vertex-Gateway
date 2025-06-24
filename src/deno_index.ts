// src/deno_index.ts
/**
 * 主入口文件
 * 负责初始化Hono应用、设置路由和启动服务。
 */
import { Hono } from "hono";
import { serveStatic } from "hono/middleware";
import { warmUpCache } from "./config_loader.ts";
import { handleProxy } from "./proxy_handler.ts";
import { manageApp } from "./manage_api.ts";
import * as logic from "./config_logic.ts"; // 导入业务逻辑

// --- 冷启动时预热缓存 ---
setTimeout(warmUpCache, 5 * 1000);

// --- Hono 应用实例 ---
const app = new Hono();

// --- 错误处理 ---
app.onError((err, c) => {
	console.error(`[Global Error Handler] Path: ${c.req.path}`, err);
	const message = err instanceof Error ? err.message : "An unknown error occurred.";
	return c.json({ error: `Internal Server Error: ${message}` }, 500);
});

// --- 静态文件路由 ---
app.get('/manage', serveStatic({ path: './src/manage.html' }));
app.get('/manage.js', serveStatic({ path: './src/manage.js' }));

// --- 管理API路由 ---

// 关键修复：将登录路由独立出来，放在受保护的管理路由之前，且不使用密码中间件。
app.post('/api/manage/login', async (c) => {
	const { password } = await c.req.json().catch(() => ({ password: null }));
	if (!password || typeof password !== 'string') {
        return c.json({ success: false, error: "Password must be a string." }, 400);
    }
	const hash = await logic.getAdminPasswordHash();
	if (hash) {
		// 密码已存在，进行验证
		if (await logic.verifyAdminPassword(password)) {
			return c.json({ success: true, message: "Login successful." });
		}
		return c.json({ success: false, error: "Invalid password." }, 401);
	} else {
		// 密码未设置，进行初始化
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

// 挂载受密码保护的管理API子应用
app.route('/api/manage', manageApp);

// --- 核心代理路由 ---
app.get('/', (c) => c.text('LLM Gateway is running.'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'));
app.all('/*', handleProxy);

// --- 启动服务器 ---
Deno.serve(app.fetch);
console.log("Server is running.");