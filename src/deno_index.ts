// deno-lint-ignore-file no-explicit-any
import { Hono, Context } from "hono";
import { GoogleAuth } from "google-auth-library";

// =================================================================================
// --- 1. 配置模块 (从环境变量读取) ---
// =================================================================================

const getSetFromEnv = (varName: string): Set<string> => {
	const val = Deno.env.get(varName);
	return val ? new Set(val.split(',').map(s => s.trim()).filter(Boolean)) : new Set();
};
const getTriggerKeys = (): Set<string> => getSetFromEnv("TRIGGER_KEYS");
const getPoolKeys = (): string[] => Array.from(getSetFromEnv("POOL_KEYS"));
const getFallbackKey = (): string | null => Deno.env.get("FALLBACK_KEY") || null;
const getFallbackModels = (): Set<string> => getSetFromEnv("FALLBACK_MODELS");
const getApiRetryLimit = (): number => {
	const limit = parseInt(Deno.env.get("API_RETRY_LIMIT") || "1", 10);
	return isNaN(limit) || limit < 1 ? 1 : limit;
};
const getGcpCredentialsString = (): string | null => Deno.env.get("GCP_CREDENTIALS") || null;
const getGcpDefaultLocation = (): string => Deno.env.get("GCP_DEFAULT_LOCATION") || "global";
const getApiMappings = (): Record<string, string> => {
	const mappings: Record<string, string> = {};
	const raw = Deno.env.get("API_MAPPINGS");
	if (raw) {
		raw.split(',').forEach(pair => {
			const parts = pair.trim().match(/^(\/.*?):(.+)$/);
			if (parts && parts.length === 3) {
				try {
					new URL(parts[2]);
					mappings[parts[1]] = parts[2];
				} catch {
					console.warn(`[Config] Invalid URL in API_MAPPINGS for prefix "${parts[1]}"`);
				}
			}
		});
	}
	return mappings;
};

// =================================================================================
// --- 2. 类型定义与常量 ---
// =================================================================================

interface GcpCredentials { type: string; project_id: string; private_key_id: string; private_key: string; client_email: string; client_id?: string; }
type ApiKeySource = 'user' | 'fallback' | 'pool';
type ApiKeyResult = { key: string; source: ApiKeySource };
enum RequestType { VERTEX_AI, GEMINI_OPENAI, GEMINI_NATIVE, GENERIC_PROXY, UNKNOWN }
interface AuthenticationDetails { key: string | null; source: ApiKeySource | null; gcpToken: string | null; gcpProject: string | null; maxRetries: number; }
interface StrategyContext { originalUrl: URL; originalRequest: Request; path: string; prefix: string | null; parsedBody?: any | null; originalBodyBuffer?: ArrayBuffer | null; }

// =================================================================================
// --- 3. 核心 API 密钥选择与 GCP 认证逻辑 ---
// =================================================================================

const getApiKeyForRequest = (userKey: string | null, model: string | null): ApiKeyResult | null => {
	if (!userKey) return null;
	if (!getTriggerKeys().has(userKey)) return { key: userKey, source: 'user' };
	if (model && getFallbackModels().has(model.trim())) {
		const fbKey = getFallbackKey();
		if (fbKey) return { key: fbKey, source: 'fallback' };
	}
	const pool = getPoolKeys();
	if (pool.length > 0) return { key: pool[Math.floor(Math.random() * pool.length)], source: 'pool' };
	return null;
};

const isValidGcpCred = (cred: any): cred is GcpCredentials =>
	cred?.type === 'service_account' && cred?.project_id && cred?.private_key && cred?.client_email;

