// src/deno_index.ts
//
// 该文件是 LLM 网关服务的核心入口点。它负责：
// 1. 使用 Hono 框架设置 Web 服务器。
// 2. 定义所有必要的类型接口和常量。
// 3. 实现一个带状态的、均匀随机的轮询选择器 (RoundRobinSelector)，用于 API 密钥和 GCP 凭据的负载均衡。
//    该选择器使用 crypto.getRandomValues() 以获得高质量的随机性。
// 4. 实现一个策略模式 (Strategy Pattern)，根据请求路径动态选择不同的后端服务处理器（如 Vertex AI, Gemini, Generic Proxy）。
// 5. 管理 GCP 认证和 API 密钥的懒加载和轮询逻辑。配置通过构建时生成的 config_data.ts 模块加载，而非环境变量。
// 6. 处理所有入站请求的代理、重试和错误处理。
// 7. 启动 Deno 服务器。

import { Hono, Context } from "hono";
import { GoogleAuth } from "google-auth-library";
import { AppConfig, configManager } from "./managers.ts";



/**
 * RoundRobinSelector 类实现了带随机洗牌的循环选择逻辑。
 * 它确保在所有元素都被使用之前，每个元素只被选择一次。
 * 当所有元素都用完后，它会重置并重新洗牌，从而实现均匀的随机轮询。
 */
class RoundRobinSelector<T> {
	private originalItems: T[];
	private availableItems: T[];
	private usedItems: T[] = [];

	constructor(items: T[]) {
		this.originalItems = [...items];
		this.availableItems = this._shuffle([...items]);
	}

	/**
	 * 使用 Fisher-Yates 洗牌算法和密码学安全随机数生成器 (crypto.getRandomValues) 随机打乱数组。
	 * 这提供了比 Math.random() 更高质量、更均匀的随机性。
	 * @param array 要打乱的数组。
	 * @returns 打乱后的数组。
	 */
	private _shuffle(array: T[]): T[] {
		let currentIndex = array.length;
		const randomValues = new Uint32Array(1);

		while (currentIndex !== 0) {
			// 生成一个密码学安全的随机索引
			crypto.getRandomValues(randomValues);
			const randomIndex = randomValues[0] % currentIndex;
			currentIndex--;

			// 交换元素
			[array[currentIndex], array[randomIndex]] = [
				array[randomIndex], array[currentIndex]];
		}
		return array;
	}

	/**
	 * 获取下一个可用元素。如果所有元素都已使用，则重置并重新洗牌。
	 * @returns 下一个元素或 undefined（如果原始列表为空）。
	 */
	public next(): T | undefined {
		if (this.originalItems.length === 0) {
			return undefined;
		}

		if (this.availableItems.length === 0) {
			// 所有元素都已用完，重置并重新洗牌
			this.availableItems = this._shuffle([...this.originalItems]);
			this.usedItems = [];
		}

		const selected = this.availableItems.shift(); // 取出第一个元素
		if (selected !== undefined) {
			this.usedItems.push(selected); // 记录为已使用
		}
		return selected;
	}

	/**
	 * 强制重置选择器，清空已使用列表并重新洗牌。
	 */
	public reset(): void {
		this.availableItems = this._shuffle([...this.originalItems]);
		this.usedItems = [];
	}
}

// =================================================================================
// --- 1. 类型定义与常量 ---
// =================================================================================

export interface GcpCredentials { type: string; project_id: string; private_key_id: string; private_key: string; client_email: string; client_id?: string; }
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
        const credentials = config.gcpCredentials;
        if (credentials.length === 0) {
            console.warn("[GCP] No valid GCP credentials found in the configuration.");
        }
        const credentialSelector = new RoundRobinSelector(credentials);

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
            const selectedCredential = credentialSelector.next();
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

// --- API Key Pool Selector (Singleton) ---
const poolKeySelector = new RoundRobinSelector(configManager.get().poolKeys);


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
	const poolKey = poolKeySelector.next();
	if (poolKey) return { key: poolKey, source: 'pool' };
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
		const poolKey = poolKeySelector.next();
		if (poolKey) result = { key: poolKey, source: 'pool' };
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
	const originalReq = c.req.raw;
	const { type, ...details } = determineRequestType(originalReq);

	if (type === RequestType.UNKNOWN) {
		return c.json({ error: `No route for path: ${new URL(originalReq.url).pathname}` }, 404);
	}

	try {
		const strategy = await strategyManager.get(type);
		
		// --- Body Caching Logic for Retries ---
		let bodyBufferPromise: Promise<ArrayBuffer | null> | null = null;
		let requestForFirstAttempt = originalReq;

		if (originalReq.body && (originalReq.method === 'POST' || originalReq.method === 'PUT' || originalReq.method === 'PATCH')) {
			const [stream1, stream2] = originalReq.body.tee();
			requestForFirstAttempt = new Request(originalReq, { body: stream1 });
			bodyBufferPromise = (async () => {
				try {
					return await new Response(stream2).arrayBuffer();
				} catch (e) {
					console.error("Error buffering request body:", e);
					return null; // Return null if buffering fails
				}
			})();
		}
		// --- End of Body Caching Logic ---

		let attempts = 0, maxRetries = 1, lastError: Response | null = null;

		while (attempts < maxRetries) {
			attempts++;
			try {
				let currentRequest = requestForFirstAttempt;
				// For retries, use the buffered body
				if (attempts > 1) {
					if (!bodyBufferPromise) {
						// This should not happen if the first attempt had a body, but as a safeguard:
						throw new Error("Cannot retry request: original body was not buffered.");
					}
					const bodyBuffer = await bodyBufferPromise;
					if (bodyBuffer === null) {
						throw new Error("Cannot retry request: body buffering failed.");
					}
					currentRequest = new Request(originalReq, { body: bodyBuffer });
				}

				const context: StrategyContext = {
					originalUrl: new URL(currentRequest.url),
					originalRequest: currentRequest,
					...details
				};

				const auth = await strategy.getAuthenticationDetails(c, context, attempts);
				
				if (attempts === 1) {
					maxRetries = auth.maxRetries;
				}

				const [targetUrl, targetBody, targetHeaders] = await Promise.all([
					Promise.resolve(strategy.buildTargetUrl(context, auth)),
					Promise.resolve(strategy.processRequestBody(context)),
					Promise.resolve(strategy.buildRequestHeaders(context, auth))
				]);

				const res = await fetch(targetUrl, {
					method: currentRequest.method,
					headers: targetHeaders,
					body: targetBody,
					signal: currentRequest.signal,
				});

				if (!res.ok) {
					const errorBodyText = await res.text();
					console.error(`Upstream request to ${targetUrl.hostname} FAILED. Status: ${res.status}. Body: ${errorBodyText}`);
					lastError = new Response(errorBodyText, { status: res.status, statusText: res.statusText, headers: res.headers });
					if (res.status >= 400 && res.status < 500 && res.status !== 429) {
						break;
					}
					if (attempts >= maxRetries) break; else continue;
				}
				
				const finalContext: StrategyContext = {
					originalUrl: new URL(originalReq.url),
					originalRequest: originalReq,
					...details
				};
				return strategy.handleResponse ? await strategy.handleResponse(res, finalContext) : res;

			} catch (error) {
				if (error instanceof Response) {
					lastError = error;
					if (error.body && !error.bodyUsed) await error.body.cancel();
					if (error.status >= 400 && error.status < 500) break;
					if (attempts >= maxRetries) break; else continue;
				}
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