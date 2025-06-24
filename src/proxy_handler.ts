/**
 * @file 通用代理处理器
 * @description
 * 包含所有代理请求的核心处理逻辑。它根据请求路径、内容等确定请求类型（如 Vertex, Gemini），
 * 然后选择相应的策略来处理认证、目标 URL 构建、请求/响应修改和重试。
 */
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

// === 类型定义 ===

/** 请求处理类型枚举，用于策略分发 */
enum RequestType {
	VERTEX_AI,
	GEMINI_OPENAI,
	GEMINI_NATIVE,
	GENERIC_PROXY,
	UNKNOWN
}

/** 认证详情，由策略返回，包含处理请求所需的所有凭证信息 */
interface AuthenticationDetails {
	key: string | null;         // Gemini API Key
	source: ApiKeySource | null;// 密钥来源
	gcpToken: string | null;    // GCP Access Token
	gcpProject: string | null;  // GCP Project ID
	maxRetries: number;         // 最大重试次数
}

/** 传递给策略的上下文信息，避免重复解析和计算 */
interface StrategyContext {
	originalUrl: URL;
	originalRequest: Request;
	path: string;
	prefix: string | null;
	parsedBody?: any | null;
	originalBodyBuffer?: ArrayBuffer | null;
}

// === 全局工具 ===

/** 构建基础代理 Headers，过滤掉 host 等特定头 */
const buildBaseProxyHeaders = (originalHeaders: Headers): Headers => {
	const headers = new Headers();
	originalHeaders.forEach((val, key) => {
		// Host 头由 fetch 根据目标 URL 自动生成，必须移除
		if (key.toLowerCase() !== 'host') {
			headers.set(key, val);
		}
	});
	return headers;
};

/** 从请求中提取用户提供的 API Key */
const getApiKey = (c: Context): string | null => {
	const { req } = c;
	const url = new URL(req.url);
	return url.searchParams.get('key') ||
		req.header("Authorization")?.replace(/^bearer\s+/i, '') ||
		req.header("x-goog-api-key") ||
		null;
};

// === GCP 凭证处理 ===

/**
 * 按需获取 GCP 认证 Token。
 * 这是一个经过高度优化的函数，它利用 Edge Cache 来存储和复用 Access Token。
 * 1. 从缓存中随机选择一个有效的 GCP 凭证。
 * 2. 构造 Token 的缓存键（基于 client_email 保证唯一性）。
 * 3. 优先从 Edge Cache 中获取 Token。
 * 4. 如果缓存未命中，则使用 google-auth-library 生成新 Token。
 * 5. 将新 Token 存入 Edge Cache，并设置 50 分钟的 TTL。
 * @returns 包含 token 和 projectId 的对象，或在失败时返回 null。
 */
const getGcpAuth = async (): Promise<{ token: string; projectId: string } | null> => {
	// 1. 从缓存/KV中读取并解析凭证
	const creds = await getParsedGcpCredentials();
	if (!creds || creds.length === 0) {
		return null;
	}

	// 2. 随机选择一个凭证以实现负载均衡
	const selectedCred = creds[Math.floor(Math.random() * creds.length)];
	if (!isValidCred(selectedCred)) {
		console.error(`getGcpAuth: Randomly selected credential is invalid.`);
		return null;
	}

	// 3. 构造 Token 缓存键
	const tokenCacheKey = `${CACHE_KEYS.GCP_AUTH_TOKEN_PREFIX}${selectedCred.client_email}`;
	const projectId = selectedCred.project_id;

	// 4. 尝试从 Edge Cache 获取 Token
	try {
		const cache = await getEdgeCache();
		const cacheRequest = new Request(`http://cache.internal/${encodeURIComponent(tokenCacheKey)}`);
		const cachedResponse = await cache.match(cacheRequest);

		if (cachedResponse) {
			const token = JSON.parse(await cachedResponse.text() || 'null');
			if (typeof token === 'string' && token.length > 0) {
				return { token, projectId };
			}
		}
	} catch (cacheError) {
		console.error(`[getGcpAuth] Error accessing Edge Cache for token:`, cacheError);
	}

	// 5. 缓存未命中，生成新 Token
	try {
		const auth = new GoogleAuth({
			credentials: selectedCred,
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
		});
		const newToken = await auth.getAccessToken();

		if (!newToken) {
			console.error(`getGcpAuth: Failed to get new token for project ${projectId}.`);
			return null;
		}

		// 6. 将新 Token 存入 Edge Cache，TTL 50分钟 (3000秒)
		const tokenTtlSeconds = 50 * 60;
		setEdgeCacheValue(tokenCacheKey, newToken, tokenTtlSeconds).catch(err => {
			console.error(`[getGcpAuth] Error setting new token to cache:`, err);
		});

		return { token: newToken, projectId };
	} catch (error) {
		console.error(`getGcpAuth: Error during new token acquisition for project ${projectId}:`, error);
		return null;
	}
};