const getGcpAuth = async (): Promise<{ token: string; projectId: string } | null> => {
	const credsStr = getGcpCredentialsString();
	if (!credsStr) {
		// [新增调试日志]
		console.error("[DEBUG] getGcpAuth: GCP_CREDENTIALS environment variable is not set or empty.");
		return null;
	}

	let creds: GcpCredentials[] = [];
	try {
		const parsed = JSON.parse(credsStr);
		creds = (Array.isArray(parsed) ? parsed : [parsed]).filter(isValidGcpCred);
	} catch (e) {
		console.error("[DEBUG] getGcpAuth: Failed to parse GCP_CREDENTIALS as JSON:", e);
		return null;
	}

	if (creds.length === 0) {
		// [新增调试日志]
		console.error("[DEBUG] getGcpAuth: GCP_CREDENTIALS parsed, but no valid service account objects were found.");
		return null;
	}
	
	const selected = creds[Math.floor(Math.random() * creds.length)];
	console.log(`[DEBUG] getGcpAuth: Attempting to get token for project: ${selected.project_id} using client_email: ${selected.client_email}`);
	try {
		const auth = new GoogleAuth({ credentials: selected, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
		const token = await auth.getAccessToken();
		if (!token) {
			console.error(`[DEBUG] getGcpAuth: Failed to get Access Token for project: ${selected.project_id}. GoogleAuth returned null.`);
			return null;
		}
		console.log(`[DEBUG] getGcpAuth: Successfully obtained access token for project: ${selected.project_id}`);
		return { token, projectId: selected.project_id };
	} catch (error) {
		console.error(`[DEBUG] getGcpAuth: Error during token acquisition for project ${selected.project_id}:`, error);
		return null;
	}
};

// =================================================================================
// --- 4. 请求处理策略 (Strategy Pattern) ---
// =================================================================================

const getApiKeyFromReq = (c: Context): string | null => {
	const url = new URL(c.req.url);
	return url.searchParams.get('key') || c.req.header("Authorization")?.replace(/^bearer\s+/i, '') || c.req.header("x-goog-api-key") || null;
};
const buildBaseProxyHeaders = (h: Headers): Headers => { const n = new Headers(h); n.delete('host'); return n; };

const _getGeminiAuthDetails = (c: Context, model: string | null, attempt: number, name: string): AuthenticationDetails => {
	const userApiKey = getApiKeyFromReq(c);
	const isModels = new URL(c.req.url).pathname.endsWith('/models');
	let result: ApiKeyResult | null = null;
	if (attempt === 1) {
		result = getApiKeyForRequest(userApiKey, model);
		if (!result && !isModels) throw new Response(`No valid API key (${name})`, { status: 401 });
	} else if (userApiKey && getTriggerKeys().has(userApiKey)) {
		const pool = getPoolKeys();
		if (pool.length > 0) result = { key: pool[Math.floor(Math.random() * pool.length)], source: 'pool' };
		else if (!isModels) throw new Response(`Key pool exhausted (${name})`, { status: 503 });
	} else if (attempt > 1 && !isModels) {
		throw new Response(`Request failed, non-trigger key won't be retried (${name})`, { status: 503 });
	}
	return { key: result?.key || null, source: result?.source || null, gcpToken: null, gcpProject: null, maxRetries: result?.source === 'pool' ? getApiRetryLimit() : 1 };
};

interface RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> | AuthenticationDetails;
	buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL | Promise<URL>;
	buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers;
	processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> | BodyInit | null;
	handleResponse?(res: Response, ctx: StrategyContext): Promise<Response>;
}

class VertexAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(c: Context, _ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		// [核心调试点] 无论如何，先打印日志
		const userKey = getApiKeyFromReq(c) || 'N/A';
		console.log(`[DEBUG] Entered VertexAIStrategy.getAuthenticationDetails. Attempt: ${attempt}. User Key: ${userKey.slice(0,4)}...`);

		if (!getTriggerKeys().has(userKey)) {
			// [新增调试日志]
			console.error(`[DEBUG] VertexAIStrategy: Access FORBIDDEN. User key "${userKey.slice(0,4)}..." is NOT in the TRIGGER_KEYS set.`);
			throw new Response("Forbidden: A valid trigger key is required for the /vertex endpoint.", { status: 403 });
		}
		
		console.log(`[DEBUG] VertexAIStrategy: User key is a valid trigger key. Proceeding to get GCP Auth.`);
		const auth = await getGcpAuth();

		if (!auth && attempt === 1) {
			// [新增调试日志]
			console.error("[DEBUG] VertexAIStrategy: GCP authentication failed on first attempt. Check GCP_CREDENTIALS env var and logs from getGcpAuth.");
			throw new Response("GCP authentication failed on first attempt. Check GCP_CREDENTIALS.", { status: 503 });
		}
		
		console.log(`[DEBUG] VertexAIStrategy: getAuthenticationDetails successful. GCP Project: ${auth?.projectId}`);
		return { key: null, source: null, gcpToken: auth?.token || null, gcpProject: auth?.projectId || null, maxRetries: getApiRetryLimit() };
	}

	buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL {
		if (!auth.gcpProject) throw new Error("Vertex AI requires a GCP Project ID.");
		const loc = getGcpDefaultLocation();
		const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
		const baseUrl = `https://${host}/v1beta1/projects/${auth.gcpProject}/locations/${loc}/endpoints/openapi`;
		const path = ctx.path.startsWith('/v1/') ? ctx.path.slice(3) : ctx.path;
		const url = new URL(`${baseUrl}${path}`);
		ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
		// [新增调试日志]
		console.log(`[DEBUG] VertexAIStrategy: Built target URL: ${url.toString()}`);
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers {
		if (!auth.gcpToken) throw new Error("Vertex AI requires a GCP Token.");
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.set('Authorization', `Bearer ${auth.gcpToken}`);
		return headers;
	}
	
	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}
		if (!ctx.originalBodyBuffer) {
			return null;
		}
		let bodyToModify: any;
		try {
			bodyToModify = JSON.parse(new TextDecoder().decode(ctx.originalBodyBuffer));
		} catch (e) {
			console.error("Vertex: Failed to parse request body from buffer:", e);
			throw new Response("Failed to parse request body for Vertex AI. Invalid JSON.", { status: 400 });
		}
		if (typeof bodyToModify !== 'object' || bodyToModify === null) {
			return JSON.stringify(bodyToModify);
		}
		if (bodyToModify.model && typeof bodyToModify.model === 'string' && !bodyToModify.model.startsWith('google/')) {
			bodyToModify.model = `google/${bodyToModify.model}`;
		}
		if (bodyToModify.reasoning_effort === 'none') {
			delete bodyToModify.reasoning_effort;
		}
		bodyToModify.google = {
			...(bodyToModify.google || {}),
			safety_settings: [
				{ "category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF" },
				{ "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF" },
				{ "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF" },
				{ "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF" },
			]
		};
		// [新增调试日志]
		console.log(`[DEBUG] VertexAIStrategy: Processed request body.`);
		return JSON.stringify(bodyToModify);
	}
}

