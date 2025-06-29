import { Hono, Context } from "hono";
import { GoogleAuth } from "google-auth-library";

// =================================================================================
// --- 1. 配置模块 (从环境变量读取) ---
// =================================================================================
const ENV_KEYS = {
	TRIGGER_KEYS: "TRIGGER_KEYS",
	POOL_KEYS: "POOL_KEYS",
	FALLBACK_KEY: "FALLBACK_KEY",
	FALLBACK_MODELS: "FALLBACK_MODELS",
	API_RETRY_LIMIT: "API_RETRY_LIMIT",
	GCP_CREDENTIALS: "GCP_CREDENTIALS",
	GCP_DEFAULT_LOCATION: "GCP_DEFAULT_LOCATION",
	API_MAPPINGS: "API_MAPPINGS",
};

const getSetFromEnv = (varName: string): Set<string> => {
	const val = Deno.env.get(varName);
	return val ? new Set(val.split(',').map(s => s.trim()).filter(Boolean)) : new Set();
};

const getRandomElement = <T>(arr: T[]): T | undefined => {
	if (arr.length === 0) return undefined;
	return arr[Math.floor(Math.random() * arr.length)];
};

const CONFIG = {
	triggerKeys: getSetFromEnv(ENV_KEYS.TRIGGER_KEYS),
	poolKeys: Array.from(getSetFromEnv(ENV_KEYS.POOL_KEYS)),
	fallbackKey: Deno.env.get(ENV_KEYS.FALLBACK_KEY) || null,
	fallbackModels: getSetFromEnv(ENV_KEYS.FALLBACK_MODELS),
	apiRetryLimit: (() => {
		const limit = parseInt(Deno.env.get(ENV_KEYS.API_RETRY_LIMIT) || "1", 10);
		return isNaN(limit) || limit < 1 ? 1 : limit;
	})(),
	gcpCredentialsString: Deno.env.get(ENV_KEYS.GCP_CREDENTIALS) || null,
	gcpDefaultLocation: Deno.env.get(ENV_KEYS.GCP_DEFAULT_LOCATION) || "global",
	apiMappings: (() => {
		const mappings: Record<string, string> = {};
		const raw = Deno.env.get(ENV_KEYS.API_MAPPINGS);
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
	})(),
};

type AppConfig = typeof CONFIG;

const getTriggerKeys = (): Set<string> => CONFIG.triggerKeys;
const getPoolKeys = (): string[] => CONFIG.poolKeys;
const getFallbackKey = (): string | null => CONFIG.fallbackKey;
const getFallbackModels = (): Set<string> => CONFIG.fallbackModels;
const getApiRetryLimit = (): number => CONFIG.apiRetryLimit;
const getGcpCredentialsString = (): string | null => CONFIG.gcpCredentialsString;
const getApiMappings = (): Record<string, string> => CONFIG.apiMappings;

// =================================================================================
// --- 2. 类型定义与常量 ---
// =================================================================================

interface GcpCredentials { type: string; project_id: string; private_key_id: string; private_key: string; client_email: string; client_id?: string; }
type ApiKeySource = 'user' | 'fallback' | 'pool';
type ApiKeyResult = { key: string; source: ApiKeySource };
enum RequestType { VERTEX_AI, GEMINI_OPENAI, GEMINI_NATIVE, GENERIC_PROXY, UNKNOWN }
interface AuthenticationDetails { key: string | null; source: ApiKeySource | null; gcpToken: string | null; gcpProject: string | null; maxRetries: number; }
interface GoogleSafetySetting {
	category: string;
	threshold: string;
}
interface GoogleSpecificSettings {
	safety_settings?: GoogleSafetySetting[];
}
interface ModelProviderRequestBody { model?: string; reasoning_effort?: string; google?: GoogleSpecificSettings; }
interface GeminiModel { id: string; }
interface StrategyContext { originalUrl: URL; originalRequest: Request; path: string; prefix: string | null; parsedBody?: ModelProviderRequestBody | null; originalBodyBuffer?: ArrayBuffer | null; }

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
	const randomPoolKey = getRandomElement(pool);
	if (randomPoolKey) return { key: randomPoolKey, source: 'pool' };
	return null;
};

const isValidGcpCred = (cred: unknown): cred is GcpCredentials => {
	if (typeof cred !== 'object' || cred === null) {
		return false;
	}
	const maybeCred = cred as Record<string, unknown>;
	return (
		maybeCred.type === 'service_account' &&
		!!maybeCred.project_id &&
		!!maybeCred.private_key &&
		!!maybeCred.client_email
	);
};

