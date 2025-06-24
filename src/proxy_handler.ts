import { Context } from "hono";
import {
	getApiKeyForRequest,
	isVertexModel,
	getApiRetryLimit,
	getGcpDefaultLocation,
	getGcpAuth,
	getApiMappings,
	ApiKeyResult,
} from "./services.ts";

// --- 类型定义 ---
enum RequestType { VERTEX_AI, GEMINI_OPENAI, GEMINI_NATIVE, GENERIC_PROXY, UNKNOWN }
interface AuthDetails {
	key: string | null;
	gcpToken: string | null;
	gcpProject: string | null;
	maxRetries: number;
}
interface StrategyContext {
	originalUrl: URL;
	originalRequest: Request;
	path: string;
	prefix: string | null;
	parsedBody?: any;
	bodyBuffer?: ArrayBuffer;
}
interface RequestHandlerStrategy {
	getAuth(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthDetails>;
	buildUrl(ctx: StrategyContext, auth: AuthDetails): Promise<URL>;
	buildHeaders(ctx: StrategyContext, auth: AuthDetails): Headers;
	buildBody(ctx: StrategyContext): Promise<BodyInit | null>;
	handleResponse?(res: Response, ctx: StrategyContext): Promise<Response>;
}

// --- 辅助函数 ---
const buildBaseHeaders = (original: Headers) => {
	const headers = new Headers(original);
	headers.delete('host');
	return headers;
};

// --- 策略实现 ---
class VertexAIStrategy implements RequestHandlerStrategy {
	async getAuth(_c: Context, _ctx: StrategyContext, attempt: number): Promise<AuthDetails> {
		const auth = await getGcpAuth();
		if (!auth && attempt === 1) throw new Response("GCP 认证失败", { status: 503 });
		return { ...auth, key: null, maxRetries: await getApiRetryLimit() };
	}
	async buildUrl(ctx: StrategyContext, auth: AuthDetails): Promise<URL> {
		if (!auth.gcpProject) throw new Error("Vertex AI 需要 GCP Project ID");
		const loc = await getGcpDefaultLocation();
		const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
		const path = ctx.path.startsWith('/v1/') ? ctx.path.slice(3) : ctx.path;
		const url = new URL(`https://${host}/v1beta1/projects/${auth.gcpProject}/locations/${loc}/endpoints/openapi${path}`);
		ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
		return url;
	}
	buildHeaders(ctx: StrategyContext, auth: AuthDetails): Headers {
		if (!auth.gcpToken) throw new Error("Vertex AI 需要 GCP Token");
		const headers = buildBaseHeaders(ctx.originalRequest.headers);
		headers.set('Authorization', `Bearer ${auth.gcpToken}`);
		return headers;
	}
	async buildBody(ctx: StrategyContext): Promise<BodyInit | null> {
		if (!ctx.parsedBody) return ctx.bodyBuffer ?? null;
		const body = { ...ctx.parsedBody }; // 浅拷贝以修改
		if (body.model && !body.model.startsWith('google/')) body.model = `google/${body.model}`;
		body.google = {
			...(body.google || {}),
			safety_settings: [
				{ "category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF" },
				{ "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF" },
				{ "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF" },
				{ "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF" },
			]
		};
		return JSON.stringify(body);
	}
}

class GeminiStrategy {
	async getAuth(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthDetails> {
		const userKey = c.req.header("Authorization")?.replace(/^bearer\s+/i, '') || c.req.query('key');
		const model = ctx.parsedBody?.model ?? ctx.path.match(/\/models\/([^:]+):/)?.[1];
		
		let keyResult: ApiKeyResult | null = null;
		if (attempt === 1) {
			keyResult = await getApiKeyForRequest(userKey, model);
		} else { // 仅在重试时获取新池密钥
			keyResult = { key: await getNextPoolKey(), source: 'pool' };
		}
		
		if (!keyResult?.key) throw new Response("无可用 API 密钥", { status: 503 });

		return {
			key: keyResult.key,
			gcpToken: null,
			gcpProject: null,
			maxRetries: keyResult.source === 'pool' ? await getApiRetryLimit() : 1
		};
	}
	buildHeaders(ctx: StrategyContext, auth: AuthDetails): Headers {
		const headers = buildBaseHeaders(ctx.originalRequest.headers);
		headers.delete('authorization');
		headers.delete('x-goog-api-key');
		if (auth.key) headers.set('Authorization', `Bearer ${auth.key}`);
		return headers;
	}
	async buildBody(ctx: StrategyContext): Promise<BodyInit | null> {
		return ctx.bodyBuffer ?? null;
	}
}

class GeminiOpenAIStrategy extends GeminiStrategy implements RequestHandlerStrategy {
	async buildUrl(ctx: StrategyContext, _auth: AuthDetails): Promise<URL> {
		const mappings = await getApiMappings();
		const baseUrl = mappings['/gemini'];
		if (!baseUrl) throw new Response("Gemini 基础 URL 未配置", { status: 503 });

		let targetPath = ctx.path.startsWith('/v1/') ? ctx.path.slice(3) : ctx.path;
		targetPath = '/v1beta/openai' + targetPath;

		const url = new URL(targetPath, baseUrl);
		ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
		return url;
	}
	async handleResponse(res: Response, ctx: StrategyContext): Promise<Response> {
        if (!ctx.path.endsWith('/models') || !res.headers.get("content-type")?.includes("application/json")) {
            return res;
        }
        const body = await res.json();
        if (body?.data?.length) {
            body.data.forEach((m: any) => { if (m.id?.startsWith('models/')) m.id = m.id.slice(7); });
            const newBody = JSON.stringify(body);
            const newHeaders = new Headers(res.headers);
            newHeaders.set('Content-Length', String(new TextEncoder().encode(newBody).byteLength));
            return new Response(newBody, { status: res.status, statusText: res.statusText, headers: newHeaders });
        }
        return res;
    }
}

class GeminiNativeStrategy extends GeminiStrategy implements RequestHandlerStrategy {
	async buildUrl(ctx: StrategyContext, auth: AuthDetails): Promise<URL> {
		const mappings = await getApiMappings();
		const baseUrl = mappings['/gemini'];
		if (!baseUrl) throw new Response("Gemini 基础 URL 未配置", { status: 503 });

		const url = new URL(ctx.path, baseUrl);
		ctx.originalUrl.searchParams.forEach((v, k) => k.toLowerCase() !== 'key' && url.searchParams.set(k, v));
		if (auth.key) url.searchParams.set('key', auth.key);
		return url;
	}
}

class GenericProxyStrategy implements RequestHandlerStrategy {
    async getAuth(): Promise<AuthDetails> { return { key: null, gcpToken: null, gcpProject: null, maxRetries: 1 }; }
    async buildUrl(ctx: StrategyContext): Promise<URL> {
        const mappings = await getApiMappings();
        const baseUrl = ctx.prefix ? mappings[ctx.prefix] : null;
        if (!baseUrl) throw new Response(`代理前缀 '${ctx.prefix}' 未配置`, { status: 503 });
        const url = new URL(ctx.path, baseUrl);
        ctx.originalUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
        return url;
    }
    buildHeaders(ctx: StrategyContext): Headers { return buildBaseHeaders(ctx.originalRequest.headers); }
    async buildBody(ctx: StrategyContext): Promise<BodyInit | null> { return ctx.bodyBuffer ?? null; }
}


// --- 策略选择器 ---
async function determineRequestType(c: Context, bodyBuffer: ArrayBuffer | null) {
	const url = new URL(c.req.url);
	const mappings = await getApiMappings();
	const matchedPrefix = Object.keys(mappings).sort((a, b) => b.length - a.length).find(p => url.pathname.startsWith(p));
	const path = matchedPrefix ? url.pathname.slice(matchedPrefix.length) : url.pathname;
	
	let parsedBody: any;
	if (bodyBuffer && c.req.method !== 'GET') {
		try { parsedBody = JSON.parse(new TextDecoder().decode(bodyBuffer)); } catch {}
	}
	
	if (matchedPrefix === '/gemini') {
		if (!path.startsWith('/v1beta/')) { // OpenAI 兼容路径
			return { type: await isVertexModel(parsedBody?.model) ? RequestType.VERTEX_AI : RequestType.GEMINI_OPENAI, prefix: matchedPrefix, path, parsedBody };
		}
		return { type: RequestType.GEMINI_NATIVE, prefix: matchedPrefix, path, parsedBody };
	}

	if (matchedPrefix) {
		return { type: RequestType.GENERIC_PROXY, prefix: matchedPrefix, path, parsedBody };
	}
	
	return { type: RequestType.UNKNOWN, prefix: null, path };
}

// --- 主处理函数 ---
export async function handleGenericProxy(c: Context): Promise<Response> {
	const req = c.req.raw;
	const bodyBuffer = (req.method !== 'GET' && req.body) ? await req.clone().arrayBuffer() : undefined;
	const { type, prefix, path, parsedBody } = await determineRequestType(c, bodyBuffer ?? null);

	if (type === RequestType.UNKNOWN) return new Response("代理路由未配置", { status: 404 });
	
	const strategies: Record<RequestType, RequestHandlerStrategy> = {
		[RequestType.VERTEX_AI]: new VertexAIStrategy(),
		[RequestType.GEMINI_OPENAI]: new GeminiOpenAIStrategy(),
		[RequestType.GEMINI_NATIVE]: new GeminiNativeStrategy(),
		[RequestType.GENERIC_PROXY]: new GenericProxyStrategy(),
		[RequestType.UNKNOWN]: null!
	};
	const strategy = strategies[type];

	const strategyContext: StrategyContext = {
		originalUrl: new URL(req.url), originalRequest: req, path, prefix, parsedBody, bodyBuffer,
	};
	
	let attempts = 0;
	let maxRetries = 1;
	let lastError: Response | null = null;
	
	while (attempts < maxRetries) {
		attempts++;
		try {
			const auth = await strategy.getAuth(c, strategyContext, attempts);
			if (attempts === 1) maxRetries = auth.maxRetries;

			const targetUrl = await strategy.buildUrl(strategyContext, auth);
			const targetHeaders = strategy.buildHeaders(strategyContext, auth);
			const targetBody = await strategy.buildBody(strategyContext);

			const proxyResponse = await fetch(targetUrl, {
				method: req.method,
				headers: targetHeaders,
				body: targetBody,
			});

			if (proxyResponse.ok) {
				return strategy.handleResponse ? await strategy.handleResponse(proxyResponse, strategyContext) : proxyResponse;
			}
			
			lastError = proxyResponse.clone();
			await proxyResponse.body?.cancel(); // 释放连接
			if (attempts >= maxRetries) console.error(`[Proxy] 达到最大重试次数 (${maxRetries})`);

		} catch (error) {
			console.error(`[Proxy] 第 ${attempts} 次尝试出错:`, error);
			if (error instanceof Response) {
				lastError = error.clone();
				await error.body?.cancel();
			} else {
				return new Response(`代理内部错误: ${error.message}`, { status: 500 });
			}
		}
	}
	
	return lastError ?? new Response("代理请求失败，已达最大重试次数", { status: 502 });
}