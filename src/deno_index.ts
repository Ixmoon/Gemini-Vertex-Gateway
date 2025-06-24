import { Hono,Context } from "hono";
import { GoogleAuth } from "google-auth-library";

// =================================================================================
// --- 1. 配置模块 (从环境变量读取) ---
// 本模块负责从环境变量中读取所有应用配置。
// =================================================================================

/**
 * [配置] 从环境变量解析以逗号分隔的字符串为 Set<string>。
 * @param varName - 环境变量的名称。
 * @returns - 解析后的 Set 集合。
 */
const getSetFromEnv = (varName: string): Set<string> => {
	const value = Deno.env.get(varName);
	return value ? new Set(value.split(',').map(s => s.trim()).filter(Boolean)) : new Set();
};

/** [配置] 获取触发密钥集合。环境变量: `TRIGGER_KEYS` (例如: "key-abc,key-def") */
const getTriggerKeys = (): Set<string> => getSetFromEnv("TRIGGER_KEYS");

/** [配置] 获取主密钥池数组。环境变量: `POOL_KEYS` (例如: "pool-key-1,pool-key-2") */
const getPoolKeys = (): string[] => Array.from(getSetFromEnv("POOL_KEYS"));

/** [配置] 获取指定的后备密钥。环境变量: `FALLBACK_KEY` */
const getFallbackKey = (): string | null => Deno.env.get("FALLBACK_KEY") || null;

/** [配置] 获取触发后备密钥的模型名称集合。环境变量: `FALLBACK_MODELS` (例如: "model-a,model-b") */
const getFallbackModels = (): Set<string> => getSetFromEnv("FALLBACK_MODELS");

/** [配置] 获取 API 请求失败时的重试次数。环境变量: `API_RETRY_LIMIT` (例如: "3") */
const getApiRetryLimit = (): number => {
	const limit = parseInt(Deno.env.get("API_RETRY_LIMIT") || "1", 10);
	return isNaN(limit) || limit < 1 ? 1 : limit;
};

/** [配置] 获取 GCP 服务账号凭证 JSON 字符串。环境变量: `GCP_CREDENTIALS` */
const getGcpCredentialsString = (): string | null => Deno.env.get("GCP_CREDENTIALS") || null;

/** [配置] 获取 GCP 默认的区域 (Location)。环境变量: `GCP_DEFAULT_LOCATION` */
const getGcpDefaultLocation = (): string => Deno.env.get("GCP_DEFAULT_LOCATION") || "global";

/** [配置] 解析 API 路径映射。环境变量: `API_MAPPINGS` (格式: "/prefix1:https://target1,/prefix2:https://target2") */
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
// 定义了整个代理逻辑中使用的核心类型和枚举。
// =================================================================================

/** GCP 凭证类型定义 */
interface GcpCredentials {
	type: string;
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
	client_id?: string;
}

/** API 密钥的来源类型 */
type ApiKeySource = 'user' | 'fallback' | 'pool';
/** API 密钥的解析结果 */
type ApiKeyResult = { key: string; source: ApiKeySource };

/** 请求处理类型枚举 */
enum RequestType {
	VERTEX_AI,
	GEMINI_OPENAI,
	GEMINI_NATIVE,
	GENERIC_PROXY,
	UNKNOWN
}

/** 认证详情 (由策略返回) */
interface AuthenticationDetails {
	key: string | null;
	source: ApiKeySource | null;
	gcpToken: string | null;
	gcpProject: string | null;
	maxRetries: number;
}

/** 传递给策略的上下文信息 */
interface StrategyContext {
	originalUrl: URL;
	originalRequest: Request;
	path: string;
	prefix: string | null;
	parsedBody?: any | null;
	originalBodyBuffer?: ArrayBuffer | null;
}

// =================================================================================
// --- 3. 核心 API 密钥选择与 GCP 认证逻辑 ---
// 此部分负责决定使用哪个API密钥，并处理GCP的身份验证。
// =================================================================================

