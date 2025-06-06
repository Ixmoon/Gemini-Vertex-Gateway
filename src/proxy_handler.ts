import { Context } from "https://deno.land/x/hono@v4.3.11/mod.ts";
import { GoogleAuth } from "https://esm.sh/google-auth-library";

// 导入 kv 操作函数、类型和常量
import {
	openKv, // KV 实例操作
	getGcpCredentialsString, // 获取 GCP 凭证字符串
	getGcpDefaultLocation, // 获取 GCP 默认区域
	getApiRetryLimit, // 获取 API 重试次数
	getApiKeyForRequest, // 获取请求的 API Key (核心逻辑)
	isTriggerKey, // 检查是否为触发 Key
	getNextPoolKey, // 获取下一个密钥池 Key
	isVertexModel, // 检查是否为 Vertex 模型
	ApiKeySource, // Key 来源类型
	ApiKeyResult, // API Key 结果类型 <--- 补充导入
	GCP_CREDENTIAL_ATOMIC_INDEX_KEY, // GCP 凭证原子计数器 Key
	getApiMappings, // 获取 API 路径映射
} from "./replacekeys.ts";

// === 类型定义 ===

// Gcp凭证定义
export interface GcpCredentials {
	type: string;
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
	client_id?: string;
	auth_uri?: string;
	token_uri?: string;
	auth_provider_x509_cert_url?: string;
	client_x509_cert_url?: string;
	universe_domain?: string;
	[key: string]: any;
}

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
	source: ApiKeySource | null; // Key 来源 (user/pool/fallback) <--- 移除 kvOps.
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
}

// === API 路径映射 ===

// API 路径映射现在从 KV 数据库加载
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

const parseCreds = (jsonStr: string): GcpCredentials[] => {
	try {
		const p = JSON.parse(jsonStr);
		if (Array.isArray(p)) {
			return p.filter(isValidCred);
		}
	} catch { /* 忽略第一个解析错误 */ }

	try {
		let f = jsonStr.trim();
		if (!f.startsWith('[')) {
			f = `[${f.replace(/}\s*{/g, '},{')}]`;
		}
		const p = JSON.parse(f);
		if (Array.isArray(p)) {
			return p.filter(isValidCred);
		}
	} catch { /* 忽略第二个解析错误 */ }

	return (jsonStr.match(/\{(?:[^{}]|{[^{}]*})*\}/g) || [])
		.map(s => {
			try {
				const p = JSON.parse(s.trim());
				return isValidCred(p) ? p : null;
			} catch {
				return null;
			}
		})
		.filter(Boolean) as GcpCredentials[];
};

