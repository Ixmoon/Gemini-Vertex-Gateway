import { Context } from "hono";
import { GoogleAuth } from "google-auth-library";

// 导入重构后的 kv 操作函数 (现在都从 Edge Cache 读取)
import {
	// openKv, // 不再直接需要，由 replacekeys 内部管理
	getApiKeyForRequest, // 核心逻辑，已改为 async
	isTriggerKey,		// 已改为 async
	getNextPoolKey,	  // 已改为 async
	isVertexModel,	   // 已改为 async
	ApiKeySource,		// 类型定义
	ApiKeyResult,		// 类型定义
	getApiRetryLimitFromCache, // [新增] 从缓存读取重试次数
	getGcpDefaultLocationFromCache, // [新增] 从缓存读取 GCP 位置
	isValidCred, // Import from replacekeys
} from "./replacekeys.ts";
// 导入 Edge Cache 相关函数
import {
	getConfigValue,
	getParsedGcpCredentials,
	setEdgeCacheValue, // [新增] 导入设置缓存的函数
	getEdgeCache, // [新增] 导入获取 Edge Cache 实例的函数
	CACHE_KEYS
} from "./cache.ts";

// === 类型定义 (保持不变) ===

// 请求处理类型枚举
enum RequestType {
	VERTEX_AI,
	GEMINI_OPENAI,
	GEMINI_NATIVE,
	GENERIC_PROXY,
	UNKNOWN
}

// 认证详情 (由策略返回)
interface AuthenticationDetails {
	key: string | null;			 // Gemini API Key
	source: ApiKeySource | null;
	gcpToken: string | null;		// GCP Access Token
	gcpProject: string | null;	  // GCP Project ID
	maxRetries: number;			 // 最大重试次数 (由策略决定)
}

// 传递给策略的上下文信息
interface StrategyContext {
	originalUrl: URL;
	originalRequest: Request;   // 原始请求对象，包含 headers 和 body stream
	path: string;			   // 不含 prefix 的路径
	prefix: string | null;	  // API 前缀 (如 /gemini)
	parsedBody?: any | null;	// 预解析的 Body (由 determineRequestType 提供)
	originalBodyBuffer?: ArrayBuffer | null; // 预读取的原始请求体缓冲区
}

// === 全局状态 (保持不变) ===

/** 构建基础代理 Headers (过滤掉 host) */
const buildBaseProxyHeaders = (originalHeaders: Headers): Headers => {
	const headers = new Headers();
	originalHeaders.forEach((val, key) => {
		if (key.toLowerCase() !== 'host') {
			headers.set(key, val);
		}
	});
	return headers;
};

// === 基础工具函数 (保持不变) ===

const getApiKey = (c: Context): string | null => {
	const { req } = c;
	const url = new URL(req.url);
	return url.searchParams.get('key') ||
		req.header("Authorization")?.replace(/^bearer\s+/i, '') ||
		req.header("x-goog-api-key") ||
		null;
};

// === GCP 凭证处理 ===

