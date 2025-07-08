import { Hono, Context } from "hono";
import { GoogleAuth } from "google-auth-library";
import { AppConfig, configManager } from "./managers.ts";

const getRandomElement = <T>(arr: T[]): T | undefined => {
	if (arr.length === 0) return undefined;
	return arr[Math.floor(Math.random() * arr.length)];
};

// =================================================================================
// --- 1. 类型定义与常量 ---
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
interface StrategyContext { originalUrl: URL; originalRequest: Request; path: string; prefix: string | null; }

// =================================================================================
// --- 2. 请求处理策略 (Strategy Pattern) ---
// =================================================================================

interface RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails>;
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
	
	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD' || !ctx.originalRequest.body) {
			return null;
		}
		try {
			const bodyToModify = await ctx.originalRequest.json() as ModelProviderRequestBody;
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
			console.error("Vertex: Failed to parse request body from stream:", e);
			throw new Response("Failed to parse request body for Vertex AI. Invalid JSON.", { status: 400 });
		}
	}
}

class GeminiOpenAIStrategy implements RequestHandlerStrategy {
	private readonly config: AppConfig;

	constructor(config: AppConfig) {
		this.config = config;
	}

	async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		// Clone the request to read the body, allowing the original body to be streamed later.
		const reqClone = ctx.originalRequest.clone();
		const model = reqClone.body ? (await reqClone.json().catch(() => ({})) as ModelProviderRequestBody).model ?? null : null;
		return _getGeminiAuthDetails(c, model, attempt, "Gemini OpenAI");
	}
	buildTargetUrl(ctx: StrategyContext): URL {
		const baseUrl = this.config.apiMappings['/gemini'];
		if (!baseUrl) throw new Response("Gemini base URL for '/gemini' not in API_MAPPINGS.", { status: 503 });

		// 从原始路径中移除可选的 /v1 前缀，以获得标准的 OpenAI 路径
		let openAIPath = ctx.path;
		if (openAIPath.startsWith('/v1/')) {
			openAIPath = openAIPath.slice(3); // e.g., /v1/chat/completions -> /chat/completions
		}

		// 构建符合 Gemini OpenAI 兼容层要求的正确路径
		const geminiPath = `/v1beta/openai${openAIPath}`;

		const url = new URL(geminiPath, baseUrl);
		ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers {
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization'); headers.delete('x-goog-api-key');
		if (auth.key) headers.set('Authorization', `Bearer ${auth.key}`);
		return headers;
	}
	processRequestBody(ctx: StrategyContext) { return ctx.originalRequest.body; }
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

	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> { const model = ctx.path.match(/\/models\/([^:]+):/)?.[1] ?? null; return Promise.resolve(_getGeminiAuthDetails(c, model, attempt, "Gemini Native")); }
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
	processRequestBody(ctx: StrategyContext) { return ctx.originalRequest.body; }
}

class GenericProxyStrategy implements RequestHandlerStrategy {
	private readonly config: AppConfig;

	constructor(config: AppConfig) {
		this.config = config;
	}

	getAuthenticationDetails(): Promise<AuthenticationDetails> { return Promise.resolve({ key: null, source: null, gcpToken: null, gcpProject: null, maxRetries: 1 }); }
	buildTargetUrl(ctx: StrategyContext): URL {
		if (!ctx.prefix || !this.config.apiMappings[ctx.prefix]) throw new Response(`Proxy target for prefix '${ctx.prefix}' not in API_MAPPINGS.`, { status: 503 });
		const url = new URL(ctx.path, this.config.apiMappings[ctx.prefix]);
		ctx.originalUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, _auth: AuthenticationDetails) { return buildBaseProxyHeaders(ctx.originalRequest.headers); }
	processRequestBody(ctx: StrategyContext) { return ctx.originalRequest.body; }
}

// =================================================================================
// --- 3. 懒加载管理器 ---
// =================================================================================

const isValidGcpCred = (cred: unknown): cred is GcpCredentials => {
	if (typeof cred !== 'object' || cred === null) return false;
	const maybeCred = cred as Record<string, unknown>;
	return (
		maybeCred.type === 'service_account' &&
		!!maybeCred.project_id &&
		!!maybeCred.private_key &&
		!!maybeCred.client_email
	);
};

// --- GCP Auth Manager (Lazy Loaded) ---
interface GcpAuth {
    getAuth: () => Promise<{ token: string; projectId: string; } | null>;
}

