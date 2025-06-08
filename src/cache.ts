import {
	ensureKv, // 确保 kv 实例存在
	parseCreds, // 解析 GCP 凭证 (保持)
	GcpCredentials, // GCP 凭证类型 (保持)
	getKvValueDirectly, // [新增] 直接从 KV 读取值的函数
	KV_NOT_FOUND, // [新增] 导入表示 KV 未找到的 Symbol
} from "./replacekeys.ts"; // 从 replacekeys 导入常量和类型

// --- Edge Cache 实例 ---
const CACHE_NAME = "llm-gateway-cache";
let edgeCache: Cache | null = null;

// 获取 Edge Cache 实例 (惰性初始化)
export async function getEdgeCache(): Promise<Cache> {
	if (!edgeCache) {
		try {
			edgeCache = await caches.open(CACHE_NAME);
			// console.log(`Edge Cache "${CACHE_NAME}" opened successfully.`); // 减少日志噪音
		} catch (error) {
			console.error(`Failed to open Edge Cache "${CACHE_NAME}":`, error);
			// 在无法打开缓存时抛出错误，以便调用者知道
			throw new Error(`Failed to open Edge Cache: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return edgeCache;
}

// --- 缓存键常量 (保持不变) ---
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
	GCP_AUTH_TOKEN_PREFIX: "gcp_auth_token_", // Prefix for storing tokens per client_email
};

// --- 所有需要预加载的 KV 键数组 (Deno.KvKey[]) (保持不变) ---
// 用于 loadAndCacheAllKvConfigs 从 KV 读取数据
const PRELOAD_KV_KEYS: Deno.KvKey[] = [
	["admin_password_hash"],
	["trigger_keys"],
	["pool_keys"],
	["fallback_key"],
	["fallback_models"],
	["api_retry_limit"],
	["api_mappings"],
	["gcp_credentials_string"],
	["gcp_default_location"],
	["vertex_models"],
];


/**
	* [内部] 将值存入 Edge Cache
	* @param cacheKey 缓存键 (string)
	* @param value 要缓存的值 (会被 JSON.stringify)。可以是 null 或 undefined。
	* @param ttlSeconds 可选的 TTL (秒)，用于设置 Cache-Control max-age
	*/
export async function setEdgeCacheValue(cacheKey: string, value: any, ttlSeconds?: number): Promise<void> {
	try {
		const cache = await getEdgeCache();
		const headers = new Headers({ 'Content-Type': 'application/json' });
		if (ttlSeconds && ttlSeconds > 0) {
			headers.set('Cache-Control', `max-age=${ttlSeconds}`);
		}
		const request = new Request(`http://cache.internal/${encodeURIComponent(cacheKey)}`);
		// 将 undefined 转换为 null 进行存储，因为 JSON 不支持 undefined
		const body = JSON.stringify(value === undefined ? null : value);
		const response = new Response(body, { headers });
		await cache.put(request, response);
		// console.log(`Edge Cache: Set value for key "${cacheKey}"`);
	} catch (error) {
		console.error(`Error setting Edge Cache for key "${cacheKey}":`, error);
	}
}

/**
	* [核心] 从 Edge Cache 获取配置值。
	* [重构] 从 Edge Cache 获取配置值，如果未命中、过期或无效，则回退到从 Deno KV 读取。
	* @param cacheKey 缓存键 (string, e.g., "trigger_keys")
	* @returns 解析后的值 (来自缓存或 KV)，如果两者都失败则返回 null。
	*/
export async function getConfigValue<T>(cacheKey: string): Promise<T | null> {
	// 1. 尝试从 Edge Cache 获取
	try {
		const cache = await getEdgeCache();
		const request = new Request(`http://cache.internal/${encodeURIComponent(cacheKey)}`);
		const cachedResponse = await cache.match(request);

		if (cachedResponse) {
			// 检查响应是否仍然有效（未过期） - Deno Deploy 的 Cache API 会自动处理 max-age
			// 我们只需要检查内容类型和解析
			const contentType = cachedResponse.headers.get('content-type');
			if (contentType && contentType.includes('application/json')) {
				const text = await cachedResponse.text();
				try {
					const data = JSON.parse(text || 'null'); // 空字符串解析为 null
					// console.log(`[getConfigValue:${cacheKey}] Cache Hit. Returning cached data.`);
					// 缓存命中且有效，直接返回
					return data as T | null;
				} catch (parseError) {
					console.warn(`[getConfigValue:${cacheKey}] Cache Hit but failed to parse JSON: ${parseError}. Falling back to KV.`);
					// 解析失败，视为缓存无效，继续执行 KV 回退
				}
			} else {
				console.warn(`[getConfigValue:${cacheKey}] Cache Hit but invalid Content-Type: ${contentType}. Falling back to KV.`);
				// 非 JSON 视为缓存无效，继续执行 KV 回退
			}
		} else {
			// console.log(`[getConfigValue:${cacheKey}] Cache Miss. Falling back to KV.`);
			// 缓存未命中，继续执行 KV 回退
		}
	} catch (cacheError) {
		console.error(`[getConfigValue:${cacheKey}] Error accessing Edge Cache: ${cacheError}. Falling back to KV.`);
		// 访问缓存出错，继续执行 KV 回退
	}

	// 2. 回退到从 Deno KV 读取
	console.log(`[getConfigValue:${cacheKey}] Attempting KV fallback...`);
	try {
		// 将 cacheKey (e.g., "trigger_keys") 转换回 Deno.KvKey (e.g., ["trigger_keys"])
		const kvKey: Deno.KvKey = cacheKey.split('_');
		const kvResult = await getKvValueDirectly<T>(kvKey); // 调用从 replacekeys 导出的函数

		if (kvResult === KV_NOT_FOUND) {
			// KV 中确实没有找到这个键
			console.warn(`[getConfigValue:${cacheKey}] KV Fallback: Key not found in KV.`);
			// 不需要更新缓存，因为源头就没有
			return null;
		} else {
			// KV 中找到了键，其值可能是 T 或 null
			console.log(`[getConfigValue:${cacheKey}] KV Fallback successful. Updating cache and returning KV value (which might be null).`);
			// 将从 KV 读取到的值 (T 或 null) 写回缓存
			setEdgeCacheValue(cacheKey, kvResult).catch(err => { // kvResult 可能是 null
				console.error(`[getConfigValue:${cacheKey}] Error updating cache after KV fallback:`, err);
			});
			// 返回从 KV 获取的值 (T 或 null)，这符合函数的 Promise<T | null> 返回类型
			return kvResult;
		}
	} catch (kvError) {
		console.error(`[getConfigValue:${cacheKey}] Error during KV fallback:`, kvError);
		return null; // KV 读取过程中发生错误，返回 null
	}
}


/**
	* [核心] 并行加载所有指定的 KV 配置到 Edge Cache
	*/
export async function loadAndCacheAllKvConfigs(): Promise<void> {
	console.log("Starting KV config preloading to Edge Cache...");
	let kv: Deno.Kv;
	try {
		kv = await ensureKv(); // Use await: 确保 KV 已打开
	} catch (kvError) {
		console.error("Failed to open KV store during preloading:", kvError);
		return; // 无法打开 KV，无法预加载
	}

	try {
		// 1. 从 KV 并行获取所有需要预加载的值
		const results = await kv.getMany<any>(PRELOAD_KV_KEYS);
		console.log(`KV getMany returned ${results.length} entries for preloading.`);

		const cachePromises: Promise<void>[] = [];

		// 2. 遍历 KV 结果，直接将获取到的值 (包括 null/undefined) 写入 Edge Cache
		PRELOAD_KV_KEYS.forEach((kvKey, index) => {
			const cacheKey = kvKey.join('_'); // 生成对应的缓存键字符串
			const entry = results[index];
			const value = entry?.value; // 直接使用 KV 的值，可能是 null 或 undefined

			// --- [移除] 特殊处理逻辑 ---
			// 不再检查类型或应用默认值

			// 将写缓存操作添加到 Promise 数组 (默认永不过期)
			cachePromises.push(setEdgeCacheValue(cacheKey, value));
		});

		// 3. 等待所有缓存写入完成
		await Promise.all(cachePromises);
		console.log("KV config preloading to Edge Cache finished successfully.");

	} catch (error) {
		console.error("Error during KV config preloading process:", error);
		// 预加载失败不再尝试写入默认值
	}
}

/**
	* [核心] 从 KV 重新加载单个配置项并更新 Edge Cache
	* 当通过管理 API 修改配置时调用。
	* 移除类型检查和默认值回退。
	* @param kvKey Deno.KvKey 数组 (例如 ["trigger_keys"])
	*/
export async function reloadKvConfig(kvKey: Deno.KvKey): Promise<void> {
	const cacheKey = kvKey.join('_');
	console.log(`Reloading KV config to Edge Cache for key: ${cacheKey}`);
	let kv: Deno.Kv;
	try {
		kv = await ensureKv(); // Use await
	} catch (kvError) {
		console.error(`Failed to open KV store during reload for key "${cacheKey}":`, kvError);
		return; // 无法打开 KV，无法重新加载
	}

	try {
		// 1. 从 KV 读取最新的值
		const result = await kv.get<any>(kvKey);
		const value = result?.value; // 直接使用 KV 的值，可能是 null 或 undefined

		// --- [移除] 特殊处理逻辑 ---

		// 2. 将新值写入 Edge Cache (覆盖旧值, 默认永不过期)
		await setEdgeCacheValue(cacheKey, value);
		console.log(`Successfully reloaded and cached "${cacheKey}" to Edge Cache.`);

		// GCP 凭证字符串更新的特殊处理 (保持不变，仅日志)
		if (cacheKey === CACHE_KEYS.GCP_CREDENTIALS_STRING) {
			console.log("GCP credentials string reloaded in Edge Cache. Auth instances will be recreated on demand.");
		}
	} catch (error) {
		console.error(`Error reloading KV config to Edge Cache for "${cacheKey}":`, error);
	}
}

/**
	* [核心] 读取并解析 GCP 凭证字符串 (从 Edge Cache)
	* @returns 解析后的 GcpCredentials 数组，如果缓存中没有或解析失败则返回空数组。
	*/
export async function getParsedGcpCredentials(): Promise<GcpCredentials[]> {
	// 1. 使用重构后的 getConfigValue 从缓存或 KV 读取凭证字符串
	const jsonStr = await getConfigValue<string>(CACHE_KEYS.GCP_CREDENTIALS_STRING); // 不再需要默认值

	if (!jsonStr) {
		console.log("No GCP credentials string found in Cache or KV.");
		return []; // 缓存中没有或读取失败，返回空数组
	}

	try {
		// 2. 使用 replacekeys 中的 parseCreds 函数进行解析
		const creds: GcpCredentials[] = parseCreds(jsonStr);
		if (!creds || creds.length === 0) {
			console.warn("Parsed GCP credentials string from Edge Cache resulted in zero valid credentials.");
			return []; // 解析结果为空或无效，返回空数组
		}
		// console.log(`Successfully parsed ${creds.length} GCP credentials from Edge Cache string.`);
		return creds; // 返回解析后的凭证数组
	} catch (e) {
		console.error("Failed to parse GCP credentials string from Edge Cache:", e);
		return []; // 解析过程中出错，返回空数组
	}
}

// End of file