// [重构] 按需获取 GCP 认证 Token (优先从 Edge Cache 读取 Token，否则生成并缓存)
// isValidCred is now imported from replacekeys.ts
const getGcpAuth = async (): Promise<{ token: string; projectId: string } | null> => {
	// 1. 从 Edge Cache 读取并解析凭证
	const creds = await getParsedGcpCredentials(); // 使用 cache.ts 的新函数
	if (!creds || creds.length === 0) {
		// console.warn("getGcpAuth: No valid GCP credentials found in Edge Cache.");
		return null; // 没有可用凭证
	}

	// 2. 随机选择一个凭证索引
	const selectedIndex = Math.floor(Math.random() * creds.length);
	const selectedCred = creds[selectedIndex];

	// 3. 校验选择的凭证
	if (!isValidCred(selectedCred)) {
		console.error(`getGcpAuth: Randomly selected credential at index ${selectedIndex} is invalid.`);
		return null; // 选择的凭证无效
	}

	// 4. 构造 Token 缓存键 (使用 client_email 保证唯一性)
	const tokenCacheKey = `${CACHE_KEYS.GCP_AUTH_TOKEN_PREFIX}${selectedCred.client_email}`;
	const projectId = selectedCred.project_id; // 提前获取 Project ID

	// 5. 尝试从 Edge Cache 直接获取 Token (避免 KV 回退)
	try {
		const cache = await getEdgeCache();
		const cacheRequest = new Request(`http://cache.internal/${encodeURIComponent(tokenCacheKey)}`);
		const cachedResponse = await cache.match(cacheRequest);

		if (cachedResponse) {
			const contentType = cachedResponse.headers.get('content-type');
			if (contentType && contentType.includes('application/json')) {
				const text = await cachedResponse.text();
				try {
					const data = JSON.parse(text || 'null'); // data is the token string or null
					if (typeof data === 'string' && data.length > 0) {
						// //console.log(`[getGcpAuth] Cache Hit for token: ${tokenCacheKey}`);
						return { token: data, projectId };
					} else {
						// //console.log(`[getGcpAuth] Cache Hit but invalid token data for ${tokenCacheKey}.`);
					}
				} catch (parseError) {
					console.warn(`[getGcpAuth] Cache Hit but failed to parse JSON for ${tokenCacheKey}: ${parseError}.`);
				}
			} else {
				console.warn(`[getGcpAuth] Cache Hit but invalid Content-Type for ${tokenCacheKey}: ${contentType}.`);
			}
		} else {
			// //console.log(`[getGcpAuth] Cache Miss for token: ${tokenCacheKey}. Fetching new token...`);
		}
	} catch (cacheError) {
		console.error(`[getGcpAuth] Error directly accessing Edge Cache for token ${tokenCacheKey}:`, cacheError);
		// 缓存读取失败，继续尝试获取新 Token
	}

	// 6. 缓存未命中或读取失败，获取新 Token
	try {
		const auth = new GoogleAuth({
			credentials: selectedCred,
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
		});

		const newToken = await auth.getAccessToken();

		if (!newToken) {
			console.error(`getGcpAuth: Failed to get new token using credential index ${selectedIndex} (Project: ${projectId}). GoogleAuth returned null.`);
			return null; // 获取 Token 失败
		}

		// 7. 将新 Token 存入 Edge Cache (设置 TTL，例如 50 分钟)
		const tokenTtlSeconds = 50 * 60;
		setEdgeCacheValue(tokenCacheKey, newToken, tokenTtlSeconds).catch(cacheSetError => {
			console.error(`[getGcpAuth] Error setting token to cache for ${tokenCacheKey}:`, cacheSetError);
		});
		// //console.log(`[getGcpAuth] Fetched and cached new token for ${tokenCacheKey}`);

		// 8. 返回新 Token 和 Project ID
		return { token: newToken, projectId };

	} catch (error) {
		// 统一处理所有获取 Token 过程中的错误
		console.error(`getGcpAuth: Error during token acquisition using credential index ${selectedIndex} (Project: ${projectId}):`, error);
		return null; // 发生任何错误都返回 null，让外部重试机制处理
	}
};


// === 请求处理策略接口与实现 ===

/** [内部][重构] Gemini 策略获取认证详情的公共逻辑 */
const _getGeminiAuthenticationDetails = async (
	c: Context,
	modelNameForKeyLookup: string | null,
	attempt: number,
	strategyName: string // 用于日志/错误信息
): Promise<AuthenticationDetails> => {
	// [修改] 从 Edge Cache 读取重试次数
	const apiRetryLimit = await getApiRetryLimitFromCache(); // 使用 FromCache 版本
	const userApiKey = getApiKey(c);

	let keyResult: ApiKeyResult | null = null;
	const url = new URL(c.req.url);
	const isModelsRequest = url.pathname.endsWith('/models');

	if (attempt === 1) {
		keyResult = await getApiKeyForRequest(userApiKey, modelNameForKeyLookup); // await
		if (!keyResult && !isModelsRequest) {
			throw new Response(`无可用API密钥 (${strategyName})`, { status: 503 });
		}
	} else if (userApiKey && await isTriggerKey(userApiKey)) { // await isTriggerKey
		// 只有触发键才在重试时尝试 Pool
		const nextPoolKey = await getNextPoolKey(); // await
		if (nextPoolKey) {
			keyResult = { key: nextPoolKey, source: 'pool' };
		} else if (!isModelsRequest) {
			throw new Response(`池密钥已耗尽 (${strategyName})`, { status: 503 });
		}
	} else if (!isModelsRequest) {
		// 如果不是触发键，且首次尝试失败 (非 pool key)，则不重试
		if (attempt > 1) {
			throw new Response(`API Key 无效或请求失败，不重试 (${strategyName})`, { status: 503 });
		}
	}

	return {
		key: keyResult?.key || null,
		source: keyResult?.source || null,
		gcpToken: null,
		gcpProject: null,
		maxRetries: keyResult?.source === 'pool' ? apiRetryLimit : 1
	};
};