// === 请求处理策略接口与实现 ===

/** [内部] Gemini 策略获取认证详情的公共逻辑 */
const _getGeminiAuthenticationDetails = async (
	c: Context,
	modelNameForKeyLookup: string | null,
	attempt: number,
	strategyName: string
): Promise<AuthenticationDetails> => {
	const apiRetryLimit = await getApiRetryLimitFromCache();
	const userApiKey = getApiKey(c);
	const isModelsRequest = new URL(c.req.url).pathname.endsWith('/models');

	let keyResult: ApiKeyResult | null = null;

	if (attempt === 1) { // 首次尝试
		keyResult = await getApiKeyForRequest(userApiKey, modelNameForKeyLookup);
		if (!keyResult && !isModelsRequest) {
			throw new Response(`No available API key for this request (${strategyName})`, { status: 503 });
		}
	} else if (userApiKey && await isTriggerKey(userApiKey)) { // 重试时，仅当用户提供的是触发密钥时才尝试密钥池
		const nextPoolKey = await getNextPoolKey();
		if (nextPoolKey) {
			keyResult = { key: nextPoolKey, source: 'pool' };
		} else if (!isModelsRequest) {
			throw new Response(`API key pool is exhausted (${strategyName})`, { status: 503 });
		}
	} else if (!isModelsRequest) { // 非触发密钥的重试，直接失败
		throw new Response(`API Key is invalid or request failed, no retry for non-trigger keys (${strategyName})`, { status: 503 });
	}

	return {
		key: keyResult?.key || null,
		source: keyResult?.source || null,
		gcpToken: null,
		gcpProject: null,
		maxRetries: keyResult?.source === 'pool' ? apiRetryLimit : 1 // 只有密钥池的密钥才允许多次重试
	};
};

/** 策略接口定义 */
interface RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails>;
	buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): Promise<URL>;
	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers;
	processRequestBody(ctx: StrategyContext): Promise<BodyInit | null | ReadableStream>;
	handleResponse?(response: Response, ctx: StrategyContext): Promise<Response>;
}

// --- Vertex AI 策略 ---
class VertexAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(_c: Context, _ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		const apiRetryLimit = await getApiRetryLimitFromCache();
		const auth = await getGcpAuth();
		if (!auth && attempt === 1) {
			throw new Response(`GCP authentication failed on the first attempt`, { status: 503 });
		}
		return {
			key: null,
			source: null,
			gcpToken: auth?.token || null,
			gcpProject: auth?.projectId || null,
			maxRetries: apiRetryLimit
		};
	}

	async buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): Promise<URL> {
		if (!authDetails.gcpProject) throw new Error("Vertex AI requires a GCP Project ID");
		const gcpDefaultLocation = await getGcpDefaultLocationFromCache();
		const host = gcpDefaultLocation === "global" ? "aiplatform.googleapis.com" : `${gcpDefaultLocation}-aiplatform.googleapis.com`;
		const baseUrl = `https://${host}/v1/projects/${authDetails.gcpProject}/locations/${gcpDefaultLocation}/publishers/google`; // 使用标准 Vertex API 路径
		const targetPath = ctx.path.startsWith('/v1/') ? ctx.path.slice(3) : ctx.path; // 移除 /v1/ 前缀
		const url = new URL(`${baseUrl}${targetPath}`);

		ctx.originalUrl.searchParams.forEach((val, key) => url.searchParams.set(key, val));
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers {
		if (!authDetails.gcpToken) throw new Error("Vertex AI requires a GCP Token");
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.set('Authorization', `Bearer ${authDetails.gcpToken}`);
		return headers;
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') return null;
		// Vertex AI 请求体通常无需修改，直接透传。如果需要特定修改，在此处添加。
		return ctx.originalBodyBuffer;
	}
}