class GcpAuthManager {
    private authInstance: GcpAuth | null = null;
    private initPromise: Promise<GcpAuth> | null = null;

    private initialize(): GcpAuth {
        const config = configManager.get();
        const authInstanceCache = new Map<string, GoogleAuth>();
        let credentials: GcpCredentials[] = [];

        try {
            const credsStr = config.gcpCredentialsString;
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
                authInstanceCache.set(credential.client_email, new GoogleAuth({
                    credentials: credential,
                    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
                }));
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

        this.authInstance = { getAuth };
        return this.authInstance;
    }

    public get(): Promise<GcpAuth> {
        if (this.authInstance) return Promise.resolve(this.authInstance);
        if (!this.initPromise) {
            // Wrap initialize in a promise to handle concurrent requests during initialization
            this.initPromise = new Promise((resolve) => {
                const instance = this.initialize();
                resolve(instance);
            });
        }
        return this.initPromise;
    }
}
const gcpAuthManager = new GcpAuthManager();


// --- Strategy Manager (Lazy Loaded & Race-Condition Safe) ---
class StrategyManager {
    private strategyCache: Partial<Record<RequestType, RequestHandlerStrategy>> = {};
    private initPromises: Partial<Record<RequestType, Promise<RequestHandlerStrategy>>> = {};