class GeminiOpenAIStrategy implements RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number) { return _getGeminiAuthDetails(c, (ctx.parsedBody as any)?.model, attempt, "Gemini OpenAI"); }
	buildTargetUrl(ctx: StrategyContext): URL {
		const baseUrl = getApiMappings()['/gemini'];
		if (!baseUrl) throw new Response("Gemini base URL for '/gemini' not in API_MAPPINGS.", { status: 503 });
		let path = ctx.path;
		if (['/chat/completions', '/embeddings', '/models'].includes(ctx.path)) path = '/v1beta' + ctx.path;
		else if (ctx.path.startsWith('/v1/')) path = '/v1beta' + ctx.path.slice(3);
		const url = new URL(path, baseUrl);
		ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers {
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization'); headers.delete('x-goog-api-key');
		if (auth.key) headers.set('Authorization', `Bearer ${auth.key}`);
		return headers;
	}
	processRequestBody(ctx: StrategyContext) { return ctx.originalBodyBuffer ?? null; }
	async handleResponse(res: Response, ctx: StrategyContext): Promise<Response> {
		if (!ctx.path.endsWith('/models') || !res.headers.get("content-type")?.includes("json")) return res;
		try {
			const body = await res.json();
			if (body?.data?.length) {
				body.data.forEach((m: any) => m.id?.startsWith('models/') && (m.id = m.id.slice(7)));
				const newBody = JSON.stringify(body);
				const h = new Headers(res.headers);
				h.delete('Content-Encoding');
				h.set('Content-Length', String(new TextEncoder().encode(newBody).byteLength));
				return new Response(newBody, { status: res.status, statusText: res.statusText, headers: h });
			}
			return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers: res.headers });
		} catch { return res; }
	}
}