// --- Gemini (OpenAI 兼容) 策略 ---
class GeminiOpenAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		const modelNameForKeyLookup = ctx.parsedBody?.model ?? null;
		return _getGeminiAuthenticationDetails(c, modelNameForKeyLookup, attempt, "Gemini OpenAI");
	}

	async buildTargetUrl(ctx: StrategyContext, _authDetails: AuthenticationDetails): Promise<URL> {
		const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
		const baseUrl = apiMappings['/gemini'];
		if (!baseUrl) throw new Response("Gemini base URL ('/gemini') not found in API mappings.", { status: 503 });

		let targetPath = ctx.path;
		// 转换 OpenAI 路径为 Gemini v1beta 路径
		if (['/chat/completions', '/embeddings'].includes(ctx.path)) {
			targetPath = `/v1beta${ctx.path.replace('/chat/completions', '/models/gemini-pro:streamGenerateContent')}`;
		} else if (ctx.path === '/models') {
			targetPath = '/v1beta/models';
		}

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
		if (authDetails.key) headers.set('x-goog-api-key', authDetails.key);
		return headers;
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') return null;
		// 如果需要从 OpenAI 格式转换为 Gemini 格式，在此处实现。
		// 此处为简化，假设请求体已兼容或直接透传。
		return ctx.originalBodyBuffer;
	}

	async handleResponse(response: Response, ctx: StrategyContext): Promise<Response> {
		// 如果需要将 Gemini 响应转换为 OpenAI 格式，在此处实现。
		// 此处为简化，直接返回原始响应。
		return response;
	}
}

// --- Gemini (原生) 策略 ---
class GeminiNativeStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		const match = ctx.path.match(/\/models\/([^:]+):/);
		const modelNameForKeyLookup = match?.[1] ?? null;
		return _getGeminiAuthenticationDetails(c, modelNameForKeyLookup, attempt, "Gemini Native");
	}

	async buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): Promise<URL> {
		if (!authDetails.key) throw new Response("Gemini Native strategy requires an API Key.", { status: 500 });
		const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
		const baseUrl = apiMappings['/gemini'];
		if (!baseUrl) throw new Response("Gemini base URL ('/gemini') not found in API mappings.", { status: 503 });

		const url = new URL(ctx.path, baseUrl);
		ctx.originalUrl.searchParams.forEach((val, key) => {
			if (key.toLowerCase() !== 'key') url.searchParams.set(key, val);
		});
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
		return ctx.originalBodyBuffer; // 原生接口直接透传
	}
}

// --- 通用代理策略 ---
class GenericProxyStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(): Promise<AuthenticationDetails> {
		return { key: null, source: null, gcpToken: null, gcpProject: null, maxRetries: 1 };
	}

	async buildTargetUrl(ctx: StrategyContext): Promise<URL> {
		const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
		if (!ctx.prefix || !apiMappings[ctx.prefix]) {
			throw new Response(`Proxy target for prefix '${ctx.prefix || '(null)'}' not configured.`, { status: 503 });
		}
		const baseUrl = apiMappings[ctx.prefix];
		const url = new URL(ctx.path, baseUrl);

		ctx.originalUrl.searchParams.forEach((val, key) => url.searchParams.set(key, val));
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext): Headers {
		return buildBaseProxyHeaders(ctx.originalRequest.headers);
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		return ctx.originalBodyBuffer;
	}
}

// === 策略选择器 ===

interface DetermineResult {
	type: RequestType;
	prefix: string | null;
	path: string;
	parsedBody?: any | null;
}

/**
 * 根据请求上下文判断请求类型，并选择合适的策略。
 * 这是路由逻辑的核心，它将一个请求映射到一个具体的处理策略。
 */
const determineRequestType = async (
	c: Context,
	originalBodyBuffer: ArrayBuffer | null
): Promise<DetermineResult> => {
	const req = c.req.raw;
	const url = new URL(req.url);
	const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
	const pathname = url.pathname;

	// 找到匹配的最长前缀
	const matchedPrefix = Object.keys(apiMappings)
		.filter(p => pathname.startsWith(p))
		.sort((a, b) => b.length - a.length)[0] || null;

	const prefix = matchedPrefix;
	const path = prefix ? pathname.slice(prefix.length) : pathname;

	if (!prefix) {
		return { type: RequestType.UNKNOWN, prefix: null, path };
	}

	// 检查是否为 OpenAI 兼容的 Gemini 请求 (需要检查模型)
	const isOpenAICompatiblePath = prefix === '/gemini' && !path.startsWith('/v1beta/');
	if (isOpenAICompatiblePath) {
		let parsedBody: any | null = null;
		if (originalBodyBuffer && req.method !== 'GET' && req.method !== 'HEAD') {
			try {
				parsedBody = JSON.parse(new TextDecoder().decode(originalBodyBuffer));
			} catch (e) { /* 解析失败则忽略，按非 Vertex 处理 */ }
		}

		const isVertex = await isVertexModel(parsedBody?.model);
		return {
			type: isVertex ? RequestType.VERTEX_AI : RequestType.GEMINI_OPENAI,
			prefix,
			path,
			parsedBody
		};
	} else if (prefix === '/gemini') {
		return { type: RequestType.GEMINI_NATIVE, prefix, path };
	} else {
		return { type: RequestType.GENERIC_PROXY, prefix, path };
	}
};