// 策略接口 (保持不变)
interface RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails>;
	buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): URL | Promise<URL>;
	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers;
	processRequestBody(ctx: StrategyContext): Promise<BodyInit | null | ReadableStream>;
	handleResponse?(response: Response, ctx: StrategyContext): Promise<Response>;
}

// --- Vertex AI 策略 ---
class VertexAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(_c: Context, _ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		// 从 Edge Cache 读取 (await)
		// [修改] 从 Edge Cache 读取重试次数
		const apiRetryLimit = await getApiRetryLimitFromCache(); // 使用 FromCache 版本

		// 调用重构后的 getGcpAuth (它内部处理凭证获取和 Token 请求)
		const auth = await getGcpAuth(); // await

		if (!auth && attempt === 1) {
			throw new Response(`首次 GCP 凭证认证失败`, { status: 503 });
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
		if (!authDetails.gcpProject) {
			throw new Error("Vertex AI 需要 GCP Project ID");
		}
		// [修改] 从 Edge Cache 读取 GCP 位置
		const gcpDefaultLocation = await getGcpDefaultLocationFromCache(); // 使用 FromCache 版本
		const host = gcpDefaultLocation === "global"
			? "aiplatform.googleapis.com"
			: `${gcpDefaultLocation}-aiplatform.googleapis.com`;
		const baseUrl = `https://${host}/v1beta1/projects/${authDetails.gcpProject}/locations/${gcpDefaultLocation}/endpoints/openapi`;
		const targetPath = ctx.path.startsWith('/v1/') ? ctx.path.slice(3) : ctx.path;
		const url = new URL(`${baseUrl}${targetPath}`);

		ctx.originalUrl.searchParams.forEach((val, key) => {
			if (key.toLowerCase() !== 'key') {
				url.searchParams.set(key, val);
			}
		});
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers {
		if (!authDetails.gcpToken) {
			throw new Error("Vertex AI 需要 GCP Token");
		}
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.set('Authorization', `Bearer ${authDetails.gcpToken}`);
		return headers;
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		// Body 处理逻辑保持不变
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}
		let bodyToModify: any;
		if (ctx.parsedBody !== undefined && ctx.parsedBody !== null) {
			bodyToModify = ctx.parsedBody;
		} else if (ctx.originalBodyBuffer) {
			try {
				bodyToModify = JSON.parse(new TextDecoder().decode(ctx.originalBodyBuffer));
			} catch (e) {
				console.error("Vertex: Failed to parse original request body from buffer:", e);
				throw new Response("Failed to parse request body for Vertex AI", { status: 400 });
			}
		} else {
			console.warn("Vertex: No body or parsed body found for non-GET/HEAD request.");
			return null;
		}
		if (typeof bodyToModify !== 'object' || bodyToModify === null) {
			console.warn("Vertex: Parsed body is not an object, cannot apply modifications.");
			try {
				return JSON.stringify(bodyToModify);
			} catch (stringifyError) {
				console.error("Vertex: Failed to stringify non-object body:", stringifyError);
				throw new Response("Failed to process non-object request body", { status: 500 });
			}
		}
		try {
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
			const message = e instanceof Error ? e.message : "Failed to modify Vertex AI request body";
			throw new Response(message, { status: 500 });
		}
	}
}

