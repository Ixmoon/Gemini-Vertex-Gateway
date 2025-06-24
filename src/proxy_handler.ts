// src/proxy_handler.ts (已修正)
import { Context } from "hono";
import { GoogleAuth } from "google-auth-library";

import {
	getApiKeyForRequest,
	isTriggerKey,
	getNextPoolKey,
	isVertexModel,
	ApiKeySource,
	ApiKeyResult,
	getApiRetryLimitFromCache,
	getGcpDefaultLocationFromCache,
	isValidCred,
} from "./replacekeys.ts";
import {
	getConfigValue,
	getParsedGcpCredentials,
	setEdgeCacheValue,
	getEdgeCache,
	CACHE_KEYS
} from "./cache.ts";

// === 类型定义 (保持不变) ===
enum RequestType { VERTEX_AI, GEMINI_OPENAI, GEMINI_NATIVE, GENERIC_PROXY, UNKNOWN }
interface AuthenticationDetails {
	key: string | null;
	source: ApiKeySource | null;
	gcpToken: string | null;
	gcpProject: string | null;
	maxRetries: number;
}
interface StrategyContext {
	originalUrl: URL;
	originalRequest: Request;
	path: string;
	prefix: string | null;
	parsedBody?: any | null;
	originalBodyBuffer?: ArrayBuffer | null;
}

// === 基础工具函数 (保持不变) ===
const buildBaseProxyHeaders = (originalHeaders: Headers): Headers => {
	const headers = new Headers();
	originalHeaders.forEach((val, key) => {
		if (key.toLowerCase() !== 'host') {
			headers.set(key, val);
		}
	});
	return headers;
};
const getApiKey = (c: Context): string | null => {
	const { req } = c;
	const url = new URL(req.url);
	return url.searchParams.get('key') ||
		req.header("Authorization")?.replace(/^bearer\s+/i, '') ||
		req.header("x-goog-api-key") ||
		null;
};

// === GCP 凭证处理 (保持不变) ===
const getGcpAuth = async (): Promise<{ token: string; projectId: string } | null> => {
	const creds = await getParsedGcpCredentials();
	if (!creds || creds.length === 0) return null;
	const selectedCred = creds[Math.floor(Math.random() * creds.length)];
	if (!isValidCred(selectedCred)) {
		console.error(`getGcpAuth: Randomly selected credential is invalid.`);
		return null;
	}
	const tokenCacheKey = `${CACHE_KEYS.GCP_AUTH_TOKEN_PREFIX}${selectedCred.client_email}`;
	const projectId = selectedCred.project_id;
	try {
		const cache = await getEdgeCache();
		const cachedResponse = await cache.match(new Request(`http://cache.internal/${encodeURIComponent(tokenCacheKey)}`));
		if (cachedResponse) {
			const token = await cachedResponse.json();
			if (typeof token === 'string' && token.length > 0) return { token, projectId };
		}
	} catch (cacheError) {
		console.error(`[getGcpAuth] Error accessing Edge Cache for token:`, cacheError);
	}
	try {
		const auth = new GoogleAuth({ credentials: selectedCred, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
		const newToken = await auth.getAccessToken();
		if (!newToken) {
			console.error(`getGcpAuth: Failed to get new token for project ${projectId}.`);
			return null;
		}
		setEdgeCacheValue(tokenCacheKey, newToken, 50 * 60).catch(e => console.error(`[getGcpAuth] Error setting token to cache:`, e));
		return { token: newToken, projectId };
	} catch (error) {
		console.error(`getGcpAuth: Error during token acquisition for project ${projectId}:`, error);
		return null;
	}
};

// === 请求处理策略接口与实现 ===
const _getGeminiAuthenticationDetails = async (c: Context, modelName: string | null, attempt: number, strategyName: string): Promise<AuthenticationDetails> => {
	const apiRetryLimit = await getApiRetryLimitFromCache();
	const userApiKey = getApiKey(c);
	const isModelsRequest = new URL(c.req.url).pathname.endsWith('/models');
	let keyResult: ApiKeyResult | null = null;
	if (attempt === 1) {
		keyResult = await getApiKeyForRequest(userApiKey, modelName);
		if (!keyResult && !isModelsRequest) throw new Response(`无可用API密钥 (${strategyName})`, { status: 503 });
	} else if (userApiKey && await isTriggerKey(userApiKey)) {
		const nextPoolKey = await getNextPoolKey();
		if (nextPoolKey) keyResult = { key: nextPoolKey, source: 'pool' };
		else if (!isModelsRequest) throw new Response(`池密钥已耗尽 (${strategyName})`, { status: 503 });
	} else if (!isModelsRequest && attempt > 1) {
		throw new Response(`API Key 无效或请求失败，不重试 (${strategyName})`, { status: 503 });
	}
	return { key: keyResult?.key || null, source: keyResult?.source || null, gcpToken: null, gcpProject: null, maxRetries: keyResult?.source === 'pool' ? apiRetryLimit : 1 };
};

interface RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails>;
	buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): URL | Promise<URL>;
	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers;
	processRequestBody(ctx: StrategyContext): Promise<BodyInit | null | ReadableStream>;
	handleResponse?(response: Response, ctx: StrategyContext): Promise<Response>;
}

class VertexAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(_c: Context, _ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		const apiRetryLimit = await getApiRetryLimitFromCache();
		const auth = await getGcpAuth();
		if (!auth && attempt === 1) throw new Response(`首次 GCP 凭证认证失败`, { status: 503 });
		return { key: null, source: null, gcpToken: auth?.token || null, gcpProject: auth?.projectId || null, maxRetries: apiRetryLimit };
	}

	async buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): Promise<URL> {
		if (!authDetails.gcpProject) throw new Error("Vertex AI 需要 GCP Project ID");
		const gcpDefaultLocation = await getGcpDefaultLocationFromCache();
		const host = gcpDefaultLocation === "global" ? "aiplatform.googleapis.com" : `${gcpDefaultLocation}-aiplatform.googleapis.com`;
		
        // [修正] 构建正确的 Vertex AI OpenAI 兼容 URL。不再包含 /endpoints/openapi/
        const baseUrl = `https://${host}/v1/projects/${authDetails.gcpProject}/locations/${gcpDefaultLocation}`;
        const url = new URL(ctx.path, baseUrl); // 直接将用户路径附加在后面

		ctx.originalUrl.searchParams.forEach((val, key) => {
			if (key.toLowerCase() !== 'key') url.searchParams.set(key, val);
		});
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers {
		if (!authDetails.gcpToken) throw new Error("Vertex AI 需要 GCP Token");
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.set('Authorization', `Bearer ${authDetails.gcpToken}`);
		return headers;
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		// [保持不变] Vertex AI 请求体处理（例如添加 google/ 前缀等）
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') return null;
		if (!ctx.originalBodyBuffer) return null;
		try {
			const bodyToModify = JSON.parse(new TextDecoder().decode(ctx.originalBodyBuffer));
			if (typeof bodyToModify !== 'object' || bodyToModify === null) return JSON.stringify(bodyToModify);
			if (bodyToModify.model && typeof bodyToModify.model === 'string' && !bodyToModify.model.startsWith('google/')) {
				bodyToModify.model = `google/${bodyToModify.model}`;
			}
			bodyToModify.safety_settings = [
				{ "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
				{ "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
				{ "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
				{ "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" },
			];
			return JSON.stringify(bodyToModify);
		} catch (e) {
			console.error("Vertex body modification error:", e);
			throw new Response("Failed to modify Vertex AI request body", { status: 500 });
		}
	}
}

class GeminiOpenAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		const modelName = ctx.parsedBody?.model ?? null;
		return _getGeminiAuthenticationDetails(c, modelName, attempt, "Gemini OpenAI");
	}

	async buildTargetUrl(ctx: StrategyContext, _authDetails: AuthenticationDetails): Promise<URL> {
		const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
		const baseUrl = apiMappings['/gemini'];
		if (!baseUrl) throw new Response("Gemini base URL ('/gemini') not found in API mappings.", { status: 503 });
		
        // [修正] 简化 URL 构建，不再添加 /openai/ 段
        // 直接将用户的路径（如 /v1/chat/completions）拼接到 /v1beta 后面
        const targetPath = `/v1beta${ctx.path}`;
		const url = new URL(targetPath, baseUrl);

		ctx.originalUrl.searchParams.forEach((val, key) => {
			if (key.toLowerCase() !== 'key') url.searchParams.set(key, val);
		});
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers {
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.delete('x-goog-api-key');
		headers.delete('x-api-key');
		if (authDetails.key) headers.set('Authorization', `Bearer ${authDetails.key}`);
		return headers;
	}
	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') return null;
		return ctx.originalBodyBuffer;
	}
	async handleResponse(response: Response, ctx: StrategyContext): Promise<Response> {
        const contentType = response.headers.get("content-type");
		if (!ctx.path.endsWith('/models') || !contentType?.includes("application/json")) return response;
		const body = await response.json();
		if (body?.data?.length) {
			body.data.forEach((model: any) => { if (model?.id?.startsWith('models/')) model.id = model.id.slice(7); });
			const newBody = JSON.stringify(body);
			const newHeaders = new Headers(response.headers);
			newHeaders.set('Content-Length', String(new TextEncoder().encode(newBody).byteLength));
			return new Response(newBody, { status: response.status, statusText: response.statusText, headers: newHeaders });
		}
		return new Response(JSON.stringify(body), response);
	}
}

// GeminiNativeStrategy and GenericProxyStrategy remain the same, so they are omitted for brevity but should be in your final file.
// ... (Your GeminiNativeStrategy and GenericProxyStrategy code here)
class GeminiNativeStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		const modelName = ctx.path.match(/\/models\/([^:]+):/)?.[1] ?? null;
		return _getGeminiAuthenticationDetails(c, modelName, attempt, "Gemini Native");
	}
	async buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): Promise<URL> {
		if (!authDetails.key) throw new Response("Gemini Native strategy requires an API Key", { status: 500 });
		const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
		const baseUrl = apiMappings['/gemini'];
		if (!baseUrl) throw new Response("Gemini base URL not found", { status: 503 });
		const url = new URL(ctx.path, baseUrl);
		ctx.originalUrl.searchParams.forEach((val, key) => { if (key.toLowerCase() !== 'key') url.searchParams.set(key, val); });
		url.searchParams.set('key', authDetails.key);
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, _authDetails: AuthenticationDetails): Headers {
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.delete('x-goog-api-key');
		return headers;
	}
	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') return null;
		return ctx.originalBodyBuffer;
	}
}
class GenericProxyStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(): Promise<AuthenticationDetails> {
		return { key: null, source: null, gcpToken: null, gcpProject: null, maxRetries: 1 };
	}
	async buildTargetUrl(ctx: StrategyContext, _authDetails: AuthenticationDetails): Promise<URL> {
		const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
		if (!ctx.prefix || !apiMappings[ctx.prefix]) throw new Response(`Proxy target for prefix '${ctx.prefix || '(null)'}' not configured.`, { status: 503 });
		const url = new URL(ctx.path, apiMappings[ctx.prefix]);
		ctx.originalUrl.searchParams.forEach((val, key) => url.searchParams.set(key, val));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, _authDetails: AuthenticationDetails): Headers {
		return buildBaseProxyHeaders(ctx.originalRequest.headers);
	}
	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		return ctx.originalBodyBuffer;
	}
}


