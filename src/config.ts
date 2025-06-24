import { GcpCredentials, parseCreds as gcpCredsParser } from "./services.ts";

// --- 常量定义 ---
const CACHE_NAME = "llm-gateway-cache-v1";
export const KV_NOT_FOUND = Symbol("KV_NOT_FOUND"); // 用于标识KV中未找到键

// --- KV 实例管理 (懒加载) ---
let kv: Deno.Kv | null = null;
/** [懒加载] 确保并返回 Deno KV 实例 */
export async function ensureKv(): Promise<Deno.Kv> {
	if (!kv) {
		kv = await Deno.openKv();
	}
	return kv;
}

// --- Edge Cache 实例管理 (懒加载) ---
let edgeCache: Cache | null = null;
/** [懒加载] 确保并返回 Edge Cache 实例 */
async function getEdgeCache(): Promise<Cache> {
	if (!edgeCache) {
		edgeCache = await caches.open(CACHE_NAME);
	}
	return edgeCache;
}

// --- 配置项统一定义 ---
/**
 * 定义所有配置项的元数据，包括：
 * - key: 缓存和内部使用的唯一标识
 * - kvKey: Deno KV 中对应的键 (Deno.KvKey)
 * - envVar: 对应的环境变量名
 * - parser: 从环境变量（字符串）解析数据的函数
 */
export const ConfigKeys = {
	ADMIN_PASSWORD_HASH: { key: "admin_password_hash", kvKey: ["admin_password_hash"], envVar: "ADMIN_PASSWORD_HASH", parser: (v: string) => v },
	TRIGGER_KEYS: { key: "trigger_keys", kvKey: ["trigger_keys"], envVar: "TRIGGER_KEYS", parser: (v: string) => JSON.parse(v) },
	POOL_KEYS: { key: "pool_keys", kvKey: ["pool_keys"], envVar: "POOL_KEYS", parser: (v: string) => JSON.parse(v) },
	FALLBACK_KEY: { key: "fallback_key", kvKey: ["fallback_key"], envVar: "FALLBACK_KEY", parser: (v: string) => v },
	FALLBACK_MODELS: { key: "fallback_models", kvKey: ["fallback_models"], envVar: "FALLBACK_MODELS", parser: (v: string) => JSON.parse(v) },
	API_RETRY_LIMIT: { key: "api_retry_limit", kvKey: ["api_retry_limit"], envVar: "API_RETRY_LIMIT", parser: (v: string) => parseInt(v, 10) },
	API_MAPPINGS: { key: "api_mappings", kvKey: ["api_mappings"], envVar: "API_MAPPINGS", parser: (v: string) => JSON.parse(v) },
	GCP_CREDENTIALS_STRING: { key: "gcp_credentials_string", kvKey: ["gcp_credentials_string"], envVar: "GCP_CREDENTIALS_STRING", parser: (v: string) => v },
	GCP_DEFAULT_LOCATION: { key: "gcp_default_location", kvKey: ["gcp_default_location"], envVar: "GCP_DEFAULT_LOCATION", parser: (v: string) => v },
	VERTEX_MODELS: { key: "vertex_models", kvKey: ["vertex_models"], envVar: "VERTEX_MODELS", parser: (v: string) => JSON.parse(v) },
	GCP_AUTH_TOKEN_PREFIX: { key: "gcp_auth_token_", kvKey: [], envVar: "", parser: (v:string) => v} // 特殊：用于GCP Token缓存，无KV/Env对应
};

type ConfigKeyMeta = typeof ConfigKeys[keyof typeof ConfigKeys];

// --- 核心数据读写函数 ---

/**
 * [核心] 从【环境变量 -> Edge Cache -> Deno KV】三级获取配置值
 * @param keyMeta 配置项元数据，来自 `ConfigKeys`
 * @param defaultValue 如果所有来源都找不到值，返回此默认值
 * @returns 配置值
 */