// --- Gemini (OpenAI 兼容) 策略 ---
class GeminiOpenAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		let modelNameForKeyLookup: string | null = null;
		if (ctx.parsedBody && typeof ctx.parsedBody === 'object' && ctx.parsedBody !== null) {
			modelNameForKeyLookup = ctx.parsedBody.model ?? null;
		}
		// 调用公共辅助函数 (内部已全部使用 await)
		return _getGeminiAuthenticationDetails(c, modelNameForKeyLookup, attempt, "Gemini OpenAI");
	}

	async buildTargetUrl(ctx: StrategyContext, _authDetails: AuthenticationDetails): Promise<URL> {
		// 从 Edge Cache 读取 API 映射 (使用缓存优先)
		const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {}; // await
		const baseUrl = apiMappings['/gemini']; // 假设 '/gemini' 是映射中的键
		if (!baseUrl) {
			throw new Response("Gemini base URL ('/gemini') not found in API mappings.", { status: 503 });
		}
		// 路径转换逻辑保持不变
		let targetPath = ctx.path;
		if (['/chat/completions', '/embeddings', '/models'].includes(ctx.path)) {
			targetPath = '/v1beta/openai' + ctx.path; // 修正路径前缀
		} else if (ctx.path.startsWith('/v1/')) {
			targetPath = '/v1beta/openai' + ctx.path.slice(3); // 修正路径前缀
		} else {
			// 如果不是已知路径，可能需要警告或按原样传递？
			console.warn(`GeminiOpenAIStrategy: Unrecognized path "${ctx.path}", proxying as is.`);
		}

		const url = new URL(targetPath, baseUrl); // 使用 URL 构造函数拼接

		// 复制查询参数 (排除 'key')
		ctx.originalUrl.searchParams.forEach((val, key) => {
			if (key.toLowerCase() !== 'key') {
				url.searchParams.set(key, val);
			}
		});
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers {
		// Header 构建逻辑保持不变
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.delete('x-goog-api-key');
		headers.delete('x-api-key');
		if (authDetails.key) {
			headers.set('Authorization', `Bearer ${authDetails.key}`);
		}
		return headers;
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		// Body 处理逻辑保持不变
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}
		if (ctx.parsedBody !== undefined && ctx.parsedBody !== null) {
			try {
				return JSON.stringify(ctx.parsedBody);
			} catch (e) {
				console.error("Gemini OpenAI: Failed to stringify pre-parsed body:", e);
				throw new Response("Failed to process pre-parsed request body", { status: 500 });
			}
		} else if (ctx.originalBodyBuffer) {
			return new TextDecoder().decode(ctx.originalBodyBuffer);
		} else {
			console.warn("Gemini OpenAI: No body or parsed body found for non-GET/HEAD request.");
			return null;
		}
	}

	async handleResponse(response: Response, ctx: StrategyContext): Promise<Response> {
		// 响应处理逻辑保持不变
		const contentType = response.headers.get("content-type");
		if (!ctx.path.endsWith('/models') || !contentType?.includes("application/json")) {
			return response;
		}
		const bodyText = await response.text();
		try {
			const body = JSON.parse(bodyText);
			let modified = false;
			if (body?.data?.length) {
				body.data.forEach((model: any) => {
					if (model?.id?.startsWith('models/')) {
						model.id = model.id.slice(7);
						modified = true;
					}
				});
			}
			if (modified) {
				const newBody = JSON.stringify(body);
				const newHeaders = new Headers(response.headers);
				newHeaders.delete('Content-Encoding');
				newHeaders.set('Content-Length', String(new TextEncoder().encode(newBody).byteLength));
				return new Response(newBody, {
					status: response.status,
					statusText: response.statusText,
					headers: newHeaders
				});
			} else {
				return new Response(bodyText, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers
				});
			}
		} catch (e) {
			console.error("Gemini models fix error:", e);
			return new Response(bodyText, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			});
		}
	}
}

// --- Gemini (原生) 策略 ---
class GeminiNativeStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		let modelNameForKeyLookup: string | null = null;
		const match = ctx.path.match(/\/models\/([^:]+):/);
		if (match && match[1]) {
			modelNameForKeyLookup = match[1];
		}
		// 调用公共辅助函数 (内部已全部使用 await)
		return _getGeminiAuthenticationDetails(c, modelNameForKeyLookup, attempt, "Gemini Native");
	}

	async buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): Promise<URL> {
		if (!authDetails.key) {
			// 这个检查理论上在 _getGeminiAuthenticationDetails 中已处理，但保留以防万一
			throw new Response("Gemini Native strategy requires an API Key, but none was provided or found.", { status: 500 });
		}
		// 从 Edge Cache 读取 API 映射 (使用缓存优先)
		const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {}; // await
		const baseUrl = apiMappings['/gemini']; // 假设 '/gemini' 是映射中的键
		if (!baseUrl) {
			throw new Response("Gemini base URL ('/gemini') not found in API mappings.", { status: 503 });
		}

		const targetPath = ctx.path; // 原生路径直接使用
		const url = new URL(targetPath, baseUrl); // 使用 URL 构造函数拼接

		// 复制查询参数 (排除 'key')
		ctx.originalUrl.searchParams.forEach((val, key) => {
			if (key.toLowerCase() !== 'key') {
				url.searchParams.set(key, val);
			}
		});
		// 将认证密钥添加到查询参数
		url.searchParams.set('key', authDetails.key);
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, _authDetails: AuthenticationDetails): Headers {
		// Header 构建逻辑保持不变
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.delete('x-goog-api-key');
		return headers;
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		// Body 处理逻辑保持不变
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}
		if (ctx.parsedBody !== undefined && ctx.parsedBody !== null) {
			try {
				return JSON.stringify(ctx.parsedBody);
			} catch (e) {
				console.error("Gemini Native: Failed to stringify pre-parsed body:", e);
				throw new Response("Failed to process pre-parsed request body", { status: 500 });
			}
		} else if (ctx.originalBodyBuffer) {
			return new TextDecoder().decode(ctx.originalBodyBuffer);
		} else {
			console.warn("Gemini Native: No body or parsed body found for non-GET/HEAD request.");
			return null;
		}
	}
}