class GeminiNativeStrategy implements RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number) { const model = ctx.path.match(/\/models\/([^:]+):/)?.[1] ?? null; return _getGeminiAuthDetails(c, model, attempt, "Gemini Native"); }
	buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL {
		if (!auth.key) throw new Response("Gemini Native requires an API Key.", { status: 500 });
		const baseUrl = getApiMappings()['/gemini'];
		if (!baseUrl) throw new Response("Gemini base URL for '/gemini' not in API_MAPPINGS.", { status: 503 });
		const url = new URL(ctx.path, baseUrl);
		ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
		url.searchParams.set('key', auth.key);
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, _auth: AuthenticationDetails) { const h = buildBaseProxyHeaders(ctx.originalRequest.headers); h.delete('authorization'); h.delete('x-goog-api-key'); return h; }
	processRequestBody(ctx: StrategyContext) { return ctx.originalBodyBuffer ?? null; }
}

class GenericProxyStrategy implements RequestHandlerStrategy {
	getAuthenticationDetails() { return { key: null, source: null, gcpToken: null, gcpProject: null, maxRetries: 1 }; }
	buildTargetUrl(ctx: StrategyContext): URL {
		if (!ctx.prefix || !getApiMappings()[ctx.prefix]) throw new Response(`Proxy target for prefix '${ctx.prefix}' not in API_MAPPINGS.`, { status: 503 });
		const url = new URL(ctx.path, getApiMappings()[ctx.prefix]);
		ctx.originalUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, _auth: AuthenticationDetails) { return buildBaseProxyHeaders(ctx.originalRequest.headers); }
	processRequestBody(ctx: StrategyContext) { return ctx.originalBodyBuffer ?? null; }
}

// =================================================================================
// --- 5. 策略选择器与主处理函数 ---
// =================================================================================

const determineRequestType = (req: Request, body: ArrayBuffer | null): { type: RequestType, prefix: string | null, path: string, parsedBody?: any } => {
	const { pathname } = new URL(req.url);
	// [新增调试日志]
	console.log(`[DEBUG] Determining request type for path: ${pathname}`);
	
	if (pathname.startsWith('/vertex/')) {
		// [新增调试日志]
		console.log(`[DEBUG] Path matched /vertex/. Routing to VERTEX_AI.`);
		return { type: RequestType.VERTEX_AI, prefix: '/vertex', path: pathname.slice('/vertex'.length) };
	}

	const mappings = getApiMappings();
	const prefix = Object.keys(mappings).filter(p => pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0] || null;
	const path = prefix ? pathname.slice(prefix.length) : pathname;
	if (!prefix) {
		console.log(`[DEBUG] No matching prefix found. Routing to UNKNOWN.`);
		return { type: RequestType.UNKNOWN, prefix: null, path };
	}

	console.log(`[DEBUG] Matched prefix: "${prefix}". Path: "${path}".`);
	if (prefix !== '/gemini') {
		console.log(`[DEBUG] Routing to GENERIC_PROXY.`);
		return { type: RequestType.GENERIC_PROXY, prefix, path };
	}

	if (!path.startsWith('/v1beta/')) {
		console.log(`[DEBUG] Gemini prefix, non-native path. Routing to GEMINI_OPENAI.`);
		let parsedBody: any = null;
		if (body && req.method !== 'GET') try { parsedBody = JSON.parse(new TextDecoder().decode(body)); } catch { /* ignore */ }
		return { type: RequestType.GEMINI_OPENAI, prefix, path, parsedBody };
	}

	console.log(`[DEBUG] Gemini prefix, native path. Routing to GEMINI_NATIVE.`);
	return { type: RequestType.GEMINI_NATIVE, prefix, path };
};