// === 策略选择器与主处理函数 (保持不变) ===
interface DetermineResult { type: RequestType; prefix: string | null; path: string; parsedBody?: any | null; }
const determineRequestType = async (c: Context, originalBodyBuffer: ArrayBuffer | null): Promise<DetermineResult> => {
	const req = c.req.raw;
	const url = new URL(req.url);
	const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
	const pathname = url.pathname;
	const matchedPrefix = Object.keys(apiMappings).filter(p => pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0] || null;
	const prefix = matchedPrefix;
	const path = prefix ? pathname.slice(prefix.length) : pathname;
	if (!prefix) return { type: RequestType.UNKNOWN, prefix: null, path };
	const isGeminiPrefix = prefix === '/gemini';
	const isOpenAICompatiblePath = isGeminiPrefix && !path.startsWith('/v1beta/');
	if (isOpenAICompatiblePath) {
		let parsedBody: any | null = null;
		if (originalBodyBuffer && req.method !== 'GET' && req.method !== 'HEAD') {
			try { parsedBody = JSON.parse(new TextDecoder().decode(originalBodyBuffer)); } catch (e) { console.warn("determineRequestType: Failed to parse body for model check:", e); }
		}
		const isVertex = await isVertexModel(parsedBody?.model ?? null);
		return { type: isVertex ? RequestType.VERTEX_AI : RequestType.GEMINI_OPENAI, prefix, path, parsedBody };
	} else if (isGeminiPrefix) {
		return { type: RequestType.GEMINI_NATIVE, prefix, path };
	} else {
		return { type: RequestType.GENERIC_PROXY, prefix, path };
	}
};
const getStrategy = (type: RequestType): RequestHandlerStrategy => {
	switch (type) {
		case RequestType.VERTEX_AI: return new VertexAIStrategy();
		case RequestType.GEMINI_OPENAI: return new GeminiOpenAIStrategy();
		case RequestType.GEMINI_NATIVE: return new GeminiNativeStrategy();
		case RequestType.GENERIC_PROXY: return new GenericProxyStrategy();
		default: throw new Error(`不支持的请求类型: ${type}`);
	}
};
export const handleGenericProxy = async (c: Context): Promise<Response> => {
	const req = c.req.raw;
	const url = new URL(req.url);
	let originalBodyBuffer: ArrayBuffer | null = null;
	if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
		try { originalBodyBuffer = await req.clone().arrayBuffer(); } catch (e) {
			console.error("Failed to read request body:", e);
			return new Response("Internal Server Error: Failed to process request body.", { status: 500 });
		}
	}
	let determinationResult: DetermineResult;
	try { determinationResult = await determineRequestType(c, originalBodyBuffer); } catch (error) {
		console.error("Error during request type determination:", error);
		return new Response("Internal Server Error during request routing.", { status: 500 });
	}
	const { type, prefix, path, parsedBody } = determinationResult;
	if (type === RequestType.UNKNOWN) return new Response(`No proxy route for path: ${url.pathname}`, { status: 404 });
	const strategy = getStrategy(type);
	const strategyContext: StrategyContext = { originalUrl: url, originalRequest: req, path, prefix, parsedBody, originalBodyBuffer };
	let attempts = 0;
	let maxRetries = 1;
	let lastErrorResponse: Response | null = null;
	while (attempts < maxRetries) {
		attempts++;
		try {
			const authDetails = await strategy.getAuthenticationDetails(c, strategyContext, attempts);
			if (attempts === 1) maxRetries = authDetails.maxRetries;
			const targetUrl = await strategy.buildTargetUrl(strategyContext, authDetails);
			const targetHeaders = strategy.buildRequestHeaders(strategyContext, authDetails);
			const targetBody = await strategy.processRequestBody(strategyContext);
			const proxyResponse = await fetch(targetUrl.toString(), { method: req.method, headers: targetHeaders, body: targetBody, redirect: 'manual' });
			if (proxyResponse.ok) {
				return strategy.handleResponse ? await strategy.handleResponse(proxyResponse, strategyContext) : proxyResponse;
			} else {
				lastErrorResponse = proxyResponse.clone();
				await proxyResponse.arrayBuffer().catch(() => {});
				if (attempts >= maxRetries) console.error(`Max retries (${maxRetries}) reached for ${RequestType[type]}.`);
			}
		} catch (error) {
			console.error(`Attempt ${attempts}/${maxRetries} caught error during ${RequestType[type]} processing:`, error);
			if (error instanceof Response) {
				lastErrorResponse = error;
			} else {
				return new Response(`Internal Server Error: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
			}
		}
	}
	return lastErrorResponse ?? new Response("Request processing failed after maximum retries.", { status: 502 });
};