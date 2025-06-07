import { Context } from "hono";
import { GoogleAuth } from "google-auth-library";

// 导入 kv 操作函数、类型和常量
import {
	openKv, // KV 实例操作
	getApiKeyForRequest, // 获取请求的 API Key (核心逻辑)
	isTriggerKey, // 检查是否为触发 Key
	getNextPoolKey, // 获取下一个密钥池 Key
	isVertexModel, // 检查是否为 Vertex 模型
	ApiKeySource, // Key 来源类型
	ApiKeyResult, // API Key 结果类型
	GCP_CREDENTIAL_ATOMIC_INDEX_KEY, // GCP 凭证原子计数器 Key
	parseCreds, // 需要解析凭证以获取 Project ID
	GcpCredentials, // 需要凭证类型
} from "./replacekeys.ts";
import { globalCache, CACHE_KEYS } from "./cache.ts";

// Define GcpTokenCacheEntry and TTL locally as they were removed from cache.ts
const GCP_TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
interface GcpTokenCacheEntry {
	token: string;
	projectId: string;
}

// === 类型定义 ===

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

// === 全局状态 ===

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

// === 基础工具函数 ===

const getApiKey = (c: Context): string | null => {
	const { req } = c;
	const url = new URL(req.url);
	return url.searchParams.get('key') ||
		req.header("Authorization")?.replace(/^bearer\s+/i, '') ||
		req.header("x-goog-api-key") ||
		null;
};

// === GCP 凭证处理 ===

const isValidCred = (cred: any): cred is GcpCredentials =>
	cred?.type &&
	cred?.project_id &&
	cred?.private_key_id &&
	cred?.private_key &&
	cred?.client_email;

/** [内部][重构] 尝试获取第一个 GCP 凭证的 Token (优先读 KV 缓存, 1 分钟 TTL) - 从缓存读取 Auth 和 Creds */
const _tryGetFirstGcpToken = async (): Promise<{ token: string; projectId: string } | null> => {
	// 从缓存获取 Auth 实例和凭证字符串
	const auths = globalCache.get<GoogleAuth[]>(CACHE_KEYS.GCP_AUTH_INSTANCES) || [];
	const gcpCredsString = globalCache.get<string | null>(CACHE_KEYS.GCP_CREDENTIALS_STRING);
	const creds = gcpCredsString ? parseCreds(gcpCredsString) : [];

	if (!auths.length || !creds.length) {
		console.warn("_tryGetFirstGcpToken: No GCP Auth instances or credentials found in global cache.");
		return null;
	}

	const kv = await openKv();
	const cacheKey = ["gcp_token_cache", 0]; // 缓存键固定为索引 0
	const cacheTTL = 5 * 60 * 1000; // 5 分钟 (毫秒)

	try {
		// 1. 尝试从 KV 缓存读取
		const cachedEntry = await kv.get<{ token: string; projectId: string }>(cacheKey);
		if (cachedEntry.value) {
			//// console.log("Fallback: Cache hit for index 0");
			return cachedEntry.value;
		}

		// 2. 缓存未命中或过期，获取新 Token
		//// console.log("Fallback: Cache miss/expired for index 0. Fetching new token.");
		const newToken = await auths[0].getAccessToken();
		if (newToken) {
			const projectId = creds[0].project_id; // 使用解析出的 creds 获取 projectId
			const tokenData = { token: newToken, projectId: projectId };
			// 3. 存入 KV 缓存 (异步，不阻塞返回)
			kv.set(cacheKey, tokenData, { expireIn: cacheTTL }).catch(e => {
				console.error("Fallback: Failed to set KV cache for index 0:", e);
			});
			return tokenData;
		} else {
			console.error("Fallback: Failed to get new token for index 0 (returned null).");
			return null;
		}
	} catch (e) {
		console.error("Fallback: Error during token fetch/cache for index 0:", e);
		return null; // 发生错误，返回 null
	}
};