// --- 通用代理策略 ---
class GenericProxyStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(_c: Context, _ctx: StrategyContext, _attempt: number): Promise<AuthenticationDetails> {
		// 保持不变
		return {
			key: null,
			source: null,
			gcpToken: null,
			gcpProject: null,
			maxRetries: 1
		};
	}

	async buildTargetUrl(ctx: StrategyContext, _authDetails: AuthenticationDetails): Promise<URL> {
		// 从 Edge Cache 读取 API 映射 (使用缓存优先)
		const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {}; // await
		if (!ctx.prefix || !apiMappings[ctx.prefix]) {
			// 确保 ctx.prefix 存在且在映射中
			throw new Response(`Proxy target for prefix '${ctx.prefix || '(null)'}' not configured in API mappings.`, { status: 503 });
		}
		const baseUrl = apiMappings[ctx.prefix];
		const targetPath = ctx.path; // 路径保持不变

		// 使用 URL 构造函数安全地拼接 Base URL 和路径
		let fullTargetPath: string;
		try {
			// 如果 baseUrl 包含路径，需要正确处理
			const base = new URL(baseUrl);
			// 如果 targetPath 是绝对路径（以 / 开头），它会替换 base 的路径
			// 如果 targetPath 是相对路径，它会追加到 base 的路径
			fullTargetPath = new URL(targetPath, base).toString();
		} catch (e) {
			throw new Response(`Invalid base URL configured for prefix '${ctx.prefix}': ${baseUrl}`, { status: 500 });
		}

		const url = new URL(fullTargetPath);


		// 复制查询参数 (排除 'key')
		ctx.originalUrl.searchParams.forEach((val, key) => {
			// 对于通用代理，是否排除 'key' 取决于具体需求，这里保持原逻辑
			if (key.toLowerCase() !== 'key') {
				url.searchParams.set(key, val);
			}
		});
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, _authDetails: AuthenticationDetails): Headers {
		// Header 构建逻辑保持不变
		return buildBaseProxyHeaders(ctx.originalRequest.headers);
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		// Body 处理逻辑保持不变
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}
		if (ctx.originalBodyBuffer) {
			return ctx.originalBodyBuffer;
		} else {
			console.warn("Generic Proxy: No body buffer found for non-GET/HEAD request.");
			return null;
		}
	}
}

// === 策略选择器 ===

// 定义 determineRequestType 的返回类型 (保持不变)
interface DetermineResult {
	type: RequestType;
	prefix: string | null;
	path: string;
	parsedBody?: any | null;
}

