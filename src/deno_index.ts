import { Hono } from "hono";
import { handleProxyRequest } from "./proxy_handler.ts"; // Renamed for clarity

// Hono 应用实例
const app = new Hono();

// 辅助函数
const createErrorResponse = (message: string, status = 500): Response => {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
};

// 核心路由
app.get('/', (c) => c.html('Simplified LLM Gateway is running! Configuration is managed by environment variables.'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'));

// 通用代理通配符路由 (放在具体路由之后)
app.all('/*', (c) => handleProxyRequest(c));

// 全局错误处理
app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    let status = 500;
    if (err instanceof Response) {
        // 如果错误本身就是一个 Response 对象（例如，由我们的代码主动抛出），则直接返回
        console.error(`Caught Response error: ${err.status} ${err.statusText}`);
        return err;
    }
    if (err instanceof Deno.errors.NotFound) status = 404;

    console.error(`Global Error Handler: ${status} - ${message}`, err instanceof Error ? err.stack : '(No stack trace)');
    return createErrorResponse(`Internal Server Error: ${message}`, status);
});

// 服务器启动
const portEnv = Deno.env.get("PORT");
const port = portEnv ? parseInt(portEnv, 10) : 8080;

Deno.serve({ port }, app.fetch);
console.log(`Server running on http://localhost:${port}`);
console.log("Configuration loaded from environment variables.");