// [重构] 使用全局缓存和原子计数器获取 GCP 认证信息 (优先读 KV Token 缓存, 1 分钟 TTL)
const getGcpAuth = async (): Promise<{ token: string; projectId: string } | null> => {
	// 1. 从全局缓存获取 Auth 实例
	const auths = globalCache.get<GoogleAuth[]>(CACHE_KEYS.GCP_AUTH_INSTANCES) || [];
	if (!auths || auths.length === 0) {
		console.warn("getGcpAuth: No GCP Auth instances found in global cache.");
		return null; // 没有可用凭证
	}

	// 2. 从全局缓存获取凭证字符串以解析 Project ID
	const gcpCredsString = globalCache.get<string | null>(CACHE_KEYS.GCP_CREDENTIALS_STRING);
	const creds = gcpCredsString ? parseCreds(gcpCredsString) : [];
	if (!creds || creds.length === 0) {
		// 这通常不应该发生，因为 Auth 实例是基于凭证创建的
		console.warn("getGcpAuth: No GCP credentials found in global cache after parsing, despite having auth instances.");
		// 即使没有 creds 来获取 project ID，仍然尝试获取 token 并回退
	}


	let calculatedIndex = -1; // 用于错误日志和回退

	try {
		// 2. 计算凭证索引 (使用 KV 原子计数器)
		const kv = await openKv(); // KV 仍然需要用于原子计数器
		const atomicIncRes = await kv.atomic().sum(GCP_CREDENTIAL_ATOMIC_INDEX_KEY, 1n).commit();
		if (!atomicIncRes.ok) throw new Error("KV atomic increment failed");

		const currentCountEntry = await kv.get<Deno.KvU64>(GCP_CREDENTIAL_ATOMIC_INDEX_KEY);
		if (currentCountEntry.value === null) throw new Error("KV get count failed");

		const count = currentCountEntry.value.value;
		calculatedIndex = Number(count % BigInt(auths.length));
		const memoryCacheKey = "gcp_token_" + calculatedIndex; // 使用固定的字符串前缀

		// 3. 尝试从内存缓存读取
		const cachedEntry = globalCache.get<GcpTokenCacheEntry>(memoryCacheKey);
		if (cachedEntry) {
			// console.log(`Memory cache hit for index ${calculatedIndex}`);
			return cachedEntry; // MemoryCache 内部处理了过期
		}

		// 4. 内存缓存未命中，获取新 Token
		// console.log(`Memory cache miss for index ${calculatedIndex}. Fetching new token.`);
		const newToken = await auths[calculatedIndex].getAccessToken();
		if (!newToken) {
			console.error(`GCP auth returned null token for atomic index ${calculatedIndex}.`);
			throw new Error("GCP returned null token"); // 触发回退
		}

		// 5. 成功获取，存入内存缓存并返回
		// 从解析的 creds 获取 projectId
		if (calculatedIndex < 0 || calculatedIndex >= creds.length) {
			console.error(`getGcpAuth: Calculated index ${calculatedIndex} is out of bounds for parsed credentials (length ${creds.length}) when creating token data.`);
			throw new Error("Credential index out of bounds"); // 触发回退
		}
		const projectId = creds[calculatedIndex].project_id;
		const tokenData: GcpTokenCacheEntry = { token: newToken, projectId: projectId };

		// 存入内存缓存 (使用 cache.ts 中定义的 TTL)
		globalCache.set(memoryCacheKey, tokenData, GCP_TOKEN_CACHE_TTL);
		// console.log(`Stored new token for index ${calculatedIndex} in memory cache.`);
		return tokenData;

	} catch (error) {
		// 统一处理所有错误 (KV 操作、GCP Auth)
		if (calculatedIndex !== -1) {
			console.error(`GCP auth/cache failed for atomic index ${calculatedIndex}:`, error);
		} else {
			console.error("Error during KV operation/index calculation in getGcpAuth:", error);
		}

		// 6. 执行回退逻辑 (使用缓存的 creds 和 auths)
		console.warn("Falling back to first GCP credential (index 0).");
		// 回退逻辑现在优先检查索引 0 的缓存
		// 回退逻辑不再需要传递参数
		return await _tryGetFirstGcpToken();
	}
};