// [重构] 根据请求上下文判断类型 (使用 await)
const determineRequestType = async (
	c: Context,
	originalBodyBuffer: ArrayBuffer | null // 传入预读的 body buffer
): Promise<DetermineResult> => {
	const req = c.req.raw;
	const url = new URL(req.url);
	// 从 Edge Cache 读取 API 映射 (使用缓存优先)
	// const apiMappings = await getApiMappings(); // 旧：直接读 KV
	const apiMappings = await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {}; // 新：读缓存，若无则 KV 回退，保证返回对象
	const pathname = url.pathname;

	// 找到匹配的最长前缀
	let matchedPrefix: string | null = null;
	for (const p of Object.keys(apiMappings)) {
		if (pathname.startsWith(p)) {
			if (!matchedPrefix || p.length > matchedPrefix.length) {
				matchedPrefix = p;
			}
		}
	}

	const prefix = matchedPrefix;
	const path = prefix ? pathname.slice(prefix.length) : pathname; // 移除前缀得到相对路径

	if (!prefix) {
		// //console.log(`determineRequestType: No matching prefix found for path "${pathname}"`);
		return { type: RequestType.UNKNOWN, prefix: null, path };
	}

	// //console.log(`determineRequestType: Matched prefix "${prefix}", path is "${path}"`);

	const isGeminiPrefix = prefix === '/gemini';
	// OpenAI 兼容路径通常不包含 /v1beta/
	const isOpenAICompatiblePath = isGeminiPrefix && !path.startsWith('/v1beta/');

	if (isOpenAICompatiblePath) {
		// 对于 OpenAI 兼容路径，需要检查 body 中的 model 来区分 Vertex 和 Gemini
		let model: string | null = null;
		let parsedBody: any | null = null;
		// 只有在需要检查 model 时才解析 body
		if (originalBodyBuffer && req.method !== 'GET' && req.method !== 'HEAD') {
			try {
				const bodyText = new TextDecoder().decode(originalBodyBuffer);
				parsedBody = JSON.parse(bodyText);
				model = parsedBody?.model ?? null;
			} catch (e) {
				console.warn("determineRequestType: Failed to parse body for model check:", e);
				// 解析失败，无法判断是否 Vertex，按 OpenAI 处理
				parsedBody = null; // 标记解析失败
			}
		} else {
			// //console.log("determineRequestType: No body or not applicable method for model check.");
		}

		// 使用 await 调用 isVertexModel (从缓存读取)
		const isVertex = await isVertexModel(model); // await
		// //console.log(`determineRequestType: isVertexModel check result: ${isVertex}`);
		return {
			type: isVertex ? RequestType.VERTEX_AI : RequestType.GEMINI_OPENAI,
			prefix,
			path,
			parsedBody // 将解析结果传递下去，避免重复解析
		};
	} else if (isGeminiPrefix) {
		// 如果是 /gemini 前缀但不是 OpenAI 兼容路径，则认为是原生 Gemini
		// //console.log("determineRequestType: Identified as Gemini Native.");
		return { type: RequestType.GEMINI_NATIVE, prefix, path };
	} else {
		// 其他所有匹配的前缀都按通用代理处理
		return { type: RequestType.GENERIC_PROXY, prefix, path };
	}
};

// 根据类型获取策略实例 (保持不变)
const getStrategy = (type: RequestType): RequestHandlerStrategy => {
	switch (type) {
		case RequestType.VERTEX_AI: return new VertexAIStrategy();
		case RequestType.GEMINI_OPENAI: return new GeminiOpenAIStrategy();
		case RequestType.GEMINI_NATIVE: return new GeminiNativeStrategy();
		case RequestType.GENERIC_PROXY: return new GenericProxyStrategy();
		default: throw new Error(`不支持的请求类型: ${type}`);
	}
};

