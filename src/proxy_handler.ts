/**
 * L3 - 应用层 (代理处理器)
 * 负责处理实际的HTTP代理请求。
 */
import { Context } from "hono";
import {
	getApiKeyForRequest,
	getApiRetryLimit,
	getGcpAuth,
	getGcpDefaultLocation,
	getNextPoolKey,
	isTriggerKey, 
	getApiMappings,
	ApiKeyResult,
} from "./config_logic.ts";

// --- 硬编码的目标地址 ---
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const VERTEX_AI_HOST_TEMPLATE = "{location}-aiplatform.googleapis.com";

// --- 类型定义 ---
enum RequestType { VERTEX_AI, GEMINI_OPENAI, GEMINI_NATIVE, GENERIC_PROXY, UNKNOWN }

interface StrategyContext {
	originalUrl: URL;
	originalRequest: Request;
	path: string;
	bodyBuffer?: ArrayBuffer;
}
interface AuthDetails {
	key?: string | null;
	gcpToken?: string | null;
	gcpProject?: string | null;
	maxRetries: number;
}

// --- 策略接口与实现 ---
interface RequestHandlerStrategy {
	getAuthDetails(c: Context, attempt: number): Promise<AuthDetails>;
	buildTargetUrl(ctx: StrategyContext, auth: AuthDetails): Promise<URL>;
	buildRequest(ctx: StrategyContext, auth: AuthDetails, targetUrl: URL): Promise<Request>;
	processResponse?(res: Response): Promise<Response>;
}

// --- Gemini 策略 (原生 & OpenAI 兼容) ---
class GeminiStrategy implements RequestHandlerStrategy {
	constructor(private isOpenAICompat: boolean) {}

	async getAuthDetails(c: Context, attempt: number): Promise<AuthDetails> {
		const userKey = c.req.header("Authorization")?.replace(/^bearer\s+/i, '') ?? null;
		let modelName: string | null = null;
		if (this.isOpenAICompat && c.get("parsedBody")) {
			modelName = c.get("parsedBody").model ?? null;
		}

		// For Gemini paths, a trigger key is always required.
		if (!await isTriggerKey(userKey)) {
			throw new Response("Unauthorized: A valid trigger key is required for Gemini requests.", { status: 401 });
		}

		let keyResult: ApiKeyResult | null = null;
		if (attempt === 1) {
			keyResult = await getApiKeyForRequest(userKey, modelName); // This userKey is already validated as a trigger key
		} else { // Retrying, should use a pool key if applicable
			const poolKey = await getNextPoolKey();
			if (poolKey) {
				keyResult = { key: poolKey, source: 'pool' };
			}
		}

		if (!keyResult?.key) {
			throw new Response("No available Google API key for this request (pool empty or fallback not configured).", { status: 503 });
		}

		const maxRetries = keyResult.source === 'pool' ? await getApiRetryLimit() : 1;
		return { key: keyResult.key, maxRetries };
	}

	async buildTargetUrl(ctx: StrategyContext, auth: AuthDetails): Promise<URL> {
		const targetUrl = new URL(GEMINI_BASE_URL);
		
		if (this.isOpenAICompat) {
			targetUrl.pathname = `/v1beta/openai${ctx.path}`;
		} else {
			targetUrl.pathname = ctx.path;
			targetUrl.searchParams.set('key', auth.key!);
		}
		
		ctx.originalUrl.searchParams.forEach((v, k) => {
			if (k.toLowerCase() !== 'key') {
				targetUrl.searchParams.set(k, v);
			}
		});

		return targetUrl;
	}

	async buildRequest(ctx: StrategyContext, auth: AuthDetails, targetUrl: URL): Promise<Request> {
		const headers = new Headers(ctx.originalRequest.headers);
		headers.delete('host');
		headers.delete('authorization'); // Remove original auth, as we're setting a new one or using API key in URL
		if (this.isOpenAICompat && auth.key) {
			headers.set('Authorization', `Bearer ${auth.key}`);
		}
		return new Request(targetUrl, {
			method: ctx.originalRequest.method,
			headers: headers,
			body: ctx.bodyBuffer,
		});
	}