// === 请求处理策略接口与实现 ===

/** [内部] Gemini 策略获取认证详情的公共逻辑 */
const _getGeminiAuthenticationDetails = async (
	c: Context,
	modelNameForKeyLookup: string | null,
	attempt: number,
	strategyName: string // 用于日志/错误信息
): Promise<AuthenticationDetails> => {
	// 从缓存读取
	const apiRetryLimit = globalCache.get<number>(CACHE_KEYS.API_RETRY_LIMIT) ?? 3;
	const userApiKey = getApiKey(c);

	let keyResult: ApiKeyResult | null = null;
	const isModelsRequest = new URL(c.req.url).pathname.endsWith('/models'); // 在 Helper 内部检查

	if (attempt === 1) {
		keyResult = await getApiKeyForRequest(userApiKey, modelNameForKeyLookup);
		if (!keyResult && !isModelsRequest) { // models 请求即使没有 key 也可以继续
			throw new Response(`无可用API密钥 (${strategyName})`, { status: 503 });
		}
	} else if (userApiKey && await isTriggerKey(userApiKey)) {
		// 只有触发键才在重试时尝试 Pool
		const nextPoolKey = await getNextPoolKey();
		if (nextPoolKey) {
			keyResult = { key: nextPoolKey, source: 'pool' };
		} else if (!isModelsRequest) { // Pool 耗尽且非 models 请求
			throw new Response(`池密钥已耗尽 (${strategyName})`, { status: 503 });
		}
	} else if (!isModelsRequest) {
		// 如果不是触发键，且首次尝试失败 (非 pool key)，则不重试
		// 或者 Pool 耗尽且非 models 请求 (上一个 else if 处理了)
		// 或者 models 请求首次尝试失败 (keyResult 为 null)
		// 对于非 models 请求，如果首次失败且非触发键，则抛出错误
		if (attempt > 1) { // 确保这是重试失败的情况
			throw new Response(`API Key 无效或请求失败，不重试 (${strategyName})`, { status: 503 });
		}
		// 如果是 models 请求首次尝试失败，keyResult 会是 null，但不会抛错，继续执行
	}
	// models 请求即使 keyResult 为 null 也会到达这里

	return {
		key: keyResult?.key || null,
		source: keyResult?.source || null,
		gcpToken: null,
		gcpProject: null,
		maxRetries: keyResult?.source === 'pool' ? apiRetryLimit : 1
	};
};

// 策略接口
interface RequestHandlerStrategy {
	getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails>;
	buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): URL | Promise<URL>; // 允许同步或异步
	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers;
	processRequestBody(ctx: StrategyContext): Promise<BodyInit | null | ReadableStream>; // 返回类型支持流
	handleResponse?(response: Response, ctx: StrategyContext): Promise<Response>; // 可选的响应处理
}

