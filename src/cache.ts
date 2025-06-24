/**
 * @file 数据源层 (Data Source Layer)
 * @description
 * 这是重构后的第一层抽象，负责所有配置的读取和缓存管理。
 * 它实现了 "环境变量 -> Edge Cache -> Deno KV" 的三级降级读取策略，
 * 并对外提供统一、高效的数据访问接口。
 */
import {
	ensureKv,
	parseCreds,
	GcpCredentials,
	getKvValueDirectly,
	KV_NOT_FOUND,
	ADMIN_PASSWORD_HASH_KEY,
	TRIGGER_KEYS_KEY,
	POOL_KEYS_KEY,
	FALLBACK_KEY_KEY,
	FALLBACK_MODELS_KEY,
	API_RETRY_LIMIT_KEY,
	API_MAPPINGS_KEY,
	GCP_CREDENTIALS_STRING_KEY,
	GCP_DEFAULT_LOCATION_KEY,
	VERTEX_MODELS_KEY,
} from "./replacekeys.ts";

// --- Edge Cache 实例管理 ---
const CACHE_NAME = "llm-gateway-config-cache";
let edgeCache: Cache | null = null;

/** 获取 Edge Cache 实例 (惰性初始化) */
export async function getEdgeCache(): Promise<Cache> {
	if (!edgeCache) {
		try {
			edgeCache = await caches.open(CACHE_NAME);
		} catch (error) {
			console.error(`Failed to open Edge Cache "${CACHE_NAME}":`, error);
			throw new Error(`Failed to open Edge Cache: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return edgeCache;
}

// --- 缓存键与环境变量名映射 ---
// 集中管理，便于维护
export const CACHE_KEYS = {
	ADMIN_PASSWORD_HASH: "admin_password_hash",
	TRIGGER_KEYS: "trigger_keys",
	POOL_KEYS: "pool_keys",
	FALLBACK_KEY: "fallback_key",
	FALLBACK_MODELS: "fallback_models",
	API_RETRY_LIMIT: "api_retry_limit",
	API_MAPPINGS: "api_mappings",
	GCP_CREDENTIALS_STRING: "gcp_credentials_string",
	GCP_DEFAULT_LOCATION: "gcp_default_location",
	VERTEX_MODELS: "vertex_models",
	GCP_AUTH_TOKEN_PREFIX: "gcp_auth_token_", // 用于缓存 GCP Token 的前缀
};

const ENV_VARS = {
	[CACHE_KEYS.TRIGGER_KEYS]: "LLM_GATEWAY_TRIGGER_KEYS",
	[CACHE_KEYS.POOL_KEYS]: "LLM_GATEWAY_POOL_KEYS",
	[CACHE_KEYS.FALLBACK_KEY]: "LLM_GATEWAY_FALLBACK_KEY",
	// ...可以按需添加更多环境变量映射
};

// --- 所有需要从 KV 预加载的键 ---
const PRELOAD_KV_KEYS: Deno.KvKey[] = [
	ADMIN_PASSWORD_HASH_KEY, TRIGGER_KEYS_KEY, POOL_KEYS_KEY, FALLBACK_KEY_KEY,
	FALLBACK_MODELS_KEY, API_RETRY_LIMIT_KEY, API_MAPPINGS_KEY,
	GCP_CREDENTIALS_STRING_KEY, GCP_DEFAULT_LOCATION_KEY, VERTEX_MODELS_KEY,
];

// --- 核心缓存读写函数 ---

/**
 * [内部] 将值存入 Edge Cache。
 * @param cacheKey 缓存键 (string)
 * @param value 要缓存的值，会被 JSON 序列化
 * @param ttlSeconds 可选的 TTL (秒)，用于设置 Cache-Control 头
 */
export async function setEdgeCacheValue(cacheKey: string, value: any, ttlSeconds?: number): Promise<void> {
	try {
		const cache = await getEdgeCache();
		const headers = new Headers({ 'Content-Type': 'application/json' });
		if (ttlSeconds && ttlSeconds > 0) {
			headers.set('Cache-Control', `max-age=${ttlSeconds}`);
		}
		const request = new Request(`http://cache.internal/${encodeURIComponent(cacheKey)}`);
		// 将 undefined 转换为 null，因为 JSON 不支持 undefined
		const body = JSON.stringify(value === undefined ? null : value);
		const response = new Response(body, { headers });
		await cache.put(request, response);
	} catch (error) {
		console.error(`Error setting Edge Cache for key "${cacheKey}":`, error);
	}
}

/**
 * [内部] 尝试从环境变量中获取和解析值。
 */
function _getEnvValue(cacheKey: string): any | undefined {
	const envVarName = ENV_VARS[cacheKey];
	if (!envVarName) return undefined;

	const value = Deno.env.get(envVarName);
	if (value === undefined) return undefined;

	// 尝试解析为 JSON，如果失败则返回原始字符串
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/**
 * [核心] 从数据源获取配置值（三级降级策略）。
 * 这是所有读取操作的统一入口，封装了复杂的读取逻辑。
 * 1. 尝试从环境变量读取。
 * 2. 如果失败，尝试从 Edge Cache 读取。
 * 3. 如果再次失败，回退到从 Deno KV 读取。
 * 4. 从 KV 读取成功后，会回填到 Edge Cache 中。
 * @param cacheKey 缓存键 (e.g., "trigger_keys")
 * @returns 解析后的值，如果所有源都失败则返回 null。
 */
export async function getConfigValue<T>(cacheKey: string): Promise<T | null> {
	// 1. 尝试从环境变量获取
	const envValue = _getEnvValue(cacheKey);
	if (envValue !== undefined) {
		return envValue as T | null;
	}

	// 2. 尝试从 Edge Cache 获取
	try {
		const cache = await getEdgeCache();
		const request = new Request(`http://cache.internal/${encodeURIComponent(cacheKey)}`);
		const cachedResponse = await cache.match(request);

		if (cachedResponse) {
			try {
				const data = JSON.parse(await cachedResponse.text() || 'null');
				return data as T | null;
			} catch (parseError) {
				console.warn(`[Cache] Key "${cacheKey}" hit but failed to parse. Falling back.`, parseError);
			}
		}
	} catch (cacheError) {
		console.error(`[Cache] Error accessing Edge Cache for key "${cacheKey}". Falling back.`, cacheError);
	}

	// 3. 回退到从 Deno KV 读取
	try {
		const kvKey: Deno.KvKey = cacheKey.split('_');
		const kvResult = await getKvValueDirectly<T>(kvKey);

		if (kvResult !== KV_NOT_FOUND) {
			// KV 读取成功，回填到缓存
			setEdgeCacheValue(cacheKey, kvResult).catch(err => {
				console.error(`[Cache] Error updating cache after KV fallback for "${cacheKey}":`, err);
			});
			return kvResult;
		} else {
			// KV 中也不存在
			return null;
		}
	} catch (kvError) {
		console.error(`[Cache] Error during KV fallback for "${cacheKey}":`, kvError);
		return null;
	}
}

/**
 * [核心] 并行加载所有指定的 KV 配置到 Edge Cache 中。
 * 用于服务启动和定时任务，以预热缓存。
 */
export async function loadAndCacheAllKvConfigs(): Promise<void> {
	try {
		const kv = await ensureKv();
		// 使用 getMany 实现高效的批量读取
		const results = await kv.getMany<any>(PRELOAD_KV_KEYS);
		const cachePromises = results.map((entry, index) => {
			const kvKey = PRELOAD_KV_KEYS[index];
			const cacheKey = kvKey.join('_');
			// 直接将从 KV 获取的值 (包括 null) 写入缓存
			return setEdgeCacheValue(cacheKey, entry.value);
		});
		await Promise.all(cachePromises);
	} catch (error) {
		console.error("Error during KV config preloading to Edge Cache:", error);
		throw error; // 抛出错误以便上层捕获
	}
}

/**
 * [核心] 从 KV 重新加载单个配置项并更新 Edge Cache。
 * 当通过管理 API 修改配置时调用，实现 "Write-Through"。
 * @param kvKey Deno.KvKey (e.g., ["trigger_keys"])
 */
export async function reloadKvConfig(kvKey: Deno.KvKey): Promise<void> {
	const cacheKey = kvKey.join('_');
	try {
		const kv = await ensureKv();
		const result = await kv.get<any>(kvKey);
		await setEdgeCacheValue(cacheKey, result.value); // 将最新值 (或 null) 更新到缓存
	} catch (error) {
		console.error(`Error reloading KV config to Edge Cache for "${cacheKey}":`, error);
	}
}

/**
 * [核心] 读取并解析 GCP 凭证字符串 (从缓存/KV)。
 * @returns 解析后的 GcpCredentials 数组。
 */
export async function getParsedGcpCredentials(): Promise<GcpCredentials[]> {
	const jsonStr = await getConfigValue<string>(CACHE_KEYS.GCP_CREDENTIALS_STRING);
	if (!jsonStr) {
		return [];
	}
	try {
		const creds = parseCreds(jsonStr);
		if (creds.length === 0) {
			console.warn("Parsed GCP credentials string resulted in zero valid credentials.");
		}
		return creds;
	} catch (e) {
		console.error("Failed to parse GCP credentials string:", e);
		return [];
	}
}