	async processResponse(res: Response): Promise<Response> {
        if (!this.isOpenAICompat || !res.ok || !res.headers.get('content-type')?.includes('application/json')) {
            return res;
        }
        try {
            const body = await res.json();
            if (body?.data && Array.isArray(body.data)) {
                body.data.forEach((model: any) => {
                    if (model.id && typeof model.id === 'string' && model.id.startsWith('models/')) {
                        model.id = model.id.substring(7);
                    }
                });
                const newBody = JSON.stringify(body);
                const newHeaders = new Headers(res.headers);
                newHeaders.set('Content-Length', String(new TextEncoder().encode(newBody).length));
                return new Response(newBody, { status: res.status, statusText: res.statusText, headers: newHeaders });
            }
        } catch (e) {
            console.error("Error processing Gemini OpenAI response:", e);
        }
        return res.clone(); // Return cloned original if modification fails or not applicable
    }
}

// --- Vertex AI 策略 ---
class VertexAIStrategy implements RequestHandlerStrategy {
	async getAuthDetails(c: Context, _attempt: number): Promise<AuthDetails> {
		const userKey = c.req.header("Authorization")?.replace(/^bearer\s+/i, '') ?? null;
		if (!await isTriggerKey(userKey)) { // Vertex AI access via gateway also requires a trigger key
			throw new Response("Unauthorized: A valid trigger key is required for Vertex AI requests.", { status: 401 });
		}

		const auth = await getGcpAuth();
		if (!auth) {
			throw new Response("Failed to get GCP credentials for Vertex AI.", { status: 503 });
		}
		return {
			gcpToken: auth.token,
			gcpProject: auth.projectId,
			maxRetries: await getApiRetryLimit(),
		};
	}

	async buildTargetUrl(ctx: StrategyContext, auth: AuthDetails): Promise<URL> {
		if (!auth.gcpProject) {
			throw new Error("Vertex AI requires a GCP Project ID.");
		}
		const location = await getGcpDefaultLocation();
		const host = location === "global"
			? "aiplatform.googleapis.com"
			: VERTEX_AI_HOST_TEMPLATE.replace('{location}', location);

		const baseUrl = `https://${host}/v1/projects/${auth.gcpProject}/locations/${location}`;
		const targetUrl = new URL(`${baseUrl}${ctx.path}`);
		
		ctx.originalUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));
		
		return targetUrl;
	}

	async buildRequest(ctx: StrategyContext, auth: AuthDetails, targetUrl: URL): Promise<Request> {
		const headers = new Headers(ctx.originalRequest.headers);
		headers.delete('host');
		headers.delete('authorization'); // Remove original auth, as we're setting a new GCP Bearer token
		if (auth.gcpToken) {
		    headers.set('Authorization', `Bearer ${auth.gcpToken}`);
        }
		return new Request(targetUrl, {
			method: ctx.originalRequest.method,
			headers,
			body: ctx.bodyBuffer,
		});
	}
}

// --- Generic Proxy Strategy for custom mappings ---
class GenericProxyStrategy implements RequestHandlerStrategy {
	constructor(private targetBaseUrl: string) {}

	async getAuthDetails(c: Context, _attempt: number): Promise<AuthDetails> {
		// For generic proxy, authentication is handled by the client and the target service.
		// The gateway does not interfere with or require its own "trigger key" for these.
		// If a specific custom path needs gateway-level auth, it should be a new strategy.
		return { maxRetries: 1 }; // No retries at this level for generic proxy
	}

	async buildTargetUrl(ctx: StrategyContext, _auth: AuthDetails): Promise<URL> {
		const targetUrl = new URL(ctx.path, this.targetBaseUrl);
		ctx.originalUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));
		return targetUrl;
	}

	async buildRequest(ctx: StrategyContext, _auth: AuthDetails, targetUrl: URL): Promise<Request> {
		const headers = new Headers(ctx.originalRequest.headers);
		// Crucially, DO NOT delete 'authorization' header here.
		// The client is responsible for sending the correct Authorization header for the target service.
		headers.delete('host');
		return new Request(targetUrl, {
			method: ctx.originalRequest.method,
			headers,
			body: ctx.bodyBuffer,
		});
	}
}