// --- Vertex AI 策略 ---
class VertexAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(_c: Context, _ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		// 获取全局重试限制
		// 从缓存读取
		const apiRetryLimit = globalCache.get<number>(CACHE_KEYS.API_RETRY_LIMIT) ?? 3;

		// getGcpAuth 内部会确保凭证已加载

		// 直接调用重构后的 getGcpAuth (它内部会加载最新凭证)
		const auth = await getGcpAuth();
		if (!auth && attempt === 1) { // 首次尝试失败
			// 第一次尝试就失败，说明所有凭证（或至少第一个，如果 KV 失败）都无效
			throw new Response(`首次 GCP 凭证认证失败`, { status: 503 });
		}
		// 如果 auth 为 null 但不是第一次尝试，则重试循环会继续

		return {
			key: null,
			source: null,
			gcpToken: auth?.token || null, // 如果 auth 为 null (重试时可能发生)，则 gcpToken 也为 null
			gcpProject: auth?.projectId || null,
			// nextGcpIndex: 移除
			maxRetries: apiRetryLimit // 使用获取到的重试次数
		};
	}

	async buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): Promise<URL> {
		if (!authDetails.gcpProject) {
			// 内部逻辑错误，仍可抛出 Error
			throw new Error("Vertex AI 需要 GCP Project ID");
		}
		// 从缓存读取
		const gcpDefaultLocation = globalCache.get<string>(CACHE_KEYS.GCP_DEFAULT_LOCATION) ?? 'global';
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
			// 内部逻辑错误
			throw new Error("Vertex AI 需要 GCP Token");
		}
		// 使用辅助函数构建基础 Headers (从原始请求获取 Headers)
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.set('Authorization', `Bearer ${authDetails.gcpToken}`);
		return headers;
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> { // 返回类型不再是 ReadableStream
		// 优先处理无 Body 的请求或已预解析的 Body
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}

		let bodyToModify: any;

		// 检查 ctx.parsedBody 是否已存在且不为 null
		if (ctx.parsedBody !== undefined && ctx.parsedBody !== null) {
			// console.log("Vertex: Using pre-parsed body.");
			bodyToModify = ctx.parsedBody;
		} else if (ctx.originalBodyBuffer) { // 如果有预读取的 buffer
			try {
				bodyToModify = JSON.parse(new TextDecoder().decode(ctx.originalBodyBuffer));
			} catch (e) {
				console.error("Vertex: Failed to parse original request body from buffer:", e);
				throw new Response("Failed to parse request body for Vertex AI", { status: 400 });
			}
		} else { // 既没有 parsedBody 也没有 originalBodyBuffer (应该不会发生，除非请求无 body 但方法不是 GET/HEAD)
			console.warn("Vertex: No body or parsed body found for non-GET/HEAD request.");
			return null;
		}

		// 确保 body 是一个对象
		if (typeof bodyToModify !== 'object' || bodyToModify === null) {
			console.warn("Vertex: Parsed body is not an object, cannot apply modifications.");
			// 如果不是对象，仍然尝试 stringify 返回
			try {
				return JSON.stringify(bodyToModify);
			} catch (stringifyError) {
				console.error("Vertex: Failed to stringify non-object body:", stringifyError);
				throw new Response("Failed to process non-object request body", { status: 500 });
			}
		}

		// 修改 Body 内容
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
			return JSON.stringify(bodyToModify); // 返回修改后的 JSON 字符串
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

		// 优先使用预解析的 Body 中的 model (如果存在且是对象)
		if (ctx.parsedBody && typeof ctx.parsedBody === 'object' && ctx.parsedBody !== null) {
			// console.log("Gemini OpenAI using pre-parsed body for model");
			modelNameForKeyLookup = ctx.parsedBody.model ?? null;
		}
		// 不再尝试在此处解析 Body

		// 调用公共辅助函数获取认证详情
		return await _getGeminiAuthenticationDetails(c, modelNameForKeyLookup, attempt, "Gemini OpenAI");
	}

	async buildTargetUrl(ctx: StrategyContext, _authDetails: AuthenticationDetails): Promise<URL> { // <-- Mark as async
		// 从缓存读取
		const apiMappings = globalCache.get<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
		const baseUrl = apiMappings['/gemini']; // TODO: Consider if this specific mapping is still needed or should be dynamic
		if (!baseUrl) {
			// Handle case where '/gemini' prefix might not be in KV
			throw new Response("Gemini base URL '/gemini' not found in API mappings.", { status: 503 });
		}
		let targetPath = ctx.path;
		if (['/chat/completions', '/embeddings', '/models'].includes(ctx.path)) {
			targetPath = '/v1beta/openai' + ctx.path;
		} else if (ctx.path.startsWith('/v1/')) {
			targetPath = '/v1beta/openai' + ctx.path.slice(3);
		}
		const url = new URL(`${baseUrl}${targetPath}`);

		ctx.originalUrl.searchParams.forEach((val, key) => {
			if (key.toLowerCase() !== 'key') {
				url.searchParams.set(key, val);
			}
		});
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, authDetails: AuthenticationDetails): Headers {
		// 使用辅助函数构建基础 Headers (从原始请求获取 Headers)
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		// 移除需要过滤的 Headers
		headers.delete('authorization');
		headers.delete('x-goog-api-key');
		headers.delete('x-api-key');
		// 如果有 Key，设置 Authorization
		if (authDetails.key) {
			headers.set('Authorization', `Bearer ${authDetails.key}`);
		}
		return headers;
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> { // 返回类型不再是 ReadableStream
		// 优先处理无 Body 的请求
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}

		// 如果 Body 已经被预解析 (在 determineRequestType 中), 返回其 JSON 字符串形式
		if (ctx.parsedBody !== undefined && ctx.parsedBody !== null) {
			// console.log("Gemini OpenAI: Returning pre-parsed body as JSON string.");
			try {
				return JSON.stringify(ctx.parsedBody);
			} catch (e) {
				console.error("Gemini OpenAI: Failed to stringify pre-parsed body:", e);
				throw new Response("Failed to process pre-parsed request body", { status: 500 });
			}
		} else if (ctx.originalBodyBuffer) { // 如果有预读取的 buffer
			// console.log("Gemini OpenAI: Recreating body from buffer.");
			return new TextDecoder().decode(ctx.originalBodyBuffer); // 返回字符串
		} else {
			console.warn("Gemini OpenAI: No body or parsed body found for non-GET/HEAD request.");
			return null;
		}
	}

	async handleResponse(response: Response, ctx: StrategyContext): Promise<Response> {
		// 修复 /models 响应
		const contentType = response.headers.get("content-type");
		if (!ctx.path.endsWith('/models') || !contentType?.includes("application/json")) {
			return response;
		}

		// 注意：这里消耗了原始响应的 Body 流
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
				// 移除 Content-Encoding，因为我们改变了内容
				newHeaders.delete('Content-Encoding');
				newHeaders.set('Content-Length', String(new TextEncoder().encode(newBody).byteLength));
				return new Response(newBody, {
					status: response.status,
					statusText: response.statusText,
					headers: newHeaders
				});
			} else {
				// 如果未修改，需要重新创建响应，因为原始流已被消耗
				return new Response(bodyText, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers // 保留原始 headers
				});
			}
		} catch (e) {
			console.error("Gemini models fix error:", e);
			// 解析失败，返回原始文本（流已被消耗）
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

		// 优先从路径获取模型名称
		const match = ctx.path.match(/\/models\/([^:]+):/);
		if (match && match[1]) {
			   // console.log("Gemini Native using path for model");
			modelNameForKeyLookup = match[1];
		}
		// 不再尝试从 Body 解析模型名称

		// 调用公共辅助函数获取认证详情
		return await _getGeminiAuthenticationDetails(c, modelNameForKeyLookup, attempt, "Gemini Native");
	}

	async buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): Promise<URL> { // <-- Mark as async
		if (!authDetails.key) {
			// 内部逻辑错误
			throw new Error("Gemini Native 需要 API Key");
		}
		// 从缓存读取
		const apiMappings = globalCache.get<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
		const baseUrl = apiMappings['/gemini']; // TODO: Consider if this specific mapping is still needed or should be dynamic
		if (!baseUrl) {
			// Handle case where '/gemini' prefix might not be in KV
			throw new Response("Gemini base URL '/gemini' not found in API mappings.", { status: 503 });
		}
		const targetPath = ctx.path; // 原生路径通常无需修改
		const url = new URL(`${baseUrl}${targetPath}`);

		ctx.originalUrl.searchParams.forEach((val, key) => {
			if (key.toLowerCase() !== 'key') {
				url.searchParams.set(key, val);
			}
		});
		url.searchParams.set('key', authDetails.key); // Key 作为查询参数
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, _authDetails: AuthenticationDetails): Headers {
		// 使用辅助函数构建基础 Headers (从原始请求获取 Headers)
		const headers = buildBaseProxyHeaders(ctx.originalRequest.headers);
		// 移除需要过滤的 Headers
		headers.delete('authorization');
		headers.delete('x-goog-api-key');
		// Gemini Native 不设置 Authorization Header
		return headers;
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> { // 返回类型不再是 ReadableStream
		// 优先处理无 Body 的请求
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}

		// 如果 Body 已经被预解析 (在 determineRequestType 中), 返回其 JSON 字符串形式
		// 注意：Gemini Native 路径通常不预解析 Body，所以 ctx.parsedBody 常常是 undefined
		if (ctx.parsedBody !== undefined && ctx.parsedBody !== null) {
			// console.log("Gemini Native: Returning pre-parsed body as JSON string.");
			try {
				return JSON.stringify(ctx.parsedBody);
			} catch (e) {
				console.error("Gemini Native: Failed to stringify pre-parsed body:", e);
				throw new Response("Failed to process pre-parsed request body", { status: 500 });
			}
		} else if (ctx.originalBodyBuffer) { // 如果有预读取的 buffer
			// console.log("Gemini Native: Recreating body from buffer.");
			// 对于原生 Gemini 请求，通常是 JSON body
			return new TextDecoder().decode(ctx.originalBodyBuffer); // 返回字符串
		} else {
			console.warn("Gemini Native: No body or parsed body found for non-GET/HEAD request.");
			return null;
		}
	}
}

