import { serve } from "https://deno.land/std@0.140.0/http/server.ts";
import {
  encrypt,
  decrypt,
} from "https://deno.land/x/aes@v0.1.1/mod.ts";
import "https://deno.land/std@0.140.0/dotenv/load.ts";
import { getCookies, setCookie, deleteCookie } from "https://deno.land/std@0.140.0/http/cookie.ts";

// --- 配置 ---
// 客户端加密密钥
const AES_KEY_STRING = Deno.env.get("AES_KEY") || "YourSecretKey12345678901234567890";
const AES_KEY = new TextEncoder().encode(AES_KEY_STRING);

// 管理后台密码
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") || "admin";
const SESSION_KEY = "auth_session";

// --- Deno KV ---
const kv = await Deno.openKv();

// --- 加密辅助函数 ---

async function decryptPayload(jsonInput: string): Promise<any | null> {
  try {
    const { iv: iv_b64, ciphertext: ct_b64 } = JSON.parse(jsonInput);
    const iv = Uint8Array.from(atob(iv_b64), (c) => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(ct_b64), (c) => c.charCodeAt(0));

    const decrypted = await decrypt(AES_KEY, iv, ciphertext);
    const decryptedText = new TextDecoder().decode(decrypted);
    return JSON.parse(decryptedText);
  } catch (e) {
    console.error("Decryption failed:", e);
    return null;
  }
}

async function encryptPayload(data: any): Promise<string | null> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12)); // AES-GCM 推荐使用12字节的IV
    const dataToEncrypt = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = await encrypt(AES_KEY, iv, dataToEncrypt);

    const iv_b64 = btoa(String.fromCharCode(...iv));
    const ct_b64 = btoa(String.fromCharCode(...encrypted));

    return JSON.stringify({ iv: iv_b64, ciphertext: ct_b64 });
  } catch (e) {
    console.error("Encryption failed:", e);
    return null;
  }
}

// --- 会话管理 ---
async function createSession(req: Request): Promise<Response> {
    const response = new Response(null, { status: 302, headers: { "Location": "/admin" } });
    const sessionId = crypto.randomUUID();
    await kv.set(["sessions", sessionId], true, { expireIn: 3600 * 1000 }); // 1 hour expiry
    setCookie(response.headers, {
        name: SESSION_KEY,
        value: sessionId,
        path: "/",
        httpOnly: true,
        maxAge: 3600,
    });
    return response;
}

async function verifySession(req: Request): Promise<boolean> {
    const cookies = getCookies(req.headers);
    const sessionId = cookies[SESSION_KEY];
    if (!sessionId) return false;
    const session = await kv.get(["sessions", sessionId]);
    return session.value === true;
}

// --- API 处理器 ---
async function handleApi(req: Request): Promise<Response> {
    if (!await verifySession(req)) {
        return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(req.url);
    const key = url.searchParams.get("key");

    switch (req.method) {
        case "GET": {
            const entries = kv.list({ prefix: ["licenses"] });
            const licenses = [];
            for await (const entry of entries) {
                licenses.push({ key: entry.key[1], ...entry.value });
            }
            return new Response(JSON.stringify(licenses), { headers: { "Content-Type": "application/json" } });
        }
        case "POST": {
            const { key: newKey } = await req.json();
            if (!newKey || typeof newKey !== "string") return new Response("Invalid key", { status: 400 });
            await kv.set(["licenses", newKey], { created_at: new Date().toISOString() });
            return new Response(JSON.stringify({ success: true }), { status: 201 });
        }
        case "DELETE": {
            if (!key) return new Response("Key not specified", { status: 400 });
            await kv.delete(["licenses", key]);
            return new Response(JSON.stringify({ success: true }));
        }
        default:
            return new Response("Method not allowed", { status: 405 });
    }
}

// --- 主请求处理器 ---
async function handler(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    // 客户端授权端点
    if (req.method === "POST" && pathname === "/auth") {
        try {
            const encryptedRequest = await req.text();
            const payload = await decryptPayload(encryptedRequest);
            if (!payload || !payload.machine_code || !payload.license_key) {
                return new Response("Invalid request payload.", { status: 400 });
            }
            const { machine_code, license_key } = payload;
            const licenseRecord = await kv.get(["licenses", license_key]);
            if (!licenseRecord.value) {
                return new Response("Invalid or expired license key.", { status: 403 });
            }
            const timestamp = Math.floor(Date.now() / 1000);
            const authToken = `${machine_code}|${timestamp}`;
            const encryptedToken = await encryptPayload(authToken);
            if (!encryptedToken) {
                return new Response("Failed to generate auth token.", { status: 500 });
            }
            return new Response(encryptedToken, { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (error) {
            console.error("Auth endpoint error:", error);
            return new Response("Internal server error.", { status: 500 });
        }
    }

    // 管理后台 API
    if (pathname.startsWith("/api/licenses")) {
        return handleApi(req);
    }

    // 管理后台登录
    if (req.method === "POST" && pathname === "/admin/login") {
        const formData = await req.formData();
        if (formData.get("password") === ADMIN_PASSWORD) {
            return await createSession(req);
        }
        return new Response("Invalid password", { status: 401 });
    }
    
    // 管理后台登出
    if (pathname === "/admin/logout") {
        const response = new Response(null, { status: 302, headers: { "Location": "/admin" } });
        deleteCookie(response.headers, SESSION_KEY, { path: "/" });
        return response;
    }

    // 静态文件服务 (管理后台UI)
    if (pathname === "/admin") {
        try {
            const content = await Deno.readTextFile("./admin.html");
            return new Response(content, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch {
            return new Response("Admin page not found.", { status: 404 });
        }
    }
    if (pathname === "/admin.js") {
        try {
            const content = await Deno.readTextFile("./admin.js");
            return new Response(content, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
        } catch {
            return new Response("Admin script not found.", { status: 404 });
        }
    }

    return new Response("Not Found", { status: 404 });
}

// --- 启动服务器 ---
console.log("Auth server running on http://localhost:8000");
serve(handler);