const gcpAuthManager = (() => {
	const authInstanceCache = new Map<string, GoogleAuth>();
	let credentials: GcpCredentials[] = [];

	try {
		const credsStr = getGcpCredentialsString();
		if (credsStr) {
			const parsed = JSON.parse(credsStr);
			credentials = (Array.isArray(parsed) ? parsed : [parsed]).filter(isValidGcpCred);
		}
		if (credentials.length === 0) {
			console.warn("[GCP] No valid GCP credentials found in GCP_CREDENTIALS.");
		}
	} catch (e) {
		console.error("[GCP] Failed to parse GCP_CREDENTIALS on startup:", e);
	}
	
	const getAuthInstance = (credential: GcpCredentials): GoogleAuth => {
		if (!authInstanceCache.has(credential.client_email)) {
			const newAuthInstance = new GoogleAuth({
				credentials: credential,
				scopes: ["https://www.googleapis.com/auth/cloud-platform"]
			});
			authInstanceCache.set(credential.client_email, newAuthInstance);
		}
		return authInstanceCache.get(credential.client_email)!;
	};

	const getAuth = async (): Promise<{ token: string; projectId: string } | null> => {
		if (credentials.length === 0) return null;
		const selectedCredential = getRandomElement(credentials);
		if (!selectedCredential) return null;

		try {
			const auth = getAuthInstance(selectedCredential);
			const token = await auth.getAccessToken();
			if (!token) {
				console.error(`[GCP] Failed to get Access Token for project: ${selectedCredential.project_id}`);
				return null;
			}
			return { token, projectId: selectedCredential.project_id };
		} catch (error) {
			console.error(`[GCP] Error during token acquisition for project ${selectedCredential.project_id}:`, error);
			return null;
		}
	};

	return { getAuth };
})();

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
		const randomPoolKey = getRandomElement(pool);
		if (randomPoolKey) result = { key: randomPoolKey, source: 'pool' };
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
	private readonly config: AppConfig;
	private readonly gcpAuth: () => Promise<{ token: string; projectId: string; } | null>;

	constructor(config: AppConfig, gcpAuth: () => Promise<{ token: string; projectId: string; } | null>) {
		this.config = config;
		this.gcpAuth = gcpAuth;
	}

	async getAuthenticationDetails(c: Context, _ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		const userKey = getApiKeyFromReq(c) || 'N/A';
		if (!this.config.triggerKeys.has(userKey)) {
			throw new Response("Forbidden: A valid trigger key is required for the /vertex endpoint.", { status: 403 });
		}
		const auth = await this.gcpAuth();
		if (!auth && attempt === 1) {
			throw new Response("GCP authentication failed on first attempt. Check GCP_CREDENTIALS.", { status: 503 });
		}
		return { key: null, source: null, gcpToken: auth?.token || null, gcpProject: auth?.projectId || null, maxRetries: this.config.apiRetryLimit };
	}

	buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL {
		if (!auth.gcpProject) throw new Error("Vertex AI requires a GCP Project ID.");
		const loc = this.config.gcpDefaultLocation;
		const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
		const baseUrl = `https://${host}/v1beta1/projects/${auth.gcpProject}/locations/${loc}/endpoints/openapi`;
		
		let targetPath = ctx.path;
		if (targetPath.startsWith('/v1/')) {
			targetPath = targetPath.slice(3); // Removes "/v1" leaving "/chat/completions"
		}
		
		const url = new URL(`${baseUrl}${targetPath}`);
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
	
	processRequestBody(ctx: StrategyContext): BodyInit | null {
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}
		if (!ctx.originalBodyBuffer) {
			return null;
		}
		let bodyToModify: ModelProviderRequestBody;
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
		return JSON.stringify(bodyToModify);
	}
}

class GeminiOpenAIStrategy implements RequestHandlerStrategy {
	private readonly config: AppConfig;

