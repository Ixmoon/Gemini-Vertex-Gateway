import {
	ensureKv, // 确保 kv 实例存在
	// _getKvValue, // 不再需要直接从 cache 模块导出原始 KV 读取
	// _getList, // 不再需要直接从 cache 模块导出原始 KV 读取
	parseCreds, // 解析 GCP 凭证 (保持)
	GcpCredentials, // GCP 凭证类型 (保持)
} from "./replacekeys.ts"; // 从 replacekeys 导入常量和类型

// --- Edge Cache 实例 ---
const CACHE_NAME = "llm-gateway-cache";
let edgeCache: Cache | null = null;

// 获取 Edge Cache 实例 (惰性初始化)
async function getEdgeCache(): Promise<Cache> {
	if (!edgeCache) {
		try {
			edgeCache = await caches.open(CACHE_NAME);
			console.log(`Edge Cache "${CACHE_NAME}" opened successfully.`);
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

// --- 默认值映射 (用于处理 KV 中不存在的键或缓存读取失败) (导出以供 replacekeys 使用) ---
export const DEFAULT_VALUES: Record<string, any> = {
	[CACHE_KEYS.ADMIN_PASSWORD_HASH]: null,
	[CACHE_KEYS.TRIGGER_KEYS]: [],
	[CACHE_KEYS.POOL_KEYS]: [],
	[CACHE_KEYS.FALLBACK_KEY]: null,
	[CACHE_KEYS.FALLBACK_MODELS]: [],
	[CACHE_KEYS.API_RETRY_LIMIT]: 3,
	[CACHE_KEYS.API_MAPPINGS]: {},
	[CACHE_KEYS.GCP_CREDENTIALS_STRING]: null,
	[CACHE_KEYS.GCP_DEFAULT_LOCATION]: 'global',
	[CACHE_KEYS.VERTEX_MODELS]: [],
};

/**
 * [内部] 将值存入 Edge Cache
 * @param cacheKey 缓存键 (string)
 * @param value 要缓存的值 (会被 JSON.stringify)
 * @param ttlSeconds 可选的 TTL (秒)，用于设置 Cache-Control max-age
 */
export async function setEdgeCacheValue(cacheKey: string, value: any, ttlSeconds?: number): Promise<void> {
	try {
		const cache = await getEdgeCache();
		const headers = new Headers({ 'Content-Type': 'application/json' });
		if (ttlSeconds && ttlSeconds > 0) {
			headers.set('Cache-Control', `max-age=${ttlSeconds}`);
		}
		// Edge Cache 使用 Request 对象作为 key
		// 使用一个固定的基础 URL，并将 cacheKey 作为路径的一部分
		const request = new Request(`http://cache.internal/${encodeURIComponent(cacheKey)}`);
		// 确保 value 是可序列化的，null 也需要处理
		const body = value === undefined ? null : JSON.stringify(value);
		const response = new Response(body, { headers });
		await cache.put(request, response);
		// console.log(`Edge Cache: Set value for key "${cacheKey}"`);
	} catch (error) {
		console.error(`Error setting Edge Cache for key "${cacheKey}":`, error);
		// 写入缓存失败通常不应中断主流程，仅记录错误
	}
}

/**
 * [核心] 从 Edge Cache 获取配置值，并在未命中时尝试从 KV 加载 (Lazy Loading / Cache-Aside)
 * @param cacheKey 缓存键 (string)
 * @param defaultValue 默认值
 * @returns 解析后的值或默认值
 */
export async function getConfigValue<T>(cacheKey: string, defaultValue: T): Promise<T> {
	try {
		const cache = await getEdgeCache();
		const request = new Request(`http://cache.internal/${encodeURIComponent(cacheKey)}`);
		const cachedResponse = await cache.match(request);

		if (cachedResponse) {
			// Cache Hit
			console.log(`[getConfigValue:${cacheKey}] Cache Hit.`); // DEBUG LOG
			try {
				const contentType = cachedResponse.headers.get('content-type');
				console.log(`[getConfigValue:${cacheKey}] Cached Content-Type: ${contentType}`); // DEBUG LOG
				if (!contentType || !contentType.includes('application/json')) {
					console.warn(`Cache data for key "${cacheKey}" is not JSON. Falling back to default, will attempt KV fetch.`);
					// 不直接返回，继续尝试 KV
				} else {
					const text = await cachedResponse.text();
					if (text === 'null' && defaultValue === null) {
						console.log(`[getConfigValue:${cacheKey}] Cached value is 'null' string and defaultValue is null. Returning null.`); // DEBUG LOG
						return null as T; // 正确处理存储的 null 值
					}
					if (!text && defaultValue !== null) { // 处理空字符串响应体, 但如果默认值是 null 则允许
						console.warn(`[getConfigValue:${cacheKey}] Cache data is empty string, but defaultValue is not null. Falling back to KV fetch.`); // DEBUG LOG
						console.warn(`Cache data for key "${cacheKey}" is empty. Falling back to default, will attempt KV fetch.`);
						// 不直接返回，继续尝试 KV
					} else {
						const data = JSON.parse(text || 'null'); // 处理空文本情况，解析为 null
						console.log(`[getConfigValue:${cacheKey}] Parsed cached data:`, data, `(Type: ${typeof data}, IsArray: ${Array.isArray(data)})`); // DEBUG LOG
						console.log(`[getConfigValue:${cacheKey}] Default value:`, defaultValue, `(Type: ${typeof defaultValue}, IsArray: ${Array.isArray(defaultValue)})`); // DEBUG LOG

						// Type checking logic
						let typeMatch = false;
						if (typeof data === typeof defaultValue || (data === null && defaultValue === null)) {
							typeMatch = true;
							console.log(`[getConfigValue:${cacheKey}] Type match: Basic type or both null.`); // DEBUG LOG
							return data as T;
						} else if (Array.isArray(defaultValue) && Array.isArray(data)) {
							typeMatch = true;
							console.log(`[getConfigValue:${cacheKey}] Type match: Both arrays.`); // DEBUG LOG
							return data as T;
						} else if (typeof defaultValue === 'object' && defaultValue !== null && !Array.isArray(defaultValue) &&
								   typeof data === 'object' && data !== null && !Array.isArray(data)) {
							typeMatch = true;
							console.log(`[getConfigValue:${cacheKey}] Type match: Both non-array objects.`); // DEBUG LOG
							return data as T;
						} else {
							console.warn(`[getConfigValue:${cacheKey}] Cache type mismatch. Expected ${typeof defaultValue}, got ${typeof data}. Falling back to KV fetch.`); // DEBUG LOG
							console.warn(`Cache type mismatch for key "${cacheKey}". Expected ${typeof defaultValue}, got ${typeof data}. Falling back to default, will attempt KV fetch.`);
							// 类型不匹配，继续尝试 KV
						}
						if (!typeMatch) { // Log if no match was found before falling through
								console.log(`[getConfigValue:${cacheKey}] No type match found in cache check.`); // DEBUG LOG
						}
					}
				}
			} catch (parseError) {
				console.error(`[getConfigValue:${cacheKey}] Error parsing JSON from Edge Cache:`, parseError); // DEBUG LOG
				console.error(`Error parsing JSON from Edge Cache for key "${cacheKey}":`, parseError);
				// 解析失败，继续尝试 KV
			}
		} else {
				console.log(`[getConfigValue:${cacheKey}] Cache Miss.`); // DEBUG LOG
		}

		// Cache Miss or Cache Read Error: Attempt to fetch from KV
		console.log(`[getConfigValue:${cacheKey}] Attempting to fetch from KV...`); // DEBUG LOG
		console.log(`Edge Cache: Miss or error for key "${cacheKey}". Attempting to fetch from KV...`);
		try {
			const kv = await ensureKv(); // Ensure KV is open
			// 重要：KV 键是数组形式，从 cacheKey 字符串转换
			const kvKeyArray = cacheKey.split('_'); // 假设 cacheKey 由 KV 键数组 join('_') 组成
			if (kvKeyArray.length === 0 || kvKeyArray.some(k => typeof k !== 'string')) {
				console.error(`Invalid cacheKey format for KV lookup: "${cacheKey}". Cannot convert to Deno.KvKey.`);
				return defaultValue; // 无法转换 key，返回默认值
			}
			const kvKey: Deno.KvKey = kvKeyArray;

			const result = await kv.get<any>(kvKey);
			console.log(`[getConfigValue:${cacheKey}] KV get result:`, { versionstamp: result?.versionstamp, value: result?.value }); // DEBUG LOG (Log value separately if large)
			let kvValue = result?.value ?? DEFAULT_VALUES[cacheKey]; // Use default value if KV is null/undefined
			console.log(`[getConfigValue:${cacheKey}] Initial kvValue (after default check):`, kvValue, `(Type: ${typeof kvValue})`); // DEBUG LOG

			// Apply the same special validation/handling logic as in load/reload functions
			console.log(`[getConfigValue:${cacheKey}] Applying KV validation rules...`); // DEBUG LOG
			if (
				[CACHE_KEYS.TRIGGER_KEYS, CACHE_KEYS.POOL_KEYS, CACHE_KEYS.FALLBACK_MODELS, CACHE_KEYS.VERTEX_MODELS].includes(cacheKey) &&
				!Array.isArray(kvValue)
			) {
				console.warn(`KV value for ${cacheKey} was not an array, using default []`);
				kvValue = DEFAULT_VALUES[cacheKey];
			}
			if (cacheKey === CACHE_KEYS.API_MAPPINGS && (typeof kvValue !== 'object' || kvValue === null || Array.isArray(kvValue))) {
				console.warn(`KV value for ${cacheKey} was not a valid object, using default {}`);
				kvValue = DEFAULT_VALUES[cacheKey];
			}
			if (cacheKey === CACHE_KEYS.API_RETRY_LIMIT) {
				if (typeof kvValue !== 'number' || !Number.isInteger(kvValue) || kvValue < 1) {
					console.warn(`KV value for ${cacheKey} was invalid (${kvValue}), using default ${DEFAULT_VALUES[cacheKey]}`);
					kvValue = DEFAULT_VALUES[cacheKey];
				}
			}
			// GCP Credentials String doesn't need special handling here.

			// Write the fetched (and validated) value back to Edge Cache
			// Do this even if it's the default value, to cache the "miss" result from KV
			console.log(`[getConfigValue:${cacheKey}] Final kvValue after validation:`, kvValue, `(Type: ${typeof kvValue})`); // DEBUG LOG
			console.log(`[getConfigValue:${cacheKey}] Caching this value to Edge Cache.`); // DEBUG LOG
			console.log(`KV Fetch: Fetched value for "${cacheKey}". Caching it to Edge Cache.`);
			// 使用 await 写入缓存，确保操作完成
			// 移除不正确的 Deno.unstable_kv 调用
			try {
				await setEdgeCacheValue(cacheKey, kvValue); // Use default TTL (infinite)
			} catch (cacheWriteError) {
				// 记录缓存写入错误，但不影响返回 KV 值
				console.error(`Failed to write KV value back to Edge Cache for key "${cacheKey}":`, cacheWriteError);
			}

			// Return the value fetched from KV (or the default if KV was empty)
			// Perform one last type check against the original defaultValue requested
			console.log(`[getConfigValue:${cacheKey}] Performing final type check before returning KV value.`); // DEBUG LOG
			if (typeof kvValue === typeof defaultValue || (kvValue === null && defaultValue === null)) {
					console.log(`[getConfigValue:${cacheKey}] Final type check passed (basic/null). Returning KV value.`); // DEBUG LOG
					return kvValue as T;
			} else if (Array.isArray(defaultValue) && Array.isArray(kvValue)) {
					console.log(`[getConfigValue:${cacheKey}] Final type check passed (array). Returning KV value.`); // DEBUG LOG
					return kvValue as T;
			} else if (typeof defaultValue === 'object' && defaultValue !== null && !Array.isArray(defaultValue) &&
					   typeof kvValue === 'object' && kvValue !== null && !Array.isArray(kvValue)) {
					console.log(`[getConfigValue:${cacheKey}] Final type check passed (object). Returning KV value.`); // DEBUG LOG
					return kvValue as T;
			} else {
					console.warn(`[getConfigValue:${cacheKey}] Final type check failed. KV value type (${typeof kvValue}) doesn't match expected default type (${typeof defaultValue}). Falling back to original default.`); // DEBUG LOG
					console.warn(`KV value type mismatch for key "${cacheKey}" after fetch. Expected ${typeof defaultValue}, got ${typeof kvValue}. Falling back to original default.`);
					return defaultValue; // Final fallback
			}

		} catch (kvError) {
			console.error(`[getConfigValue:${cacheKey}] Error during KV fetch/processing:`, kvError); // DEBUG LOG
			console.error(`Error fetching or processing KV value for key "${cacheKey}":`, kvError);
			// Fallback to the original default value if KV interaction fails
			return defaultValue;
		}

	} catch (cacheError) {
		console.error(`[getConfigValue:${cacheKey}] Error accessing Edge Cache:`, cacheError); // DEBUG LOG
		console.error(`Error accessing Edge Cache for key "${cacheKey}":`, cacheError);
		// Fallback to default if Edge Cache access fails initially
		return defaultValue;
	}
}


/**
 * [核心] 并行加载所有指定的 KV 配置到 Edge Cache
 * 在应用启动时调用，用于预热缓存。
 */
export async function loadAndCacheAllKvConfigs(): Promise<void> {
	console.log("Starting KV config preloading to Edge Cache...");
	const kv = await ensureKv(); // Use await: 确保 KV 已打开
	try {
		// 1. 从 KV 并行获取所有需要预加载的值
		const results = await kv.getMany<any>(PRELOAD_KV_KEYS);
		console.log(`KV getMany returned ${results.length} entries for preloading.`);

		const cachePromises: Promise<void>[] = [];

		// 2. 遍历 KV 结果，处理默认值和类型，并写入 Edge Cache
		PRELOAD_KV_KEYS.forEach((kvKey, index) => {
			const cacheKey = kvKey.join('_'); // 生成对应的缓存键字符串
			const entry = results[index];
			let value = entry?.value ?? DEFAULT_VALUES[cacheKey]; // 使用默认值处理 null/undefined

			// --- 应用与之前相同的特殊处理逻辑 (保持不变) ---
			if (
				[CACHE_KEYS.TRIGGER_KEYS, CACHE_KEYS.POOL_KEYS, CACHE_KEYS.FALLBACK_MODELS, CACHE_KEYS.VERTEX_MODELS].includes(cacheKey) &&
				!Array.isArray(value)
			) {
				console.warn(`KV value for ${cacheKey} was not an array, defaulting to []`);
				value = DEFAULT_VALUES[cacheKey];
			}
			if (cacheKey === CACHE_KEYS.API_MAPPINGS && (typeof value !== 'object' || value === null || Array.isArray(value))) { // 更严格的对象检查
				console.warn(`KV value for ${cacheKey} was not a valid object, defaulting to {}`);
				value = DEFAULT_VALUES[cacheKey];
			}
			if (cacheKey === CACHE_KEYS.API_RETRY_LIMIT) {
				if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
					console.warn(`KV value for ${cacheKey} was invalid (${value}), defaulting to ${DEFAULT_VALUES[cacheKey]}`);
					value = DEFAULT_VALUES[cacheKey];
				}
			}
			// --- 结束特殊处理 ---

			// 将写缓存操作添加到 Promise 数组 (默认永不过期)
			cachePromises.push(setEdgeCacheValue(cacheKey, value));
		});

		// 3. 等待所有缓存写入完成
		await Promise.all(cachePromises);
		console.log("KV config preloading to Edge Cache finished successfully.");

	} catch (error) {
		console.error("Error during KV config preloading to Edge Cache:", error);
		// 预加载失败时，尝试用默认值填充 Edge Cache (作为后备)
		console.warn("Falling back to setting default values in Edge Cache due to preload error.");
		const fallbackPromises: Promise<void>[] = [];
		PRELOAD_KV_KEYS.forEach(kvKey => {
			const cacheKey = kvKey.join('_');
			// 写入默认值到缓存
			fallbackPromises.push(setEdgeCacheValue(cacheKey, DEFAULT_VALUES[cacheKey]));
		});
		try {
			await Promise.all(fallbackPromises);
			console.log("Successfully set default values in Edge Cache as fallback.");
		} catch (fallbackError) {
			console.error("Error setting default values in Edge Cache during fallback:", fallbackError);
		}
	}
}

/**
 * [核心] 从 KV 重新加载单个配置项并更新 Edge Cache
 * 当通过管理 API 修改配置时调用。
 * @param kvKey Deno.KvKey 数组 (例如 ["trigger_keys"])
 */
export async function reloadKvConfig(kvKey: Deno.KvKey): Promise<void> {
	const cacheKey = kvKey.join('_');
	console.log(`Reloading KV config to Edge Cache for key: ${cacheKey}`);
	try {
		const kv = await ensureKv(); // Use await
		// 1. 从 KV 读取最新的值
		const result = await kv.get<any>(kvKey);
		let value = result?.value ?? DEFAULT_VALUES[cacheKey]; // 使用默认值处理 null/undefined

		// --- 应用与 loadAndCacheAllKvConfigs 中相同的特殊处理逻辑 (保持不变) ---
		if (
			[CACHE_KEYS.TRIGGER_KEYS, CACHE_KEYS.POOL_KEYS, CACHE_KEYS.FALLBACK_MODELS, CACHE_KEYS.VERTEX_MODELS].includes(cacheKey) &&
			!Array.isArray(value)
		) {
			console.warn(`Reloaded KV value for ${cacheKey} was not an array, defaulting to []`);
			value = DEFAULT_VALUES[cacheKey];
		}
		if (cacheKey === CACHE_KEYS.API_MAPPINGS && (typeof value !== 'object' || value === null || Array.isArray(value))) {
			console.warn(`Reloaded KV value for ${cacheKey} was not a valid object, defaulting to {}`);
			value = DEFAULT_VALUES[cacheKey];
		}
		if (cacheKey === CACHE_KEYS.API_RETRY_LIMIT) {
			if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
				console.warn(`Reloaded KV value for ${cacheKey} was invalid (${value}), defaulting to ${DEFAULT_VALUES[cacheKey]}`);
				value = DEFAULT_VALUES[cacheKey];
			}
		}
		// --- 结束特殊处理 ---

		// 2. 将新值写入 Edge Cache (覆盖旧值, 默认永不过期)
		await setEdgeCacheValue(cacheKey, value);
		console.log(`Successfully reloaded and cached "${cacheKey}" to Edge Cache.`);

		// GCP 凭证字符串更新的特殊处理 (保持不变，仅日志)
		if (cacheKey === CACHE_KEYS.GCP_CREDENTIALS_STRING) {
			console.log("GCP credentials string reloaded in Edge Cache. Auth instances will be recreated on demand.");
		}
	} catch (error) {
		console.error(`Error reloading KV config to Edge Cache for "${cacheKey}":`, error);
		// 可选：添加错误处理逻辑，例如尝试恢复旧缓存值或设置默认值
		// 简单起见，这里只记录错误，缓存可能暂时不一致
	}
}

/**
 * [核心] 读取并解析 GCP 凭证字符串 (从 Edge Cache)
 * 不再缓存 Auth 实例。由 proxy_handler 按需创建。
 * @returns 解析后的 GcpCredentials 数组，如果缓存中没有或解析失败则返回空数组。
 */
export async function getParsedGcpCredentials(): Promise<GcpCredentials[]> {
	// console.log("Getting GCP credentials string from Edge Cache...");
	// 1. 使用 getConfigValue 从 Edge Cache 读取凭证字符串
	const jsonStr = await getConfigValue<string | null>(CACHE_KEYS.GCP_CREDENTIALS_STRING, null);

	if (!jsonStr) {
		// console.log("No GCP credentials string found in Edge Cache.");
		return []; // 缓存中没有，返回空数组
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

// 移除所有与旧内存缓存、GCP Auth 实例缓存相关的代码
// 例如：initializeAndCacheGcpAuth, globalCache, GCP_AUTH_INSTANCES_KEY 等