export async function getConfig<T>(keyMeta: ConfigKeyMeta, defaultValue: T): Promise<T> {
	// 1. 尝试从环境变量读取
	if (keyMeta.envVar) {
		const envValue = Deno.env.get(keyMeta.envVar);
		if (envValue) {
			try {
				return keyMeta.parser(envValue) as T;
			} catch (e) {
				console.warn(`[Config] Failed to parse env var ${keyMeta.envVar}:`, e);
			}
		}
	}

	// 2. 尝试从 Edge Cache 读取
	try {
		const cache = await getEdgeCache();
		const req = new Request(`http://cache.internal/${keyMeta.key}`);
		const res = await cache.match(req);
		if (res && res.ok) {
			const data = await res.json();
			return data ?? defaultValue; // 如果缓存中存的是 null，也使用默认值
		}
	} catch (e) {
		console.error(`[Config] Error reading from Edge Cache for key "${keyMeta.key}":`, e);
	}

	// 3. 回退到 Deno KV 读取
	try {
		const kv = await ensureKv();
		const kvRes = await kv.get<T>(keyMeta.kvKey);
		const value = kvRes.value ?? defaultValue;

		// 将从 KV 读取到的值写回缓存，供下次使用
		await setCacheValue(keyMeta.key, value);
		return value;
	} catch (e) {
		console.error(`[Config] Error reading from KV for key "${keyMeta.key.toString()}":`, e);
	}

	return defaultValue;
}


/**
 * [核心] 将值写入 Deno KV 并同步更新 Edge Cache (Write-Through)
 * @param keyMeta 配置项元数据
 * @param value 要设置的值
 */
export async function setConfig<T>(keyMeta: ConfigKeyMeta, value: T): Promise<void> {
	// 1. 写入 KV
	const kv = await ensureKv();
	if (value === null || value === undefined || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && value !== null && Object.keys(value).length === 0)) {
		await kv.delete(keyMeta.kvKey);
	} else {
		await kv.set(keyMeta.kvKey, value);
	}
	// 2. 更新缓存
	await setCacheValue(keyMeta.key, value);
}

/**
 * 将值存入 Edge Cache。
 * @param cacheKey 缓存键 (string)
 * @param value 要缓存的值
 * @param ttlSeconds 可选的 TTL (秒)
 */
export async function setCacheValue(cacheKey: string, value: any, ttlSeconds?: number): Promise<void> {
	try {
		const cache = await getEdgeCache();
		const headers = new Headers({ 'Content-Type': 'application/json' });
		if (ttlSeconds && ttlSeconds > 0) {
			headers.set('Cache-Control', `max-age=${ttlSeconds}`);
		}
		const request = new Request(`http://cache.internal/${encodeURIComponent(cacheKey)}`);
		const body = JSON.stringify(value);
		const response = new Response(body, { headers });
		await cache.put(request, response);
	} catch (error) {
		console.error(`[Cache] Error setting value for key "${cacheKey}":`, error);
	}
}

/**
 * 直接从 Edge Cache 获取值，不回退到 KV。主要用于 GCP Token 这种只存在于缓存的场景。
 * @param cacheKey 缓存键
 * @returns 缓存中的值或 null
 */
export async function getCacheValue<T>(cacheKey: string): Promise<T | null> {
    try {
        const cache = await getEdgeCache();
        const req = new Request(`http://cache.internal/${cacheKey}`);
        const res = await cache.match(req);
        if (res && res.ok) {
            return await res.json() as T;
        }
    } catch (e) {
        console.error(`[Cache] Error directly getting value for key "${cacheKey}":`, e);
    }
    return null;
}


/**
 * [管理专用] 直接从 KV 读取值，绕过缓存。用于管理界面需要最新数据的场景。
 * @param kvKey Deno.KvKey
 * @returns 值，或 KV_NOT_FOUND
 */
export async function getKvValueDirectly<T>(kvKey: Deno.KvKey): Promise<T | null | typeof KV_NOT_FOUND> {
	const kv = await ensureKv();
	const result = await kv.get<T>(kvKey);
	return result.versionstamp === null ? KV_NOT_FOUND : result.value;
}

/**
 * 将所有在 ConfigKeys 中定义的配置从 KV 加载到 Edge Cache。
 * 用于服务启动和定时刷新。
 */
export async function loadAllConfigsToCache(): Promise<void> {
	console.log("[Config] Starting KV config preloading to Edge Cache...");
	const kv = await ensureKv();
	const preloadKvKeys = Object.values(ConfigKeys)
		.filter(meta => meta.kvKey.length > 0)
		.map(meta => meta.kvKey);

	const results = await kv.getMany<any[]>(preloadKvKeys);
	const cachePromises = results.map((entry, index) => {
		const cacheKey = Object.values(ConfigKeys).find(m => String(m.kvKey) === String(entry.key))!.key;
		return setCacheValue(cacheKey, entry.value);
	});

	await Promise.all(cachePromises);
	console.log(`[Config] Preloaded ${cachePromises.length} KV configs to Edge Cache.`);
}

/**
 * 解析GCP凭证字符串。
 * @param jsonStr 凭证字符串
 * @returns GcpCredentials 数组
 */
export function parseGcpCredentials(jsonStr: string): GcpCredentials[] {
    return gcpCredsParser(jsonStr);
}