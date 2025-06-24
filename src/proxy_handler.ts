import { Context } from "hono";
import { GoogleAuth } from "google-auth-library";
import {
    API_MAPPINGS,
    API_RETRY_LIMIT,
    GCP_CREDENTIALS,
    GCP_DEFAULT_LOCATION,
    resolveApiKey,
    isTriggerKey,
    getNextPoolKey,
    ApiKeyResult,
    ApiKeySource,
} from "./config.ts";

// --- 常量与类型定义 ---

const HTTP_HEADER = {
    HOST: 'host',
    AUTHORIZATION: 'authorization',
    CONTENT_TYPE: 'content-type',
    CONTENT_LENGTH: 'content-length',
    X_GOOG_API_KEY: 'x-goog-api-key',
};

enum RequestStrategyType { VERTEX_AI, GEMINI_OPENAI, GEMINI_NATIVE, GENERIC_PROXY, UNKNOWN }

interface AuthDetails {
	key: string | null;
	source: ApiKeySource | null;
	gcpToken: string | null;
	gcpProject: string | null;
	maxRetries: number;
}

interface StrategyContext {
	originalUrl: URL;
	originalRequest: Request;
	downstreamPath: string;
	routePrefix: string;
	parsedBody?: any | null;
    // [FIXED] Type '... | undefined' is not assignable to type 'BodyInit | null'
	originalBodyBuffer: ArrayBuffer | null;
}

// --- 内部辅助函数 ---

const createProxyHeaders = (originalHeaders: Headers): Headers => {
	const headers = new Headers(originalHeaders);
	headers.delete(HTTP_HEADER.HOST);
	return headers;
};

const getApiKeyFromRequest = (c: Context): string | null => {
	const { req } = c;
	const url = new URL(req.url);
	return url.searchParams.get('key') ||
		req.header(HTTP_HEADER.AUTHORIZATION)?.replace(/^bearer\s+/i, '') ||
		req.header(HTTP_HEADER.X_GOOG_API_KEY) ||
		null;
};