// --- 通用代理策略 ---
class GenericProxyStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(_c: Context, ctx: StrategyContext, _attempt: number): Promise<AuthenticationDetails> {
		// 通用代理不处理认证，不重试
		return {
			key: null,
			source: null,
			gcpToken: null,
			gcpProject: null,
			maxRetries: 1 // 通用代理固定为 1 次尝试
		};
	}

	async buildTargetUrl(ctx: StrategyContext, _authDetails: AuthenticationDetails): Promise<URL> { // <-- Mark as async
		// 从缓存读取
		const apiMappings = globalCache.get<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
		if (!ctx.prefix || !apiMappings[ctx.prefix]) { // 简化检查
			throw new Response(`未配置代理前缀 '${ctx.prefix}' 的目标地址`, { status: 503 });
		}
		const baseUrl = apiMappings[ctx.prefix]; // 直接使用 prefix
		const targetPath = ctx.path;
		const url = new URL(`${baseUrl}${targetPath}`);

		ctx.originalUrl.searchParams.forEach((val, key) => {
			if (key.toLowerCase() !== 'key') {
				url.searchParams.set(key, val);
			}
		});
		return url;
	}

	buildRequestHeaders(ctx: StrategyContext, _authDetails: AuthenticationDetails): Headers {
		// 直接使用辅助函数构建基础 Headers (从原始请求获取 Headers)
		return buildBaseProxyHeaders(ctx.originalRequest.headers);
	}

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> { // 返回类型不再是 ReadableStream
		// 优先处理无 Body 的请求
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null;
		}

		// 通用代理现在从预读取的 buffer 创建新的流
		if (ctx.originalBodyBuffer) {
			// console.log("Generic Proxy: Recreating body from buffer.");
			// 对于通用代理，直接返回 ArrayBuffer
			return ctx.originalBodyBuffer;
		} else {
			console.warn("Generic Proxy: No body buffer found for non-GET/HEAD request.");
			return null;
		}
	}
}

