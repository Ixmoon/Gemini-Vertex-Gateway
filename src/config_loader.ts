/**
 * L1 - 数据加载层
 * 负责直接与数据源（环境变量、Edge Cache、Deno KV）交互。
 * 优先级: 环境变量 > Edge Cache > Deno KV
 */

// --- 缓存与KV实例管理 ---
const CACHE_NAME = "llm-gateway-cache-v2";
let edgeCache: Cache | null = null;
let kv: Deno.Kv | null = null;

/** [内部] 确保 Deno KV 实例已初始化 (异步，懒加载) */
async function ensureKv(): Promise<Deno.Kv> {
	if (!kv) {
		try {
			kv = await Deno.openKv();
		} catch (error) {
			console.error("Fatal: Failed to open Deno KV store:", error);
			throw error;
		}
	}
	return kv;
}

/** [内部] 确保 Edge Cache 实例已初始化 */
async function getEdgeCache(): Promise<Cache> {
	if (!edgeCache) {
		try {
			edgeCache = await caches.open(CACHE_NAME);
		} catch (error) {
			console.error("Fatal: Failed to open Edge Cache:", error);
			throw new Error(`Failed to open Edge Cache: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return edgeCache;
}

// --- 配置键常量 ---
// 定义所有配置项的键，用于环境变量、缓存和KV
export const CONFIG_KEYS = {
	ADMIN_PASSWORD_HASH: { env: "LLM_GW_ADMIN_PASSWORD_HASH", cache: "admin_password_hash", kv: ["admin_password_hash"] },
	TRIGGER_KEYS: { env: "LLM_GW_TRIGGER_KEYS_JSON", cache: "trigger_keys", kv: ["trigger_keys"] },
	POOL_KEYS: { env: "LLM_GW_POOL_KEYS_JSON", cache: "pool_keys", kv: ["pool_keys"] },
	FALLBACK_KEY: { env: "LLM_GW_FALLBACK_KEY", cache: "fallback_key", kv: ["fallback_key"] },
	FALLBACK_MODELS: { env: "LLM_GW_FALLBACK_MODELS_JSON", cache: "fallback_models", kv: ["fallback_models"] },
	API_RETRY_LIMIT: { env: "LLM_GW_API_RETRY_LIMIT", cache: "api_retry_limit", kv: ["api_retry_limit"] },
	API_MAPPINGS: { env: "LLM_GW_API_MAPPINGS_JSON", cache: "api_mappings", kv: ["api_mappings"] },
	GCP_CREDENTIALS: { env: "LLM_GW_GCP_CREDENTIALS_JSON", cache: "gcp_credentials_string", kv: ["gcp_credentials_string"] },
	GCP_DEFAULT_LOCATION: { env: "LLM_GW_GCP_DEFAULT_LOCATION", cache: "gcp_default_location", kv: ["gcp_default_location"] },
	// GCP Auth Token 是特殊缓存，不从KV或ENV加载，有自己的TTL
	GCP_AUTH_TOKEN_PREFIX: { cache: "gcp_auth_token_" },
};

// --- [FIX] 类型定义与类型守卫 ---
type ConfigKeyShape = { env?: string; cache: string; kv?: Deno.KvKey };
interface KvBackedConfigKey extends ConfigKeyShape { kv: Deno.KvKey };

/** [FIX] 类型守卫，用于判断配置项是否有KV后端 */
function isKvBacked(config: ConfigKeyShape): config is KvBackedConfigKey {
	return Array.isArray(config.kv);
}


// --- 核心数据读写函数 ---

/**
 * [核心] 从最高优先级的数据源（环境变量 -> Edge Cache -> KV）获取配置值。
 * @param keyConfig 配置键对象，例如 CONFIG_KEYS.POOL_KEYS
 * @param parser 用于解析从环境变量或缓存中读取的字符串值的函数
 * @param defaultValue 如果所有源都找不到值，则返回此默认值
 * @returns 解析后的配置值
 */
export async function getConfig<T>(
	keyConfig: ConfigKeyShape,
	parser: (value: any) => T | null,
	defaultValue: T
): Promise<T> {
	// 1. 尝试从环境变量读取
	if (keyConfig.env) {
		const envValue = Deno.env.get(keyConfig.env);
		if (envValue !== undefined) {
			const parsed = parser(envValue);
			if (parsed !== null) return parsed;
		}
	}

	// 2. 尝试从 Edge Cache 读取
	try {
		const cache = await getEdgeCache();
		const request = new Request(`http://cache.internal/${keyConfig.cache}`);
		const cachedResponse = await cache.match(request);
		if (cachedResponse) {
			const data = await cachedResponse.json().catch(() => null);
			const parsed = parser(data);
			if (parsed !== null) return parsed;
		}
	} catch (e) {
		console.error(`[ConfigLoader] Error reading from cache for key "${keyConfig.cache}":`, e);
	}

	// 3. 尝试从 Deno KV 读取 (如果提供了kv key)
	if (isKvBacked(keyConfig)) { // [FIX] 使用类型守卫
		try {
			const kv = await ensureKv();
			const kvResult = await kv.get(keyConfig.kv);
			if (kvResult.value !== null && kvResult.value !== undefined) {
				const parsed = parser(kvResult.value);
				if (parsed !== null) {
					// KV命中，回写到缓存
					await setCacheValue(keyConfig.cache, kvResult.value);
					return parsed;
				}
			}
		} catch (e) {
			console.error(`[ConfigLoader] Error reading from KV for key "${keyConfig.kv.join('_')}":`, e);
		}
	}

	// 4. 所有源都未命中，返回默认值
	return defaultValue;
}

/**
 * [核心] 将配置值写入持久层（KV）并更新缓存（Write-Through）。
 * @param keyConfig 配置键对象
 * @param value 要设置的值
 */
export async function setConfig<T>(keyConfig: KvBackedConfigKey, value: T): Promise<void> {
	try {
		// 1. 写入 KV
		const kv = await ensureKv();
		await kv.set(keyConfig.kv, value);

		// 2. 写入/更新 Edge Cache
		await setCacheValue(keyConfig.cache, value);
	} catch (e) {
		console.error(`[ConfigLoader] Failed to set config for key "${keyConfig.cache}":`, e);
		throw e; // 抛出错误让上层处理
	}
}

/**
 * [核心] 从持久层（KV）删除一个键，并使缓存失效。
 * @param keyConfig 配置键对象
 */
export async function deleteConfig(keyConfig: KvBackedConfigKey): Promise<void> {
	try {
		// 1. 从 KV 删除
		const kv = await ensureKv();
		await kv.delete(keyConfig.kv);

		// 2. 从缓存删除
		const cache = await getEdgeCache();
		const request = new Request(`http://cache.internal/${keyConfig.cache}`);
		await cache.delete(request);
	} catch (e) {
		console.error(`[ConfigLoader] Failed to delete config for key "${keyConfig.cache}":`, e);
		throw e;
	}
}

/**
 * [核心] 将值存入 Edge Cache。
 * @param cacheKey 缓存键 (string)
 * @param value 要缓存的值 (会被 JSON.stringify)
 * @param ttlSeconds 可选的 TTL (秒)，用于设置 Cache-Control max-age
 */
export async function setCacheValue(cacheKey: string, value: any, ttlSeconds?: number): Promise<void> {
	try {
		const cache = await getEdgeCache();
		const headers = new Headers({ 'Content-Type': 'application/json' });
		if (ttlSeconds && ttlSeconds > 0) {
			headers.set('Cache-Control', `max-age=${ttlSeconds}`);
		}
		const request = new Request(`http://cache.internal/${cacheKey}`);
		const body = JSON.stringify(value === undefined ? null : value);
		const response = new Response(body, { headers });
		await cache.put(request, response);
	} catch (error) {
		console.error(`[ConfigLoader] Error setting Edge Cache for key "${cacheKey}":`, error);
	}
}

/**
 * [核心] 从 Edge Cache 获取值。
 * @param cacheKey 缓存键 (string)
 * @returns 缓存的响应对象或 null
 */
export async function getCacheValue(cacheKey: string): Promise<Response | null> {
	try {
		const cache = await getEdgeCache();
		const request = new Request(`http://cache.internal/${cacheKey}`);
		const cachedResponse = await cache.match(request);
		return cachedResponse ?? null;
	} catch (error) {
		console.error(`[ConfigLoader] Error getting Edge Cache for key "${cacheKey}":`, error);
		return null;
	}
}

/**
 * [启动] 将所有配置从KV预加载到缓存中，以优化冷启动后的首次请求。
 * 只在缓存未命中时执行，避免不必要的KV读取。
 */
export async function warmUpCache(): Promise<void> {
	console.log("[CacheWarmer] Starting cache warm-up...");
	// [FIX] 使用类型守卫过滤，确保 allConfigKeys 数组内元素的类型被正确推断
	const allConfigKeys = Object.values(CONFIG_KEYS).filter(isKvBacked);

	const warmUpPromises = allConfigKeys.map(async (keyConfig) => {
		// 检查缓存中是否已有值
		const cached = await getCacheValue(keyConfig.cache);
		if (!cached) {
			// 仅在缓存未命中时才从KV读取并填充
			try {
				const kv = await ensureKv();
				const kvResult = await kv.get(keyConfig.kv); // keyConfig.kv is now safe to access
				if (kvResult.value !== null && kvResult.value !== undefined) {
					await setCacheValue(keyConfig.cache, kvResult.value);
				}
			} catch (e) {
				console.error(`[CacheWarmer] Failed to warm up key "${keyConfig.cache}":`, e);
			}
		}
	});

	await Promise.all(warmUpPromises);
	console.log("[CacheWarmer] Cache warm-up finished.");
}