/** [核心] 获取请求应使用的 API 密钥。 */
const getApiKeyForRequest = (userProvidedKey: string | null, modelName: string | null): ApiKeyResult | null => {
	if (!userProvidedKey) return null;
	if (!getTriggerKeys().has(userProvidedKey)) {
		return { key: userProvidedKey, source: 'user' };
	}

	if (modelName && getFallbackModels().has(modelName.trim())) {
		const fallbackKey = getFallbackKey();
		if (fallbackKey) return { key: fallbackKey, source: 'fallback' };
	}

	const poolKeys = getPoolKeys();
	if (poolKeys.length > 0) {
		return { key: poolKeys[Math.floor(Math.random() * poolKeys.length)], source: 'pool' };
	}

	console.warn("Trigger key used, but no fallback/pool key is available.");
	return null;
};

/** 检查 GCP 凭证对象是否有效 */
const isValidGcpCred = (cred: any): cred is GcpCredentials =>
	cred?.type === 'service_account' && cred?.project_id && cred?.private_key && cred?.client_email;

/** [核心] 获取 GCP 认证 Token。 */
const getGcpAuth = async (): Promise<{ token: string; projectId: string } | null> => {
	const credsStr = getGcpCredentialsString();
	if (!credsStr) return null;

	let creds: GcpCredentials[] = [];
	try {
		const parsed = JSON.parse(credsStr);
		creds = (Array.isArray(parsed) ? parsed : [parsed]).filter(isValidGcpCred);
	} catch (e) {
		console.error("[GCP] Failed to parse GCP_CREDENTIALS:", e);
	}

	if (creds.length === 0) {
		console.warn("[GCP] No valid credentials found in GCP_CREDENTIALS.");
		return null;
	}

	const selectedCred = creds[Math.floor(Math.random() * creds.length)];
	try {
		const auth = new GoogleAuth({ credentials: selectedCred, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
		const token = await auth.getAccessToken();
		if (!token) {
			console.error(`[GCP] Failed to get Access Token for project: ${selectedCred.project_id}`);
			return null;
		}
		return { token, projectId: selectedCred.project_id };
	} catch (error) {
		console.error(`[GCP] Error during token acquisition for project ${selectedCred.project_id}:`, error);
		return null;
	}
};

// =================================================================================
// --- 4. 请求处理策略 (Strategy Pattern) ---
// 根据不同的请求类型，定义了不同的处理策略。
// =================================================================================

/** 从请求中提取 API 密钥 */
const getApiKeyFromReq = (c: Context): string | null => {
	const url = new URL(c.req.url);
	return url.searchParams.get('key') || c.req.header("Authorization")?.replace(/^bearer\s+/i, '') || c.req.header("x-goog-api-key") || null;
};

/** 构建基础代理 Headers (过滤掉 host) */
const buildBaseProxyHeaders = (h: Headers): Headers => { const n = new Headers(h); n.delete('host'); return n; };

/** Gemini 策略获取认证详情的公共逻辑 */
const _getGeminiAuthDetails = (c: Context, model: string | null, attempt: number, name: string): AuthenticationDetails => {
	const userApiKey = getApiKeyFromReq(c);
	const isModels = new URL(c.req.url).pathname.endsWith('/models');
	let result: ApiKeyResult | null = null;

	if (attempt === 1) {
		result = getApiKeyForRequest(userApiKey, model);
		if (!result && !isModels) throw new Response(`No valid API key (${name})`, { status: 401 });
	} else if (userApiKey && getTriggerKeys().has(userApiKey)) {
		const poolKeys = getPoolKeys();
		if (poolKeys.length > 0) {
			result = { key: poolKeys[Math.floor(Math.random() * poolKeys.length)], source: 'pool' };
		} else if (!isModels) {
			throw new Response(`Key pool exhausted (${name})`, { status: 503 });
		}
	} else if (attempt > 1 && !isModels) {
		throw new Response(`Request failed, non-trigger key won't be retried (${name})`, { status: 503 });
	}

	return {
		key: result?.key || null, source: result?.source || null, gcpToken: null, gcpProject: null,
		maxRetries: result?.source === 'pool' ? getApiRetryLimit() : 1
	};
};

/** 请求处理策略接口 */
interface RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> | AuthenticationDetails;
	buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL | Promise<URL>;
	buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers;
	processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> | BodyInit | null;
	handleResponse?(res: Response, ctx: StrategyContext): Promise<Response>;
}

/** Vertex AI 策略 - 专用于处理 /vertex 路径的请求 */
class VertexAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(c: Context, _ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		// 验证触发密钥，这是 /vertex 路径的特定要求
		if (!getTriggerKeys().has(getApiKeyFromReq(c) || '')) {
			throw new Response("Forbidden: A valid trigger key is required for the /vertex endpoint.", { status: 403 });
		}
		const auth = await getGcpAuth();
		if (!auth && attempt === 1) {
			throw new Response("GCP authentication failed on first attempt. Check GCP_CREDENTIALS.", { status: 503 });
		}
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
		if (ctx.originalRequest.method === 'GET' || !ctx.originalBodyBuffer) {
			// [FIX] Ensure null is returned instead of undefined.
			return ctx.originalBodyBuffer ?? null;
		}
		try {
			const bodyToModify = JSON.parse(new TextDecoder().decode(ctx.originalBodyBuffer));
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
			return JSON.stringify(bodyToModify);
		} catch (e) {
			console.error("Vertex body modification error:", e);
			// [FIX] Ensure null is returned instead of undefined.
			return ctx.originalBodyBuffer ?? null;
		}
	}
}