// === 策略选择器 ===

// 定义 determineRequestType 的返回类型
interface DetermineResult {
	type: RequestType;
	prefix: string | null;
	path: string;
	parsedBody?: any | null; // 可选的预解析 Body
}

// 根据请求上下文判断类型 (现在接收 Context，并可能返回解析后的 Body)
const determineRequestType = async (
	c: Context
): Promise<DetermineResult> => {
	const req = c.req.raw; // 获取原始请求
	const url = new URL(req.url);
	// 从缓存读取
	const apiMappings = globalCache.get<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
	const prefix = Object.keys(apiMappings).find(p => url.pathname.startsWith(p));
	const path = prefix ? url.pathname.slice(prefix.length) : url.pathname;

	if (!prefix) {
		return { type: RequestType.UNKNOWN, prefix: null, path };
	}

	const isGeminiPrefix = prefix === '/gemini';
	// OpenAI 兼容路径判断 (非 /v1beta/ 开头)
	const isOpenAICompatiblePath = isGeminiPrefix && !path.startsWith('/v1beta/');

	if (isOpenAICompatiblePath) {
		let model: string | null = null;
		let parsedBody: any | null = null; // 用于存储解析结果
		// 仅在需要区分 Vertex 和 Gemini OpenAI 时才解析 Body
		if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
			try {
				// 克隆请求，因为 body 只能读取一次
				const clonedRequest = req.clone();
				parsedBody = await clonedRequest.json(); // 解析并存储
				model = parsedBody?.model ?? null;
				//// console.log("determineRequestType parsed body:", parsedBody);
			} catch (e) {
				console.warn("determineRequestType: Failed to parse body for model check:", e);
				// 解析失败，按非 Vertex 处理 (或可以抛出错误，取决于业务逻辑)
				// 这里选择继续，将 model 视为 null，parsedBody 也为 null
				parsedBody = null; // 确保解析失败时为 null
			}
		}
		const isVertex = isVertexModel(model); // 使用 replacekeys.ts 中的函数 (内部已用缓存)
		return {
			type: isVertex ? RequestType.VERTEX_AI : RequestType.GEMINI_OPENAI, // 使用判断结果
			prefix,
			path,
			parsedBody // 返回解析结果 (可能为 null)
		};
	} else if (isGeminiPrefix) {
		// Gemini 原生路径
		return { type: RequestType.GEMINI_NATIVE, prefix, path }; // 不解析 Body
	} else {
		// 其他通用代理
		return { type: RequestType.GENERIC_PROXY, prefix, path }; // 不解析 Body
	}
};