const getGcpAuthToken = async (): Promise<{ token: string; projectId: string } | null> => {
	if (GCP_CREDENTIALS.length === 0) return null;
	const selectedCred = GCP_CREDENTIALS[Math.floor(Math.random() * GCP_CREDENTIALS.length)];
	try {
		const auth = new GoogleAuth({ credentials: selectedCred, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
		const token = await auth.getAccessToken();
		if (!token) {
			console.error(`GCP Auth: Failed to get new token for project ${selectedCred.project_id}.`);
			return null;
		}
		return { token, projectId: selectedCred.project_id };
	} catch (error) {
		console.error(`GCP Auth: Error during token acquisition for project ${selectedCred.project_id}:`, error);
		return null;
	}
};

// --- 请求处理策略 (Strategy Pattern) ---

interface RequestHandlerStrategy {
	getAuthDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthDetails>;
	buildTargetUrl(ctx: StrategyContext, auth: AuthDetails): URL;
	buildRequestHeaders(ctx: StrategyContext, auth: AuthDetails): Headers;
	processRequestBody(ctx: StrategyContext): BodyInit | null | Promise<BodyInit | null>;
	handleResponse?(response: Response, ctx: StrategyContext): Promise<Response>;
}

/** 为 Gemini 相关的策略解析认证详情的共享逻辑 */
const resolveGeminiAuthDetails = (c: Context, modelName: string | null, attempt: number, strategyName: string): AuthDetails => {
	const userApiKey = getApiKeyFromRequest(c);
	const isModelsRequest = new URL(c.req.url).pathname.endsWith('/models');
	let keyResult: ApiKeyResult | null = null;

	if (attempt === 1) {
		keyResult = resolveApiKey(userApiKey, modelName);
		if (!keyResult && !isModelsRequest) throw new Response(`No available API key for ${strategyName}`, { status: 401 });
	} else if (isTriggerKey(userApiKey)) {
		const nextPoolKey = getNextPoolKey();
		if (nextPoolKey) keyResult = { key: nextPoolKey, source: 'pool' };
		else if (!isModelsRequest) throw new Response(`Key pool exhausted for ${strategyName}`, { status: 503 });
	} else if (!isModelsRequest) {
		throw new Response(`Request failed and retries are not available for this key type.`, { status: 429 });
	}

	return {
		key: keyResult?.key || null,
		source: keyResult?.source || null,
		gcpToken: null,
		gcpProject: null,
		maxRetries: keyResult?.source === 'pool' ? API_RETRY_LIMIT : 1,
	};
};

class VertexAIStrategy implements RequestHandlerStrategy {
	async getAuthDetails(c: Context, _ctx: StrategyContext, attempt: number): Promise<AuthDetails> {
		if (!isTriggerKey(getApiKeyFromRequest(c))) {
			throw new Response("A valid trigger API key is required for the /vertex endpoint.", { status: 401 });
		}
		const auth = await getGcpAuthToken();
		if (!auth) {
			const message = attempt === 1 ? "Initial GCP credential authentication failed" : "GCP credential authentication failed on retry";
			throw new Response(message, { status: 503 });
		}
		return { key: null, source: null, gcpToken: auth.token, gcpProject: auth.projectId, maxRetries: API_RETRY_LIMIT };
	}
	buildTargetUrl(ctx: StrategyContext, auth: AuthDetails): URL {
		if (!auth.gcpProject) throw new Error("Internal Error: Vertex AI requires a GCP Project ID.");
		const location = GCP_DEFAULT_LOCATION;
		const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
		const targetPath = ctx.downstreamPath.startsWith('/v1/') ? ctx.downstreamPath.slice(3) : ctx.downstreamPath;
		const url = new URL(`https://${host}/v1/projects/${auth.gcpProject}/locations/${location}/endpoints/openapi${targetPath}`);
		ctx.originalUrl.searchParams.forEach((val, key) => key.toLowerCase() !== 'key' && url.searchParams.set(key, val));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, auth: AuthDetails): Headers {
		if (!auth.gcpToken) throw new Error("Internal Error: Vertex AI requires a GCP Token.");
		const headers = createProxyHeaders(ctx.originalRequest.headers);
		headers.delete(HTTP_HEADER.AUTHORIZATION);
		headers.set(HTTP_HEADER.AUTHORIZATION, `Bearer ${auth.gcpToken}`);
		return headers;
	}
	processRequestBody(ctx: StrategyContext): BodyInit | null {
		return ctx.originalBodyBuffer;
	}
}

class GeminiOpenAIStrategy implements RequestHandlerStrategy {
	getAuthDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthDetails> {
		const modelName = ctx.parsedBody?.model ?? null;
		return Promise.resolve(resolveGeminiAuthDetails(c, modelName, attempt, "Gemini OpenAI-Compat"));
	}
	buildTargetUrl(ctx: StrategyContext, _auth: AuthDetails): URL {
		const baseUrl = API_MAPPINGS['/gemini'];
		const url = new URL(`/v1beta/openai${ctx.downstreamPath}`, baseUrl);
		ctx.originalUrl.searchParams.forEach((val, key) => key.toLowerCase() !== 'key' && url.searchParams.set(key, val));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, auth: AuthDetails): Headers {
		const headers = createProxyHeaders(ctx.originalRequest.headers);
		[HTTP_HEADER.AUTHORIZATION, HTTP_HEADER.X_GOOG_API_KEY].forEach(h => headers.delete(h));
		if (auth.key) headers.set(HTTP_HEADER.AUTHORIZATION, `Bearer ${auth.key}`);
		return headers;
	}
	processRequestBody(ctx: StrategyContext): BodyInit | null { return ctx.originalBodyBuffer; }
	async handleResponse(response: Response, ctx: StrategyContext): Promise<Response> {
		if (!ctx.downstreamPath.endsWith('/models') || !response.headers.get(HTTP_HEADER.CONTENT_TYPE)?.includes("application/json")) {
			return response;
		}
		const body = await response.json();
		if (body?.data?.length) {
			body.data.forEach((model: any) => { if (model?.id?.startsWith('models/')) model.id = model.id.slice(7); });
			const newBody = JSON.stringify(body);
			const newHeaders = new Headers(response.headers);
			newHeaders.set(HTTP_HEADER.CONTENT_LENGTH, String(new TextEncoder().encode(newBody).byteLength));
			return new Response(newBody, { status: response.status, statusText: response.statusText, headers: newHeaders });
		}
		return new Response(JSON.stringify(body), response);
	}
}

class GeminiNativeStrategy implements RequestHandlerStrategy {
	getAuthDetails(c: Context, ctx: StrategyContext, attempt: number): Promise<AuthDetails> {
		const modelName = ctx.downstreamPath.match(/\/models\/([^:]+):/)?.[1] ?? null;
		return Promise.resolve(resolveGeminiAuthDetails(c, modelName, attempt, "Gemini Native"));
	}
	buildTargetUrl(ctx: StrategyContext, auth: AuthDetails): URL {
		if (!auth.key) throw new Error("Internal Error: Gemini Native strategy requires an API Key.");
		const baseUrl = API_MAPPINGS['/gemini'];
		const url = new URL(ctx.downstreamPath, baseUrl);
		ctx.originalUrl.searchParams.forEach((val, key) => key.toLowerCase() !== 'key' && url.searchParams.set(key, val));
		url.searchParams.set('key', auth.key);
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, _auth: AuthDetails): Headers {
		const headers = createProxyHeaders(ctx.originalRequest.headers);
		[HTTP_HEADER.AUTHORIZATION, HTTP_HEADER.X_GOOG_API_KEY].forEach(h => headers.delete(h));
		return headers;
	}
	processRequestBody(ctx: StrategyContext): BodyInit | null { return ctx.originalBodyBuffer; }
}

class GenericProxyStrategy implements RequestHandlerStrategy {
	getAuthDetails(): Promise<AuthDetails> {
		return Promise.resolve({ key: null, source: null, gcpToken: null, gcpProject: null, maxRetries: 1 });
	}
	buildTargetUrl(ctx: StrategyContext, _auth: AuthDetails): URL {
		const baseUrl = API_MAPPINGS[ctx.routePrefix];
        if (!baseUrl) throw new Response(`Proxy target for prefix '${ctx.routePrefix}' not configured.`, { status: 501 });
		const url = new URL(ctx.downstreamPath, baseUrl);
		ctx.originalUrl.searchParams.forEach((val, key) => url.searchParams.set(key, val));
		return url;
	}
	buildRequestHeaders(ctx: StrategyContext, _auth: AuthDetails): Headers { return createProxyHeaders(ctx.originalRequest.headers); }
	processRequestBody(ctx: StrategyContext): BodyInit | null { return ctx.originalBodyBuffer; }
}

// --- 策略选择与主处理函数 ---

type RouteResult = {
    requestType: RequestStrategyType;
    routePrefix: string;
    downstreamPath: string;
    parsedBody: any | null;
}

/** 根据请求路径决定使用哪种路由策略 */
const routeByPath = (req: Request, originalBodyBuffer: ArrayBuffer | null): RouteResult => {
	const { pathname } = new URL(req.url);

	const parseBodyIfNeeded = (): any | null => {
		if (originalBodyBuffer && req.method !== 'GET' && req.method !== 'HEAD') {
			try { return JSON.parse(new TextDecoder().decode(originalBodyBuffer)); } catch { /* ignore */ }
		}
		return null;
	};

	if (pathname.startsWith('/vertex/')) {
		return { requestType: RequestStrategyType.VERTEX_AI, routePrefix: '/vertex', downstreamPath: pathname.slice(7), parsedBody: parseBodyIfNeeded() };
	}
	if (pathname.startsWith('/gemini/')) {
        const downstreamPath = pathname.slice(7);
		const requestType = downstreamPath.startsWith('/v1beta/') ? RequestStrategyType.GEMINI_NATIVE : RequestStrategyType.GEMINI_OPENAI;
		return { requestType, routePrefix: '/gemini', downstreamPath, parsedBody: parseBodyIfNeeded() };
	}
	const customPrefixes = Object.keys(API_MAPPINGS).filter(p => p !== '/gemini' && p !== '/vertex');
	const matchedPrefix = customPrefixes.filter(p => pathname.startsWith(p)).sort((a, b) => b.length - a.length)[0] || null;
	if (matchedPrefix) {
		return { requestType: RequestStrategyType.GENERIC_PROXY, routePrefix: matchedPrefix, downstreamPath: pathname.slice(matchedPrefix.length), parsedBody: parseBodyIfNeeded() };
	}
	return { requestType: RequestStrategyType.UNKNOWN, routePrefix: '', downstreamPath: pathname, parsedBody: null };
};

const getStrategy = (type: RequestStrategyType): RequestHandlerStrategy => {
	switch (type) {
		case RequestStrategyType.VERTEX_AI: return new VertexAIStrategy();
		case RequestStrategyType.GEMINI_OPENAI: return new GeminiOpenAIStrategy();
		case RequestStrategyType.GEMINI_NATIVE: return new GeminiNativeStrategy();
		case RequestStrategyType.GENERIC_PROXY: return new GenericProxyStrategy();
		default: throw new Error(`Unsupported request type: ${RequestStrategyType[type]}`);
	}
};

/** 主代理请求处理函数 */
export const handleProxyRequest = async (c: Context): Promise<Response> => {
	const { req } = c;
	const bodyBuffer = (req.raw.body && req.method !== 'GET' && req.method !== 'HEAD') ? await req.raw.clone().arrayBuffer() : null;
	const route = routeByPath(req.raw, bodyBuffer);

	if (route.requestType === RequestStrategyType.UNKNOWN) {
		return new Response(`No proxy route configured for path: ${req.url}`, { status: 404 });
	}

	const strategy = getStrategy(route.requestType);
	const context: StrategyContext = { 
        originalUrl: new URL(req.url), 
        originalRequest: req.raw, 
        downstreamPath: route.downstreamPath,
        routePrefix: route.routePrefix,
        parsedBody: route.parsedBody,
        originalBodyBuffer: bodyBuffer,
    };

	let attempts = 0;
	let maxRetries = 1;
	let lastError: Response | Error | null = null;

	while (attempts < maxRetries) {
		attempts++;
		try {
			const authDetails = await strategy.getAuthDetails(c, context, attempts);
			if (attempts === 1) maxRetries = authDetails.maxRetries;

			const targetUrl = strategy.buildTargetUrl(context, authDetails);
			const targetHeaders = strategy.buildRequestHeaders(context, authDetails);
			const targetBody = await Promise.resolve(strategy.processRequestBody(context));

			const proxyResponse = await fetch(targetUrl, { method: req.method, headers: targetHeaders, body: targetBody, redirect: 'manual' });

			if (proxyResponse.ok) {
				return strategy.handleResponse ? await strategy.handleResponse(proxyResponse, context) : proxyResponse;
			}
            
			lastError = proxyResponse.clone();
            const responseBodyText = await lastError.text();
			console.error(`Attempt ${attempts}/${maxRetries} failed for ${RequestStrategyType[route.requestType]} to ${targetUrl}: ${lastError.status}`, responseBodyText);
            await proxyResponse.body?.cancel();

		} catch (error) {
			lastError = error instanceof Response ? error.clone() : error as Error;
			console.error(`Attempt ${attempts}/${maxRetries} caught an exception during ${RequestStrategyType[route.requestType]} processing:`, error);
		}
	}
    
	if (lastError instanceof Response) return lastError;
	const errorMessage = lastError instanceof Error ? lastError.message : "Request processing failed after maximum retries.";
	return new Response(errorMessage, { status: 502 });
};