	constructor(config: AppConfig) {
		this.config = config;
	}

	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number) { return _getGeminiAuthDetails(c, ctx.parsedBody?.model ?? null, attempt, "Gemini OpenAI"); }
	buildTargetUrl(ctx: StrategyContext): URL {
		const baseUrl = this.config.apiMappings['/gemini'];
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
				body.data.forEach((m: GeminiModel) => {
					if (m.id?.startsWith('models/')) {
						m.id = m.id.slice(7);
					}
				});
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
	private readonly config: AppConfig;

	constructor(config: AppConfig) {
		this.config = config;
	}

	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number) { const model = ctx.path.match(/\/models\/([^:]+):/)?.[1] ?? null; return _getGeminiAuthDetails(c, model, attempt, "Gemini Native"); }
	buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL {
		if (!auth.key) throw new Response("Gemini Native requires an API Key.", { status: 500 });
		const baseUrl = this.config.apiMappings['/gemini'];
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
	private readonly config: AppConfig;

	constructor(config: AppConfig) {
		this.config = config;
	}

	getAuthenticationDetails() { return { key: null, source: null, gcpToken: null, gcpProject: null, maxRetries: 1 }; }
	buildTargetUrl(ctx: StrategyContext): URL {
		if (!ctx.prefix || !this.config.apiMappings[ctx.prefix]) throw new Response(`Proxy target for prefix '${ctx.prefix}' not in API_MAPPINGS.`, { status: 503 });
		const url = new URL(ctx.path, this.config.apiMappings[ctx.prefix]);
		ctx.originalUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, _auth: AuthenticationDetails) { return buildBaseProxyHeaders(ctx.originalRequest.headers); }
	processRequestBody(ctx: StrategyContext) { return ctx.originalBodyBuffer ?? null; }
}

// =================================================================================
// --- 5. 策略选择器与主处理函数 ---
// =================================================================================

const determineRequestType = (req: Request, body: ArrayBuffer | null): { type: RequestType, prefix: string | null, path: string, parsedBody?: ModelProviderRequestBody | null } => {
	const { pathname } = new URL(req.url);
	if (pathname.startsWith('/vertex/')) {
		return { type: RequestType.VERTEX_AI, prefix: '/vertex', path: pathname.slice('/vertex'.length) };
	}
	const mappings = getApiMappings();
	const prefix = Object.keys(mappings).filter(p => pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0] || null;
	const path = prefix ? pathname.slice(prefix.length) : pathname;
	if (!prefix) {
		return { type: RequestType.UNKNOWN, prefix: null, path };
	}
	if (prefix !== '/gemini') {
		return { type: RequestType.GENERIC_PROXY, prefix, path };
	}
	if (!path.startsWith('/v1beta/')) {
		let parsedBody: ModelProviderRequestBody | null = null;
		if (body && req.method !== 'GET') try { parsedBody = JSON.parse(new TextDecoder().decode(body)); } catch { /* ignore */ }
		return { type: RequestType.GEMINI_OPENAI, prefix, path, parsedBody };
	}
	return { type: RequestType.GEMINI_NATIVE, prefix, path };
};

const STRATEGIES: Partial<Record<RequestType, RequestHandlerStrategy>> = {
	[RequestType.VERTEX_AI]: new VertexAIStrategy(CONFIG, gcpAuthManager.getAuth),
	[RequestType.GEMINI_OPENAI]: new GeminiOpenAIStrategy(CONFIG),
	[RequestType.GEMINI_NATIVE]: new GeminiNativeStrategy(CONFIG),
	[RequestType.GENERIC_PROXY]: new GenericProxyStrategy(CONFIG),
};

const getStrategy = (type: RequestType): RequestHandlerStrategy => {
	const strategy = STRATEGIES[type];
	if (!strategy) {
		throw new Error(`Unsupported type: ${RequestType[type]}`);
	}
	return strategy;
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
				const errorBodyText = await res.text();
				console.error(`Upstream request to ${targetUrl.hostname} FAILED. Status: ${res.status}. Body: ${errorBodyText}`);
				lastError = new Response(errorBodyText, { status: res.status, statusText: res.statusText, headers: res.headers });
				// Stop retrying on client errors (4xx) that are not '429 Too Many Requests'.
				if (res.status >= 400 && res.status < 500 && res.status !== 429) {
					break;
				}
				if (attempts >= maxRetries) break; else continue;
			}
			return strategy.handleResponse ? await strategy.handleResponse(res, context) : res;
		} catch (error) {
			if (error instanceof Response) {
				lastError = error.clone(); await error.body?.cancel();
				if (attempts >= maxRetries) break; else continue;
			} else {
				console.error(`Attempt ${attempts} non-Response error for ${RequestType[type]}:`, error);
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