    public get(type: RequestType): Promise<RequestHandlerStrategy> {
        if (this.strategyCache[type]) {
            return Promise.resolve(this.strategyCache[type]!);
        }

        if (this.initPromises[type]) {
            return this.initPromises[type]!;
        }

        const initPromise = (async (): Promise<RequestHandlerStrategy> => {
            try {
                const config = configManager.get();
                let strategy: RequestHandlerStrategy;

                switch (type) {
                    case RequestType.VERTEX_AI: {
                        const gcpAuth = await gcpAuthManager.get();
                        strategy = new VertexAIStrategy(config, gcpAuth.getAuth);
                        break;
                    }
                    case RequestType.GEMINI_OPENAI:
                        strategy = new GeminiOpenAIStrategy(config);
                        break;
                    case RequestType.GEMINI_NATIVE:
                        strategy = new GeminiNativeStrategy(config);
                        break;
                    case RequestType.GENERIC_PROXY:
                        strategy = new GenericProxyStrategy(config);
                        break;
                    default:
                        throw new Error(`Unsupported strategy type: ${RequestType[type]}`);
                }

                this.strategyCache[type] = strategy;
                return strategy;
            } finally {
                // Clean up the promise from the map once it's settled.
                delete this.initPromises[type];
            }
        })();

        this.initPromises[type] = initPromise;
        return initPromise;
    }
}
const strategyManager = new StrategyManager();

const getApiKeyForRequest = (userKey: string | null, model: string | null): ApiKeyResult | null => {
	if (!userKey) return null;
	const config = configManager.get();
	if (!config.triggerKeys.has(userKey)) return { key: userKey, source: 'user' };
	if (model && config.fallbackModels.has(model.trim())) {
		if (config.fallbackKey) return { key: config.fallbackKey, source: 'fallback' };
	}
	const randomPoolKey = getRandomElement(config.poolKeys);
	if (randomPoolKey) return { key: randomPoolKey, source: 'pool' };
	return null;
};

const getApiKeyFromReq = (c: Context): string | null => {
	const url = new URL(c.req.url);
	return url.searchParams.get('key') || c.req.header("Authorization")?.replace(/^bearer\s+/i, '') || c.req.header("x-goog-api-key") || null;
};
const buildBaseProxyHeaders = (h: Headers): Headers => { const n = new Headers(h); n.delete('host'); return n; };

const _getGeminiAuthDetails = (c: Context, model: string | null, attempt: number, name: string): AuthenticationDetails => {
	const userApiKey = getApiKeyFromReq(c);
	const config = configManager.get();
	const isModels = new URL(c.req.url).pathname.endsWith('/models');
	let result: ApiKeyResult | null = null;
	if (attempt === 1) {
		result = getApiKeyForRequest(userApiKey, model);
		if (!result && !isModels) throw new Response(`No valid API key (${name})`, { status: 401 });
	} else if (userApiKey && config.triggerKeys.has(userApiKey)) {
		const randomPoolKey = getRandomElement(config.poolKeys);
		if (randomPoolKey) result = { key: randomPoolKey, source: 'pool' };
		else if (!isModels) throw new Response(`Key pool exhausted (${name})`, { status: 503 });
	} else if (attempt > 1 && !isModels) {
		throw new Response(`Request failed, non-trigger key won't be retried (${name})`, { status: 503 });
	}
	return { key: result?.key || null, source: result?.source || null, gcpToken: null, gcpProject: null, maxRetries: result?.source === 'pool' ? config.apiRetryLimit : 1 };
};

// =================================================================================
// --- 4. 策略选择器与主处理函数 ---
// =================================================================================

const determineRequestType = (req: Request): { type: RequestType, prefix: string | null, path: string } => {
	const { pathname } = new URL(req.url);
	if (pathname.startsWith('/vertex/')) {
		return { type: RequestType.VERTEX_AI, prefix: '/vertex', path: pathname.slice('/vertex'.length) };
	}
	const mappings = configManager.get().apiMappings;
	const prefix = Object.keys(mappings).find(p => pathname.startsWith(p));
	const path = prefix ? pathname.slice(prefix.length) : pathname;
	if (!prefix) {
		return { type: RequestType.UNKNOWN, prefix: null, path };
	}
	if (prefix !== '/gemini') {
		return { type: RequestType.GENERIC_PROXY, prefix, path };
	}
	if (!path.startsWith('/v1beta/')) {
		return { type: RequestType.GEMINI_OPENAI, prefix, path };
	}
	return { type: RequestType.GEMINI_NATIVE, prefix, path };
};


const handleGenericProxy = async (c: Context): Promise<Response> => {
	const req = c.req.raw;
	const { type, ...details } = determineRequestType(req);

	if (type === RequestType.UNKNOWN) {
		return c.json({ error: `No route for path: ${new URL(req.url).pathname}` }, 404);
	}

	try {
		const strategy = await strategyManager.get(type);
		const context: StrategyContext = {
			originalUrl: new URL(req.url),
			originalRequest: req,
			...details
		};

		let attempts = 0, maxRetries = 1, lastError: Response | null = null;

		while (attempts < maxRetries) {
			attempts++;
			try {
				// The body processing can be independent of auth details for all strategies now.
				// We get auth details first, which might depend on the body, but we process the body stream later.
				const auth = await strategy.getAuthenticationDetails(c, context, attempts);
				
				if (attempts === 1) {
					maxRetries = auth.maxRetries;
				}

				// Parallelize fetching target URL/body/headers
				const [targetUrl, targetBody, targetHeaders] = await Promise.all([
					Promise.resolve(strategy.buildTargetUrl(context, auth)),
					Promise.resolve(strategy.processRequestBody(context)),
					Promise.resolve(strategy.buildRequestHeaders(context, auth))
				]);

				const res = await fetch(targetUrl, {
					method: req.method,
					headers: targetHeaders,
					body: targetBody,
					signal: req.signal,
				});

				if (!res.ok) {
					const errorBodyText = await res.text();
					console.error(`Upstream request to ${targetUrl.hostname} FAILED. Status: ${res.status}. Body: ${errorBodyText}`);
					lastError = new Response(errorBodyText, { status: res.status, statusText: res.statusText, headers: res.headers });
					if (res.status >= 400 && res.status < 500 && res.status !== 429) {
						break; // Don't retry on client errors like 400 or 403
					}
					if (attempts >= maxRetries) break; else continue;
				}

				return strategy.handleResponse ? await strategy.handleResponse(res, context) : res;

			} catch (error) {
				if (error instanceof Response) {
					lastError = error; // It's already a response, no need to clone
					// Ensure body is consumed to prevent resource leaks
					if (error.body && !error.bodyUsed) await error.body.cancel();
					// Break on client-side errors thrown as responses
					if (error.status >= 400 && error.status < 500) break;
					if (attempts >= maxRetries) break; else continue;
				}
				// Re-throw non-Response errors to be caught by the outer catch block
				throw error;
			}
		}
		return lastError ?? c.json({ error: "Request failed after all retries." }, 502);

	} catch (error) {
		console.error(`Critical error in handleGenericProxy for ${RequestType[type]}:`, error);
		if (error instanceof Response) {
			return error;
		}
		if (error instanceof Error && error.name === 'AbortError') {
			return new Response("Client disconnected", { status: 499 });
		}
		return c.json({ error: `Internal Server Error: ${error instanceof Error ? error.message : "Unknown"}` }, 500);
	}
};

// =================================================================================
// --- 5. Hono 服务器设置与启动 ---
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
Deno.serve(app.fetch);