// --- 策略选择器 ---
async function determineRequestType(c: Context, pathname: string): Promise<{ type: RequestType; strategy: RequestHandlerStrategy | null; path: string }> {
	const customMappings = await getApiMappings();
	
	// Define fixed paths first, then check custom mappings
	if (pathname.startsWith('/gemini/')) {
		const path = pathname.substring('/gemini'.length); // e.g. /v1/chat/completions
		const isOpenAICompat = /^\/v1\/(chat\/completions|embeddings|models)/.test(path);
		if (isOpenAICompat && c.req.method !== 'GET' && c.req.method !== 'HEAD') { // Parse body for OpenAI compat POST/PUT etc.
			try {
				const clonedReq = c.req.raw.clone();
				const body = await clonedReq.json().catch(() => null);
				c.set("parsedBody", body); // Store for use in strategy if needed
			} catch (e) {
				console.warn("Failed to parse body for OpenAI compat path:", e);
				c.set("parsedBody", null);
			}
		}
		return { type: isOpenAICompat ? RequestType.GEMINI_OPENAI : RequestType.GEMINI_NATIVE, strategy: new GeminiStrategy(isOpenAICompat), path };
	}
	
	if (pathname.startsWith('/vertex/')) {
		const path = pathname.substring('/vertex'.length); // e.g. /publishers/google/models/gemini-pro:streamGenerateContent
		return { type: RequestType.VERTEX_AI, strategy: new VertexAIStrategy(), path };
	}
	
	// Check custom mappings (longest prefix match)
	const matchedPrefix = Object.keys(customMappings)
		.filter(prefix => pathname.startsWith(prefix))
		.sort((a, b) => b.length - a.length)[0];

	if (matchedPrefix) {
		const path = pathname.substring(matchedPrefix.length);
		const targetUrl = customMappings[matchedPrefix];
		return { type: RequestType.GENERIC_PROXY, strategy: new GenericProxyStrategy(targetUrl), path };
	}

	return { type: RequestType.UNKNOWN, strategy: null, path: pathname };
}


// --- 主处理函数 ---
export async function handleProxy(c: Context): Promise<Response> {
	const { req } = c;
	const url = new URL(req.url);

	const { type, strategy, path } = await determineRequestType(c, url.pathname);
	if (type === RequestType.UNKNOWN || !strategy) {
		return new Response(`Proxy route not found for path: ${url.pathname}`, { status: 404 });
	}

	const bodyBuffer = (req.method !== 'GET' && req.method !== 'HEAD' && req.raw.body)
		? await req.raw.clone().arrayBuffer() // Clone to allow body to be read multiple times if needed
		: undefined;

	const strategyContext: StrategyContext = {
		originalUrl: url,
		originalRequest: req.raw,
		path,
		bodyBuffer,
	};

	let attempts = 0;
	let maxRetries = 1; // Default, will be overridden by strategy
	let lastErrorResponse: Response | null = null;

	while (attempts < maxRetries) {
		attempts++;
		try {
			const authDetails = await strategy.getAuthDetails(c, attempts);
			if (attempts === 1) maxRetries = authDetails.maxRetries; // Set maxRetries on first attempt

			const targetUrl = await strategy.buildTargetUrl(strategyContext, authDetails);
			const targetRequest = await strategy.buildRequest(strategyContext, authDetails, targetUrl);
			
			console.log(`[Proxy Attempt ${attempts}/${maxRetries}] ${targetRequest.method} ${targetUrl.toString()}`);
			const proxyResponse = await fetch(targetRequest);

			if (proxyResponse.ok) {
				if (strategy.processResponse) {
					return await strategy.processResponse(proxyResponse);
				}
				return proxyResponse; // Success
			}

			// Handle non-OK responses
			console.warn(`[Proxy Attempt ${attempts}/${maxRetries}] Failed for ${RequestType[type]} to ${targetUrl}: ${proxyResponse.status} ${proxyResponse.statusText}`);
			lastErrorResponse = proxyResponse.clone(); // Clone before consuming body
			await proxyResponse.body?.cancel().catch(() => {}); // Consume body to release connection

			if (proxyResponse.status === 401 || proxyResponse.status === 403) {
				// Don't retry on auth errors from upstream, unless it's a pool key that failed
				if (authDetails.key && attempts < maxRetries) { // implies it was likely a pool key
					console.log(`[Proxy Attempt ${attempts}/${maxRetries}] Auth error with a potentially pooled key. Will retry if possible.`);
					continue;
				}
				break; // Critical auth error, stop retrying
			}


		} catch (error) {
			console.error(`[Proxy Attempt ${attempts}/${maxRetries}] Caught an error during ${RequestType[type]} processing:`, error);
			if (error instanceof Response) { // Strategy threw a Response (e.g., no key available)
				lastErrorResponse = error;
                await error.body?.cancel().catch(() => {});
                // If the strategy itself says "Unauthorized" (e.g. no trigger key), don't retry.
                if (error.status === 401 || error.status === 403) break; 
			} else { // Network error or other unexpected issue
				const message = error instanceof Error ? error.message : String(error);
				// Don't retry on unexpected errors, return 500 or last known error
				return lastErrorResponse ?? new Response(`Internal Server Error during proxy: ${message}`, { status: 500 });
			}
		}
	} // End while loop

	return lastErrorResponse ?? new Response("Request failed after all retries or due to a critical error.", { status: 502 });
}