/** 根据类型获取策略实例 */
const getStrategy = (type: RequestType): RequestHandlerStrategy => {
	switch (type) {
		case RequestType.VERTEX_AI: return new VertexAIStrategy();
		case RequestType.GEMINI_OPENAI: return new GeminiOpenAIStrategy();
		case RequestType.GEMINI_NATIVE: return new GeminiNativeStrategy();
		case RequestType.GENERIC_PROXY: return new GenericProxyStrategy();
		default: throw new Error(`Unsupported request type: ${RequestType[type]}`);
	}
};

// === 主处理函数 ===
/**
 * 通用代理处理函数，是所有代理请求的入口。
 * 它协调了请求类型判断、策略执行和重试逻辑。
 */
export const handleGenericProxy = async (c: Context): Promise<Response> => {
	const req = c.req.raw;
	const url = new URL(req.url);

	// 1. 预读请求体，以供后续策略判断和处理，避免重复读取
	let originalBodyBuffer: ArrayBuffer | null = null;
	if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
		try {
			originalBodyBuffer = await req.clone().arrayBuffer();
		} catch (e) {
			console.error("Failed to read request body:", e);
			return new Response("Internal Server Error: Failed to process request body.", { status: 500 });
		}
	}

	// 2. 确定请求类型和策略
	const determinationResult = await determineRequestType(c, originalBodyBuffer);
	if (determinationResult.type === RequestType.UNKNOWN) {
		return new Response(`No proxy route configured for path: ${url.pathname}`, { status: 404 });
	}

	const strategy = getStrategy(determinationResult.type);

	// 3. 构建策略上下文
	const strategyContext: StrategyContext = {
		originalUrl: url,
		originalRequest: req,
		path: determinationResult.path,
		prefix: determinationResult.prefix,
		parsedBody: determinationResult.parsedBody,
		originalBodyBuffer
	};

	// 4. 执行带重试的请求处理循环
	let attempts = 0;
	let maxRetries = 1;
	let lastErrorResponse: Response | null = null;

	while (attempts < maxRetries) {
		attempts++;
		try {
			const authDetails = await strategy.getAuthenticationDetails(c, strategyContext, attempts);
			if (attempts === 1) maxRetries = authDetails.maxRetries; // 仅在第一次设置最大重试次数

			const targetUrl = await strategy.buildTargetUrl(strategyContext, authDetails);
			const targetHeaders = strategy.buildRequestHeaders(strategyContext, authDetails);
			const targetBody = await strategy.processRequestBody(strategyContext);

			const proxyResponse = await fetch(targetUrl.toString(), {
				method: req.method,
				headers: targetHeaders,
				body: targetBody,
			});

			if (proxyResponse.ok) {
				let finalResponse = proxyResponse;
				if (strategy.handleResponse) {
					finalResponse = await strategy.handleResponse(proxyResponse, strategyContext);
				}
				return finalResponse; // 成功，直接返回
			} else {
				console.warn(`Attempt ${attempts}/${maxRetries} failed for ${RequestType[determinationResult.type]}: ${proxyResponse.status}`);
				lastErrorResponse = proxyResponse.clone();
				await proxyResponse.arrayBuffer().catch(() => {}); // 消耗body以释放连接
				if (attempts >= maxRetries) {
					console.error(`Max retries (${maxRetries}) reached. Returning last error.`);
				}
			}
		} catch (error) {
			console.error(`Attempt ${attempts}/${maxRetries} caught an exception during processing:`, error);
			if (error instanceof Response) {
				lastErrorResponse = error; // 策略内部抛出 Response，作为最后错误
			} else {
				// 内部代码错误，通常不应重试
				return lastErrorResponse ?? new Response(`Internal Server Error: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
			}
		}
	}

	return lastErrorResponse ?? new Response("Request processing failed after maximum retries.", { status: 502 });
};