/** [内部][重构] 尝试获取第一个 GCP 凭证的 Token (优先读 KV 缓存, 1 分钟 TTL) */
const _tryGetFirstGcpToken = async (
	creds: GcpCredentials[],
	auths: GoogleAuth[]
): Promise<{ token: string; projectId: string } | null> => {
	if (!auths.length || !creds.length) return null; // 确保凭证和认证对象存在

	const kv = await openKv();
	const cacheKey = ["gcp_token_cache", 0]; // 缓存键固定为索引 0
	const cacheTTL = 60000; // 1 分钟 (毫秒)

	try {
		// 1. 尝试从 KV 缓存读取
		const cachedEntry = await kv.get<{ token: string; projectId: string }>(cacheKey);
		if (cachedEntry.value) {
			// console.log("Fallback: Cache hit for index 0");
			return cachedEntry.value;
		}

		// 2. 缓存未命中或过期，获取新 Token
		// console.log("Fallback: Cache miss/expired for index 0. Fetching new token.");
		const newToken = await auths[0].getAccessToken();
		if (newToken) {
			const tokenData = { token: newToken, projectId: creds[0].project_id };
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

/** [重构] 每次都从 KV 加载并解析 GCP 凭证 */
export const loadGcpCreds = async (): Promise<{ creds: GcpCredentials[]; auths: GoogleAuth[] }> => {
	// ... (保持不变) ...
	const jsonStr = await getGcpCredentialsString();
	if (!jsonStr) {
		return { creds: [], auths: [] }; // 没有凭证字符串，返回空
	}
	try {
		const creds = parseCreds(jsonStr);
		const auths = creds.map(cred => new GoogleAuth({
			credentials: cred,
			scopes: ["https://www.googleapis.com/auth/cloud-platform"]
		}));
		return { creds, auths };
	} catch (e) {
		console.error("Failed to load/parse GCP creds:", e);
		return { creds: [], auths: [] }; // 解析失败，返回空
	}
};

// [重构] 使用原子计数器获取 GCP 认证信息 (优先读 KV 缓存, 1 分钟 TTL)
const getGcpAuth = async (): Promise<{ token: string; projectId: string } | null> => {
	// 1. 加载最新的凭证
	const { creds, auths } = await loadGcpCreds();
	if (!auths.length) {
		console.warn("getGcpAuth called but no GCP credentials available.");
		return null; // 没有可用凭证
	}

	let calculatedIndex = -1; // 用于错误日志和回退
	const cacheTTL = 60000; // 1 分钟 (毫秒)

	try {
		// 2. 计算凭证索引 (使用原子计数器)
		const kv = await openKv();
		const atomicIncRes = await kv.atomic().sum(GCP_CREDENTIAL_ATOMIC_INDEX_KEY, 1n).commit();
		if (!atomicIncRes.ok) throw new Error("KV atomic increment failed");

		const currentCountEntry = await kv.get<Deno.KvU64>(GCP_CREDENTIAL_ATOMIC_INDEX_KEY);
		if (currentCountEntry.value === null) throw new Error("KV get count failed");

		const count = currentCountEntry.value.value;
		calculatedIndex = Number(count % BigInt(auths.length));
		const cacheKey = ["gcp_token_cache", calculatedIndex]; // 缓存键包含索引

		// 3. 尝试从 KV 缓存读取
		const cachedEntry = await kv.get<{ token: string; projectId: string }>(cacheKey);
		if (cachedEntry.value) {
			// console.log(`Cache hit for index ${calculatedIndex}`);
			return cachedEntry.value;
		}

		// 4. 缓存未命中或过期，获取新 Token
		// console.log(`Cache miss/expired for index ${calculatedIndex}. Fetching new token.`);
		const newToken = await auths[calculatedIndex].getAccessToken();
		if (!newToken) {
			console.error(`GCP auth returned null token for atomic index ${calculatedIndex}`);
			throw new Error("GCP returned null token"); // 触发回退
		}

		// 5. 成功获取，存入 KV 缓存并返回
		const tokenData = { token: newToken, projectId: creds[calculatedIndex].project_id };
		// 异步写入缓存，不阻塞返回
		kv.set(cacheKey, tokenData, { expireIn: cacheTTL }).catch(e => {
			console.error(`Failed to set KV cache for index ${calculatedIndex}:`, e);
		});
		return tokenData;

	} catch (error) {
		// 统一处理所有错误 (KV 操作、GCP Auth)
		if (calculatedIndex !== -1) {
			console.error(`GCP auth/cache failed for atomic index ${calculatedIndex}:`, error);
		} else {
			console.error("Error during KV operation/index calculation in getGcpAuth:", error);
		}

		// 6. 执行回退逻辑 (使用加载的 creds 和 auths)
		console.warn("Falling back to first GCP credential (index 0).");
		// 回退逻辑现在优先检查索引 0 的缓存
		return await _tryGetFirstGcpToken(creds, auths);
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
	const apiRetryLimit = await getApiRetryLimit();
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
		const apiRetryLimit = await getApiRetryLimit();

		// [移除] 不再检查 credsLoaded 或手动调用 loadGcpCreds
		// if (!credsLoaded) {
		// 	await loadGcpCreds();
		// }
		// [移除] gcpAuth.length 检查移至 getGcpAuth 内部
		// if (!gcpAuth.length) {
		// 	throw new Response("未配置 GCP 凭证", { status: 503 });
		// }

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
		const gcpDefaultLocation = await getGcpDefaultLocation(); // 按需获取, 移除 kvOps.
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

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> {
		// Vertex 策略需要修改 Body
		if (ctx.originalRequest.method === 'GET' || ctx.originalRequest.method === 'HEAD') {
			return null; // GET/HEAD 不应有 Body
		}

		let body: any = null;

		try {
			// 优先使用预解析的 Body
			if (ctx.parsedBody !== undefined) {
				body = ctx.parsedBody;
			} else if (ctx.originalRequest.body) {
				// 如果没有预解析，则解析原始请求 Body
				body = await ctx.originalRequest.json();
			} else {
				// console.log("Vertex: No body found");
				return null; // 没有 Body 内容
			}

			// 确保 body 是一个对象 (如果为 null 或非对象，则无法修改)
			if (typeof body !== 'object' || body === null) {
				console.warn("Vertex body is not an object after parsing/retrieval.");
				throw new Error("Parsed Vertex body is not an object, cannot apply modifications.");// 如果不是对象，无法应用修改，返回原始 Body 的字符串形式（如果可能）或 null
			}

			// --- 修改 Body 内容 ---
			if (body.model && typeof body.model === 'string' && !body.model.startsWith('google/')) {
				body.model = `google/${body.model}`;
			}
			// 检查并删除顶层的 reasoning_effort (vertex不支持none参数，如果有需要移除避免报错)
			if (body.reasoning_effort === 'none') {
				delete body.reasoning_effort;
			}
			body.google = {
				...(body.google || {}),
				safety_settings: [
					{ "category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF" },
					{ "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF" },
					{ "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF" },
					{ "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF" },
				]
			};
			// --- 结束修改 Body 内容 ---
			return JSON.stringify(body); // 返回修改后的 JSON 字符串

		} catch (e) {
			// 处理解析错误或上面抛出的 Error
			console.error("Vertex body processing error:", e);
			// 解析或处理失败，无法继续，抛出错误或返回特定响应
			const message = e instanceof Error ? e.message : "Failed to process Vertex AI request body";
			throw new Response(message, { status: 400 });
		}
	}
}

// --- Gemini (OpenAI 兼容) 策略 ---
class GeminiOpenAIStrategy implements RequestHandlerStrategy {
	async getAuthenticationDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails> {
		let modelNameForKeyLookup: string | null = null;

		// 优先使用预解析的 Body 中的 model
		if (ctx.parsedBody && typeof ctx.parsedBody === 'object' && ctx.parsedBody !== null) {
			   // console.log("Gemini OpenAI using pre-parsed body for model");
			modelNameForKeyLookup = ctx.parsedBody.model ?? null;
		}
		// 如果没有预解析的 Body，并且请求可能有 Body，则尝试解析克隆的请求
		else if (ctx.parsedBody === undefined && ctx.originalRequest.body && ctx.originalRequest.method !== 'GET' && ctx.originalRequest.method !== 'HEAD') {
			try {
				   // console.log("Gemini OpenAI parsing cloned request for model");
				// 克隆请求以允许后续策略（processRequestBody）也能读取 body stream
				const clonedRequest = ctx.originalRequest.clone();
				const body = await clonedRequest.json();
				modelNameForKeyLookup = body?.model ?? null;
			} catch (e) {
				console.warn("Gemini OpenAI getAuth: Failed to parse cloned body for model name:", e);
				// 解析失败，继续执行，modelNameForKeyLookup 将为 null
			}
		}

		// 调用公共辅助函数获取认证详情
		return await _getGeminiAuthenticationDetails(c, modelNameForKeyLookup, attempt, "Gemini OpenAI");
	}

	async buildTargetUrl(ctx: StrategyContext, _authDetails: AuthenticationDetails): Promise<URL> { // <-- Mark as async
		const apiMappings = await getApiMappings(); // 从 KV 加载映射
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

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null | ReadableStream> {
		// 直接透传原始请求的 Body 流
		return ctx.originalRequest.body;
	}

	async handleResponse(response: Response, ctx: StrategyContext): Promise<Response> {
		// 修复 /models 响应
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
				newHeaders.set('Content-Length', String(newBody.length));
				return new Response(newBody, {
					status: response.status,
					statusText: response.statusText,
					headers: newHeaders
				});
			} else {
				return response; // 未修改则直接返回原始响应
			}
		} catch (e) {
			console.error("Gemini models fix error:", e);
			return response; // 解析失败直接返回原始响应
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
		// 如果路径中没有，则尝试从 Body 获取
		else {
			   // 优先使用预解析的 Body 中的 model
			   if (ctx.parsedBody && typeof ctx.parsedBody === 'object' && ctx.parsedBody !== null) {
				   // console.log("Gemini Native using pre-parsed body for model");
				   modelNameForKeyLookup = ctx.parsedBody.model ?? null;
			   }
			   // 如果没有预解析的 Body，并且请求可能有 Body，则尝试解析克隆的请求
			   else if (ctx.parsedBody === undefined && ctx.originalRequest.body && ctx.originalRequest.method !== 'GET' && ctx.originalRequest.method !== 'HEAD') {
				   try {
					   // console.log("Gemini Native parsing cloned request for model");
					   const clonedRequest = ctx.originalRequest.clone();
					   const body = await clonedRequest.json();
					   modelNameForKeyLookup = body?.model ?? null;
				   } catch (e) {
					   console.warn("Gemini Native getAuth: Failed to parse cloned body for model name:", e);
					   // 解析失败，继续，modelNameForKeyLookup 为 null
				   }
			   }
		   }

		// 调用公共辅助函数获取认证详情
		return await _getGeminiAuthenticationDetails(c, modelNameForKeyLookup, attempt, "Gemini Native");
	}

	async buildTargetUrl(ctx: StrategyContext, authDetails: AuthenticationDetails): Promise<URL> { // <-- Mark as async
		if (!authDetails.key) {
			// 内部逻辑错误
			throw new Error("Gemini Native 需要 API Key");
		}
		const apiMappings = await getApiMappings(); // 从 KV 加载映射
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

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null | ReadableStream> {
		// 直接透传原始请求的 Body 流
		return ctx.originalRequest.body;
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
		const apiMappings = await getApiMappings(); // 从 KV 加载映射
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

	async processRequestBody(ctx: StrategyContext): Promise<BodyInit | null | ReadableStream> {
		   // 直接透传原始请求的 Body 流
		return ctx.originalRequest.body;
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
	const apiMappings = await getApiMappings(); // 从 KV 加载映射
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
				// console.log("determineRequestType parsed body:", parsedBody);
			} catch (e) {
				console.warn("determineRequestType: Failed to parse body for model check:", e);
				// 解析失败，按非 Vertex 处理 (或可以抛出错误，取决于业务逻辑)
				// 这里选择继续，将 model 视为 null，parsedBody 也为 null
				parsedBody = null; // 确保解析失败时为 null
			}
		}
		// 使用导入的 isVertexModel 函数进行判断
		const isVertex = await isVertexModel(model); // 使用 replacekeys.ts 中的函数
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
	const req = c.req.raw;
	const url = new URL(req.url);

	// 判断类型并获取策略 (传入 Context), 同时获取可能的预解析 Body
	const { type, prefix, path, parsedBody } = await determineRequestType(c);
	if (type === RequestType.UNKNOWN) {
		return new Response("无效的API路径前缀", { status: 404 });
	}
	const strategy = getStrategy(type);

	// 构建策略上下文 (传入原始请求和预解析的 Body)
	const strategyContext: StrategyContext = {
		originalUrl: url,
		originalRequest: req, // 传递原始请求对象
		path,
		prefix,
		parsedBody // 传递预解析的 Body (可能为 undefined 或 null)
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

					 // 移除手动设置 Content-Type 和 Content-Length 的逻辑
					 // fetch 会自动处理 ReadableStream 的 Headers

			// 5. 执行 Fetch
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

				// 直接返回上游响应 (或处理后的响应)，依赖 Hono/Deno 进行流式传输
				return finalResponse;
			} else {
				lastError = res; // 保存原始错误以备最终返回
				console.warn(`Attempt ${attempts}/${maxRetries} failed for ${RequestType[type]} ${targetUrl}: ${res.status} ${res.statusText}`);
			}

		} catch (err) {
			console.error(`Attempt ${attempts}/${maxRetries} caught error for ${RequestType[type]}:`, err);
			if (err instanceof Response) {
				lastError = err; // 捕获到的是 Response 对象 (例如策略抛出的错误)，保存并继续重试
			} else {
				throw err;// 捕获到非 Response 错误（如网络错误），直接重新抛出
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