// === 主处理函数 (使用重构后的异步函数) ===
export const handleGenericProxy = async (c: Context): Promise<Response> => {
	const req = c.req.raw; // 获取原始 Request 对象
	const url = new URL(req.url);

	// 1. 预读请求体 (如果存在)
	// 对于需要检查 body 内容以确定类型的请求 (如 OpenAI 兼容路径)，预读是必要的
	// 对于其他请求，如果策略需要 body，也会用到这个 buffer
	let originalBodyBuffer: ArrayBuffer | null = null;
	if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
		try {
			// 克隆请求以读取 body，原始请求的 body 仍可用于后续 fetch
			const clonedReqForBody = req.clone();
			originalBodyBuffer = await clonedReqForBody.arrayBuffer();
		} catch (e) {
			console.error("Failed to read original request body into ArrayBuffer:", e);
			return new Response("Internal Server Error: Failed to process request body.", { status: 500 });
		}
	}

	// 2. 确定请求类型和策略 (determineRequestType 现在是 async)
	let determinationResult: DetermineResult;
	try {
		determinationResult = await determineRequestType(c, originalBodyBuffer); // await
	} catch (error) {
		console.error("Error during request type determination:", error);
		return new Response("Internal Server Error during request routing.", { status: 500 });
	}

	const { type, prefix, path, parsedBody } = determinationResult;

	if (type === RequestType.UNKNOWN) {
		return new Response(`No proxy route configured for path: ${url.pathname}`, { status: 404 });
	}

	const strategy = getStrategy(type);

	// 3. 构建策略上下文
	const strategyContext: StrategyContext = {
		originalUrl: url,
		originalRequest: req, // 原始请求对象
		path,
		prefix,
		parsedBody, // 传递预解析的 body (如果 determineRequestType 解析了)
		originalBodyBuffer // 传递预读的 body buffer
	};

	// 4. 执行请求处理循环 (重试逻辑)
	let attempts = 0;
	let maxRetries = 1; // 默认至少尝试一次
	let lastErrorResponse: Response | null = null;

	while (attempts < maxRetries) {
		attempts++;
		try {
			// a. 获取认证详情 (async)
			const authDetails = await strategy.getAuthenticationDetails(c, strategyContext, attempts); // await
			if (attempts === 1) {
				// 仅在第一次尝试时设置最大重试次数
				maxRetries = authDetails.maxRetries;
			}

			// b. 构建目标 URL (async)
			const targetUrl = await strategy.buildTargetUrl(strategyContext, authDetails); // await

			// c. 构建请求头 (sync)
			const targetHeaders = strategy.buildRequestHeaders(strategyContext, authDetails);

			// d. 处理请求体 (async) - 使用 strategyContext 中的 buffer 或 parsedBody
			const targetBody = await strategy.processRequestBody(strategyContext); // await

			// e. 发送代理请求
			// //console.log(`Attempt ${attempts}/${maxRetries}: Proxying to ${targetUrl.toString()} for ${RequestType[type]}`);
			const proxyResponse = await fetch(targetUrl.toString(), { // 使用 toString() 获取完整 URL
				method: req.method,
				headers: targetHeaders,
				body: targetBody, // 使用策略处理后的 body
				// Deno Deploy 不支持自定义 redirect，让 fetch 默认处理
				// redirect: 'manual' // 如果需要手动处理重定向
			});

			// f. 处理响应
			if (proxyResponse.ok) {
				// 成功响应
				let finalResponse = proxyResponse;
				// 如果策略需要处理响应 (例如修改 body)
				if (strategy.handleResponse) {
					finalResponse = await strategy.handleResponse(proxyResponse, strategyContext); // await
				}
				// //console.log(`Attempt ${attempts}/${maxRetries}: Success for ${RequestType[type]} ${targetUrl}`);
				return finalResponse; // 返回成功响应
			} else {
				// 失败响应
				console.warn(`Attempt ${attempts}/${maxRetries} failed for ${RequestType[type]} ${targetUrl}: ${proxyResponse.status} ${proxyResponse.statusText}`);
				// 克隆错误响应以备重试后返回
				lastErrorResponse = proxyResponse.clone();
				// 消耗掉原始失败响应的 body，以便连接可以被重用（如果可能）
				await proxyResponse.arrayBuffer().catch(() => {});
				// 如果还有重试机会，循环将继续
				if (attempts >= maxRetries) {
					console.error(`Max retries (${maxRetries}) reached for ${RequestType[type]} ${targetUrl}. Returning last error.`);
				}
			}

		} catch (error) {
			// 处理策略执行或 fetch 过程中的异常
			console.error(`Attempt ${attempts}/${maxRetries} caught error during ${RequestType[type]} processing:`, error);
			if (error instanceof Response) {
				// 如果策略内部抛出了 Response 对象 (例如认证失败)
				lastErrorResponse = error.clone();
				await error.arrayBuffer().catch(() => {}); // 消耗 body
				if (attempts >= maxRetries) {
					console.error(`Max retries (${maxRetries}) reached after strategy threw a Response for ${RequestType[type]}. Returning last error.`);
				}
			} else {
				// 对于非 Response 错误 (代码错误、网络问题等)，通常不应重试
				// 记录详细错误并返回 500
				console.error("Non-Response error details:", error instanceof Error ? error.stack : error);
				// 即使发生内部错误，也尝试返回上次捕获的 HTTP 错误（如果有的话），否则返回通用 500
				return lastErrorResponse ?? new Response(`Internal Server Error during request processing: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
			}
		}
	} // end while loop

	// 5. 如果循环结束仍未成功，返回最后一次捕获的错误响应
	if (lastErrorResponse) {
		return lastErrorResponse;
	}

	// 如果循环因某种原因结束且没有 lastErrorResponse（理论上不应发生），返回通用错误
	return new Response("Request processing failed after maximum retries.", { status: 502 }); // 502 Bad Gateway 可能更合适
};