/** Gemini (OpenAI 兼容) 策略 */
class GeminiOpenAIStrategy implements RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number) {
		return _getGeminiAuthDetails(c, (ctx.parsedBody as any)?.model, attempt, "Gemini OpenAI");
	}

	buildTargetUrl(ctx: StrategyContext): URL {
		const baseUrl = getApiMappings()['/gemini'];
		if (!baseUrl) throw new Response("Gemini base URL for '/gemini' not in API_MAPPINGS.", { status: 503 });
		let path = ctx.path;
        if (['/chat/completions', '/embeddings', '/models'].includes(ctx.path)) {
            path = '/v1beta' + ctx.path;
        } else if (ctx.path.startsWith('/v1/')) {
            path = '/v1beta' + ctx.path.slice(3);
        }
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

	processRequestBody(ctx: StrategyContext) {
		// [FIX] Ensure null is returned instead of undefined.
		return ctx.originalBodyBuffer ?? null;
	}

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
			// Fallback for cases where body might not have 'data' but is still valid JSON
			return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers: res.headers });
		} catch (e) {
			console.error("Gemini models fix error:", e);
			// If JSON parsing fails, return the original response to avoid crashing
			return res;
		}
	}
}

/** Gemini (原生) 策略 */
class GeminiNativeStrategy implements RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number) {
		// [FIX] Ensure null is passed instead of undefined.
		const modelName = ctx.path.match(/\/models\/([^:]+):/)?.[1] ?? null;
		return _getGeminiAuthDetails(c, modelName, attempt, "Gemini Native");
	}

	buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL {
		if (!auth.key) throw new Response("Gemini Native requires an API Key.", { status: 500 });
		const baseUrl = getApiMappings()['/gemini'];
		if (!baseUrl) throw new Response("Gemini base URL for '/gemini' not in API_MAPPINGS.", { status: 503 });
		const url = new URL(ctx.path, baseUrl);
		ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
		url.searchParams.set('key', auth.key);
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, _auth: AuthenticationDetails) {
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization'); headers.delete('x-goog-api-key');
		return headers;
	}

	processRequestBody(ctx: StrategyContext) {
		// [FIX] Ensure null is returned instead of undefined.
		return ctx.originalBodyBuffer ?? null;
	}
}

/** 通用代理策略 */
class GenericProxyStrategy implements RequestHandlerStrategy {
	getAuthenticationDetails() { return { key: null, source: null, gcpToken: null, gcpProject: null, maxRetries: 1 }; }
	buildTargetUrl(ctx: StrategyContext): URL {
		if (!ctx.prefix || !getApiMappings()[ctx.prefix]) {
			throw new Response(`Proxy target for prefix '${ctx.prefix}' not in API_MAPPINGS.`, { status: 503 });
		}
		const url = new URL(ctx.path, getApiMappings()[ctx.prefix]);
		ctx.originalUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, _auth: AuthenticationDetails) { return buildBaseProxyHeaders(ctx.originalRequest.headers); }
	processRequestBody(ctx: StrategyContext) {
		// [FIX] Ensure null is returned instead of undefined.
		return ctx.originalBodyBuffer ?? null;
	}
}