const getStrategy = (type: RequestType): RequestHandlerStrategy => {
	switch (type) {
		case RequestType.VERTEX_AI: return new VertexAIStrategy();
		case RequestType.GEMINI_OPENAI: return new GeminiOpenAIStrategy();
		case RequestType.GEMINI_NATIVE: return new GeminiNativeStrategy();
		case RequestType.GENERIC_PROXY: return new GenericProxyStrategy();
		default: throw new Error(`Unsupported type: ${RequestType[type]}`);
	}
};

const handleGenericProxy = async (c: Context): Promise<Response> => {
	const req = c.req.raw;
	const bodyBuffer = (req.method !== 'GET' && req.method !== 'HEAD' && req.body) ? await req.clone().arrayBuffer() : null;
	const { type, ...details } = determineRequestType(req, bodyBuffer);
	if (type === RequestType.UNKNOWN) return c.json({ error: `No route for path: ${new URL(req.url).pathname}` }, 404);
	const strategy = getStrategy(type);
	const context: StrategyContext = { originalUrl: new URL(req.url), originalRequest: req, originalBodyBuffer: bodyBuffer, ...details };
	let attempts = 0, maxRetries = 1, lastError: Response | null = null;
	while (attempts < maxRetries) {
		attempts++;
		try {
			const auth = await Promise.resolve(strategy.getAuthenticationDetails(c, context, attempts));
			if (attempts === 1) maxRetries = auth.maxRetries;
			const targetUrl = await Promise.resolve(strategy.buildTargetUrl(context, auth));
			const targetHeaders = strategy.buildRequestHeaders(context, auth);
			const targetBody = await Promise.resolve(strategy.processRequestBody(context));
			const res = await fetch(targetUrl, { method: req.method, headers: targetHeaders, body: targetBody });
			if (!res.ok) {
				// [新增调试日志] 读取错误响应体
				const errorBodyText = await res.text();
				console.error(`[DEBUG] Upstream request to ${targetUrl.hostname} FAILED. Status: ${res.status}. Body: ${errorBodyText}`);
				// 克隆原始响应以便返回
				lastError = new Response(errorBodyText, { status: res.status, statusText: res.statusText, headers: res.headers });
				if (attempts >= maxRetries) break; else continue;
			}
			console.log(`[DEBUG] Upstream request to ${targetUrl.hostname} SUCCEEDED. Status: ${res.status}`);
			return strategy.handleResponse ? await strategy.handleResponse(res, context) : res;
		} catch (error) {
			console.error(`[DEBUG] Caught error in proxy loop. Attempt ${attempts}/${maxRetries}.`, error);
			if (error instanceof Response) {
				lastError = error.clone(); await error.body?.cancel();
				if (attempts >= maxRetries) break; else continue;
			} else {
				console.error(`[FATAL] Attempt ${attempts} non-Response error for ${RequestType[type]}:`, error);
				return c.json({ error: `Internal Server Error: ${error instanceof Error ? error.message : "Unknown"}` }, 500);
			}
		}
	}
	return lastError ?? c.json({ error: "Request failed after all retries." }, 502);
};

// =================================================================================
// --- 6. Hono 服务器设置与启动 ---
// =================================================================================

const app = new Hono();
app.get('/', (c: Context) => c.text('LLM Gateway Service is running.'));
app.get('/robots.txt', (c: Context) => c.text('User-agent: *\nDisallow: /'));
app.all('/*', handleGenericProxy);
app.onError((err: Error, c: Context) => {
	console.error(`Global Error Handler:`, err);
	if (err instanceof Response) return err;
	return c.json({ error: `Internal Error: ${err.message}` }, 500);
});
Deno.serve({ port: parseInt(Deno.env.get("PORT") || "8080", 10) }, app.fetch);
console.log(`Server running on http://localhost:${Deno.env.get("PORT") || "8080"}`);