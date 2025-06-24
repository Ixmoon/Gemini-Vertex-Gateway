/**
 * 主入口文件
 * 负责初始化Hono应用、设置路由和启动服务。
 */
import { Hono } from "hono";
import { serveStatic } from "hono/middleware";
import { warmUpCache } from "./config_loader.ts";
import { handleProxy } from "./proxy_handler.ts";
import { manageApp } from "./manage_api.ts";

// --- 冷启动时预热缓存 ---
// 延迟执行，避免阻塞服务启动
setTimeout(warmUpCache, 5 * 1000); // 5秒后开始预热

// --- Hono 应用实例 ---
const app = new Hono();

// --- 错误处理 ---
app.onError((err, c) => {
	console.error(`[Global Error Handler] Path: ${c.req.path}`, err);
	const message = err instanceof Error ? err.message : "An unknown error occurred.";
	return c.json({ error: `Internal Server Error: ${message}` }, 500);
});

// --- 静态文件与管理API路由 ---
app.get('/manage', serveStatic({ path: './src/manage.html' }));
app.get('/manage.js', serveStatic({ path: './src/manage.js' }));
app.route('/api/manage', manageApp); // 挂载管理API

// --- 核心代理路由 ---
// [FIX] 移除了具体的 /gemini/* 和 /vertex/* 路由。
// 所有未被上方具体路由（如 /manage）匹配的请求都将由 handleProxy 处理。
// handleProxy 内部的 determineRequestType 会智能区分 /gemini, /vertex 和自定义映射。

// --- 其他路由 ---
app.get('/', (c) => c.text('LLM Gateway is running.'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'));

// [FIX] 唯一的代理路由，必须放在所有其他具体路由之后。
// This will handle /gemini, /vertex, and all custom API mappings.
app.all('/*', handleProxy);

// --- 启动服务器 ---
Deno.serve(app.fetch);
console.log("Server is running.");