// =================================================================================
// --- 5. 策略选择器与主处理函数 ---
// 决定请求的类型，并调用相应策略执行代理。
// =================================================================================

/** [核心] 根据请求确定其类型和应使用的策略。 */
const determineRequestType = (req: Request, body: ArrayBuffer | null): { type: RequestType, prefix: string | null, path: string, parsedBody?: any } => {
	const { pathname } = new URL(req.url);
	const mappings = getApiMappings();

	if (pathname.startsWith('/vertex/')) {
		return { type: RequestType.VERTEX_AI, prefix: '/vertex', path: pathname.slice('/vertex'.length) };
	}

	const prefix = Object.keys(mappings).filter(p => pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0] || null;
	const path = prefix ? pathname.slice(prefix.length) : pathname;

	if (!prefix) return { type: RequestType.UNKNOWN, prefix: null, path };
	if (prefix !== '/gemini') return { type: RequestType.GENERIC_PROXY, prefix, path };

	if (!path.startsWith('/v1beta/')) {
		let parsedBody: any = null;
		if (body && req.method !== 'GET') try { parsedBody = JSON.parse(new TextDecoder().decode(body)); } catch {}
		return { type: RequestType.GEMINI_OPENAI, prefix, path, parsedBody };
	}

	return { type: RequestType.GEMINI_NATIVE, prefix, path };
};

/** 根据请求类型获取对应的策略实例 */
const getStrategy = (type: RequestType): RequestHandlerStrategy => {
	switch (type) {
		case RequestType.VERTEX_AI: return new VertexAIStrategy();
		case RequestType.GEMINI_OPENAI: return new GeminiOpenAIStrategy();
		case RequestType.GEMINI_NATIVE: return new GeminiNativeStrategy();
		case RequestType.GENERIC_PROXY: return new GenericProxyStrategy();
		default: throw new Error(`Unsupported type: ${RequestType[type]}`);
	}
};

/** [主处理函数] 代理所有请求。 */
const handleGenericProxy = async (c: Context): Promise<Response> => {
	const req = c.req.raw;
	const bodyBuffer = (req.method !== 'GET' && req.body) ? await req.clone().arrayBuffer() : null;

	const { type, ...details } = determineRequestType(req, bodyBuffer);
	if (type === RequestType.UNKNOWN) return c.json({ error: `No route for path: ${new URL(req.url).pathname}` }, 404);

	const strategy = getStrategy(type);
	const context: StrategyContext = {
		originalUrl: new URL(req.url), originalRequest: req, originalBodyBuffer: bodyBuffer, ...details
	};

	let attempts = 0, maxRetries = 1;
	let lastError: Response | null = null;

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
				lastError = res.clone();
				await res.body?.cancel();
				if(attempts >= maxRetries) break;
				continue;
			}
			return strategy.handleResponse ? await strategy.handleResponse(res, context) : res;

		} catch (error) {
			if (error instanceof Response) {
				lastError = error.clone();
				await error.body?.cancel();
				if(attempts >= maxRetries) break;
				continue;
			}
			console.error(`Attempt ${attempts} error for ${RequestType[type]}:`, error);
			return c.json({ error: `Internal Server Error: ${error instanceof Error ? error.message : "Unknown"}` }, 500);
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
	// Handle cases where the error is a Response object (thrown from strategies)
	if (err instanceof Response) {
		return err;
	}
	return c.json({ error: `Internal Error: ${err.message}` }, 500);
});

Deno.serve({ port: parseInt(Deno.env.get("PORT") || "8080", 10) }, app.fetch);

console.log(`Server running on http://localhost:${Deno.env.get("PORT") || "8080"}`);
console.log("Configuration loaded from environment variables.");