// 根据类型获取策略实例
const getStrategy = (type: RequestType): RequestHandlerStrategy => {
	switch (type) {
		case RequestType.VERTEX_AI: return new VertexAIStrategy();
		case RequestType.GEMINI_OPENAI: return new GeminiOpenAIStrategy();
		case RequestType.GEMINI_NATIVE: return new GeminiNativeStrategy();
		case RequestType.GENERIC_PROXY: return new GenericProxyStrategy();
		default: throw new Error(`不支持的请求类型: ${type}`); // 内部错误
	}
};

// === 主处理函数  ===
export const handleGenericProxy = async (c: Context): Promise<Response> => {
	const requestStartTime = performance.now(); // <-- 计时起点
	console.log(`[Debug] Request received for ${c.req.url} at ${new Date().toISOString()}`); // 添加日志确认请求入口

	const req = c.req.raw;
	const url = new URL(req.url);

	// 预先读取原始请求的 body 为 ArrayBuffer，以便在重试时可以重复使用
	// 对于 GET/HEAD 请求或没有 body 的请求，originalBodyBuffer 将为 null
	let originalBodyBuffer: ArrayBuffer | null = null;
	if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
		try {
			// 克隆请求以读取 body，避免影响 determineRequestType 中的 body 读取
			const clonedReqForBody = req.clone();
			originalBodyBuffer = await clonedReqForBody.arrayBuffer();
		} catch (e) {
			console.error("Failed to read original request body into ArrayBuffer:", e);
			return new Response("Internal Server Error: Failed to process request body.", { status: 500 });
		}
	}

	// 判断类型并获取策略 (传入 Context), 同时获取可能的预解析 Body
	// 注意：determineRequestType 可能会再次消耗 body，因此在它之前读取 bodyBuffer 是安全的
	const { type, prefix, path, parsedBody } = await determineRequestType(c);
	if (type === RequestType.UNKNOWN) {
		return new Response("无效的API路径前缀", { status: 404 });
	}
	const strategy = getStrategy(type);

	// 构建策略上下文 (传入原始请求、预解析的 Body 和原始 Body Buffer)
	const strategyContext: StrategyContext = {
		originalUrl: url,
		originalRequest: req, // 传递原始请求对象
		path,
		prefix,
		parsedBody,
		originalBodyBuffer // 传递预读取的 body buffer
	};

	// 重试循环
	let attempts = 0;
	let maxRetries = 1; // 会在首次调用策略时更新
	let lastError: Response | null = null; // 保存最后一次的错误 Response

	while (attempts < maxRetries) {
		attempts++;
		try {
			// 1. 获取认证 (策略负责, 传入 c)
			const authDetails = await strategy.getAuthenticationDetails(c, strategyContext, attempts);
			if (attempts === 1) {
				maxRetries = authDetails.maxRetries; // 更新重试次数
			}

			// 2. 构建 URL 
			const targetUrl = await strategy.buildTargetUrl(strategyContext, authDetails);

			// 3. 构建 Headers 
			const targetHeaders = strategy.buildRequestHeaders(strategyContext, authDetails);

			// 4. 处理 Body (可能返回 Stream)
			const targetBody = await strategy.processRequestBody(strategyContext);

			// 5. 执行 Fetch
			const fetchStartTime = performance.now(); // <-- 计时终点
			const timeBeforeFetch = fetchStartTime - requestStartTime;
			console.log(`[Debug] Time before fetch (Attempt ${attempts}, Type: ${RequestType[type]}): ${timeBeforeFetch.toFixed(2)} ms for ${url.pathname}`); // <-- 打印时间差

			const res = await fetch(targetUrl, {
				method: req.method,
				headers: targetHeaders,
				body: targetBody
			});

			// 6. 处理响应
			if (res.ok) {
				// 特定策略的响应处理 (如 Gemini Models 修复)
				let finalResponse = res;
				if (strategy.handleResponse) {
					finalResponse = await strategy.handleResponse(res, strategyContext);
				}

				// 直接返回上游响应 依赖 Hono/Deno 进行流式传输
				return finalResponse;
			} else {
				// 响应不成功时
				lastError = res; // 保存原始错误以备最终返回
				if (attempts < maxRetries) { // 仅在非最后一次尝试时消费 body
					await res.arrayBuffer().catch(() => {}); // 消费响应体以释放资源
				}
				console.warn(`Attempt ${attempts}/${maxRetries} failed for ${RequestType[type]} ${targetUrl}: ${res.status} ${res.statusText}`);
			}

		} catch (err) {
			console.error(`Attempt ${attempts}/${maxRetries} caught error for ${RequestType[type]}:`, err);
			if (err instanceof Response) {
				lastError = err; // 捕获到的是 Response 对象 (例如策略抛出的错误)，保存并继续重试
				if (attempts < maxRetries) { // 仅在非最后一次尝试时消费 body
					// 如果捕获到的是 Response 对象，也确保消费响应体以释放资源
					await err.arrayBuffer().catch(() => {});
				}
			} else {
				throw err; // 捕获到非 Response 错误（如网络错误），直接重新抛出
			}
			// 只有 Response 错误会继续循环，非 Response 错误已抛出
		}
	} // end while

	// 如果循环结束仍未成功，返回最后一次遇到的错误 Response
	if (lastError) {
		// 直接返回最后捕获到的 Response 对象
		return lastError;
	}
	// 如果 lastError 意外为 null，则返回通用错误
	return new Response("请求处理失败，已达最大重试次数", { status: 500 });
};