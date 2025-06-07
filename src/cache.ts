import {
	ensureKv, // 确保 kv 实例存在
	_getKvValue, // 获取单个 KV 值
	_getList, // 获取列表
	parseCreds, // 解析 GCP 凭证
	GcpCredentials, // GCP 凭证类型
} from "./replacekeys.ts"; // 从 replacekeys 导入常量和类型
import { GoogleAuth } from "google-auth-library"; // 导入 GoogleAuth

// --- 缓存接口和类 (保持不变) ---
interface CacheEntry<T> {
	value: T;
	expiry: number | null; // null 表示永不过期
}

export class MemoryCache {
	private cache = new Map<string, CacheEntry<any>>();

	get<T>(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) {
			return undefined;
		}
		if (entry.expiry !== null && Date.now() > entry.expiry) {
			this.cache.delete(key); // 过期则删除
			return undefined;
		}
		return entry.value as T;
	}

	set<T>(key: string, value: T, ttlMilliseconds: number = 0): void {
		const expiry = (ttlMilliseconds && ttlMilliseconds > 0) ? Date.now() + ttlMilliseconds : null;
		this.cache.set(key, { value, expiry });
	}

	delete(key: string): void {
		this.cache.delete(key);
	}

	clear(): void {
		this.cache.clear();
	}

	keys(): string[] {
		return Array.from(this.cache.keys());
	}
}

// --- 全局缓存实例 ---
export const globalCache = new MemoryCache();

// --- 扩展的缓存键常量 (包含所有需预加载的 KV 键) ---
export const CACHE_KEYS = {
	// 来自 replacekeys.ts 的 KV 键 (使用字符串形式)
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

	// 新增：用于缓存处理后的 GoogleAuth 实例数组
	GCP_AUTH_INSTANCES: "gcp_auth_instances",

};

// --- 默认 TTL ---
export const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
// GCP_TOKEN_CACHE_TTL removed, managed by proxy_handler directly with MemoryCache TTL

// --- GcpTokenCacheEntry interface removed, managed by proxy_handler ---

// --- 所有需要预加载的 KV 键数组 (Deno.KvKey[]) ---
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

// --- 默认值映射 (用于处理 KV 中不存在的键) ---
const DEFAULT_VALUES: Record<string, any> = {
	[CACHE_KEYS.ADMIN_PASSWORD_HASH]: null,
	[CACHE_KEYS.TRIGGER_KEYS]: [],
	[CACHE_KEYS.POOL_KEYS]: [],
	[CACHE_KEYS.FALLBACK_KEY]: null,
	[CACHE_KEYS.FALLBACK_MODELS]: [],
	[CACHE_KEYS.API_RETRY_LIMIT]: 3, // 默认重试 3 次
	[CACHE_KEYS.API_MAPPINGS]: {},
	[CACHE_KEYS.GCP_CREDENTIALS_STRING]: null,
	[CACHE_KEYS.GCP_DEFAULT_LOCATION]: 'global', // 默认 'global'
	[CACHE_KEYS.VERTEX_MODELS]: [],
	[CACHE_KEYS.GCP_AUTH_INSTANCES]: [], // 默认空数组
};

/**
 * [核心] 并行加载所有指定的 KV 配置到全局缓存
 */
export async function loadAndCacheAllKvConfigs(): Promise<void> {
	console.log("Starting KV config preloading...");
	const kv = ensureKv(); // 确保 KV 已打开
	try {
		const results = await kv.getMany<any>(PRELOAD_KV_KEYS);
		console.log(`KV getMany returned ${results.length} entries.`);

		PRELOAD_KV_KEYS.forEach((kvKey, index) => {
			const cacheKey = kvKey.join('_'); // 生成对应的缓存键字符串
			const entry = results[index];
			let value = entry?.value ?? DEFAULT_VALUES[cacheKey]; // 使用默认值处理 null/undefined

			// 特殊处理: 确保列表类型是数组
			if (
				[CACHE_KEYS.TRIGGER_KEYS, CACHE_KEYS.POOL_KEYS, CACHE_KEYS.FALLBACK_MODELS, CACHE_KEYS.VERTEX_MODELS].includes(cacheKey) &&
				!Array.isArray(value)
			) {
				console.warn(`KV value for ${cacheKey} was not an array, defaulting to []`);
				value = DEFAULT_VALUES[cacheKey]; // 使用默认空数组
			}
			// 特殊处理: 确保映射类型是对象
			if (cacheKey === CACHE_KEYS.API_MAPPINGS && (typeof value !== 'object' || value === null)) {
				console.warn(`KV value for ${cacheKey} was not an object, defaulting to {}`);
				value = DEFAULT_VALUES[cacheKey]; // 使用默认空对象
			}
			// 特殊处理: 确保重试次数是正整数
			if (cacheKey === CACHE_KEYS.API_RETRY_LIMIT) {
				if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
					console.warn(`KV value for ${cacheKey} was invalid (${value}), defaulting to ${DEFAULT_VALUES[cacheKey]}`);
					value = DEFAULT_VALUES[cacheKey];
				}
			}

			globalCache.set(cacheKey, value); // 存入缓存 (永不过期)
		});
		console.log("KV config preloading finished.");
	} catch (error) {
		console.error("Error during KV config preloading:", error);
		// 即使预加载失败，也尝试用默认值填充缓存，保证 get* 函数能返回东西
		console.warn("Falling back to default values for cache due to preload error.");
		PRELOAD_KV_KEYS.forEach(kvKey => {
			const cacheKey = kvKey.join('_');
			if (globalCache.get(cacheKey) === undefined) { // 仅填充尚未设置的
				globalCache.set(cacheKey, DEFAULT_VALUES[cacheKey]);
			}
		});
	}
	// 确保 GCP Auth 缓存也有默认值
	if (globalCache.get(CACHE_KEYS.GCP_AUTH_INSTANCES) === undefined) {
		globalCache.set(CACHE_KEYS.GCP_AUTH_INSTANCES, DEFAULT_VALUES[CACHE_KEYS.GCP_AUTH_INSTANCES]);
	}
}

/**
 * [核心] 从 KV 重新加载单个配置项并更新缓存
 * @param kvKey Deno.KvKey 数组 (例如 TRIGGER_KEYS_KEY)
 */
export async function reloadKvConfig(kvKey: Deno.KvKey): Promise<void> {
	const cacheKey = kvKey.join('_');
	console.log(`Reloading KV config for key: ${cacheKey}`);
	try {
		const kv = ensureKv();
		const result = await kv.get<any>(kvKey);
		let value = result?.value ?? DEFAULT_VALUES[cacheKey]; // 使用默认值处理 null/undefined

		// --- 应用与 loadAndCacheAllKvConfigs 中相同的特殊处理逻辑 ---
		if (
			[CACHE_KEYS.TRIGGER_KEYS, CACHE_KEYS.POOL_KEYS, CACHE_KEYS.FALLBACK_MODELS, CACHE_KEYS.VERTEX_MODELS].includes(cacheKey) &&
			!Array.isArray(value)
		) {
			value = DEFAULT_VALUES[cacheKey];
		}
		if (cacheKey === CACHE_KEYS.API_MAPPINGS && (typeof value !== 'object' || value === null)) {
			value = DEFAULT_VALUES[cacheKey];
		}
		if (cacheKey === CACHE_KEYS.API_RETRY_LIMIT) {
			if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
				value = DEFAULT_VALUES[cacheKey];
			}
		}
		// --- 结束特殊处理 ---

		globalCache.set(cacheKey, value); // 更新缓存
		console.log(`Reloaded and cached ${cacheKey}.`);

		// 如果是 GCP 凭证字符串被更新，需要触发 Auth 实例的重新初始化
		if (cacheKey === CACHE_KEYS.GCP_CREDENTIALS_STRING) {
			console.log("GCP credentials string reloaded, re-initializing Auth instances...");
			await initializeAndCacheGcpAuth(); // 重新生成并缓存 Auth 对象
		}
	} catch (error) {
		console.error(`Error reloading KV config for ${cacheKey}:`, error);
		// 可选：添加错误处理逻辑，例如尝试恢复旧缓存值或设置默认值
	}
}

/**
 * [核心] 初始化并缓存 GoogleAuth 实例数组
 * 从缓存中读取 GCP 凭证字符串，解析并创建 Auth 对象，然后存入缓存。
 */
export async function initializeAndCacheGcpAuth(): Promise<void> {
	console.log("Initializing GCP Auth instances...");
	const jsonStr = globalCache.get<string | null>(CACHE_KEYS.GCP_CREDENTIALS_STRING);

	try {
		if (!jsonStr) {
			console.log("No GCP credentials string found in cache. Clearing Auth instances cache.");
			globalCache.set(CACHE_KEYS.GCP_AUTH_INSTANCES, []); // 存入空数组
			return;
		}

		const creds: GcpCredentials[] = parseCreds(jsonStr); // 使用 replacekeys 中的解析函数
		if (!creds || creds.length === 0) {
			console.warn("Parsed GCP credentials string resulted in zero valid credentials. Clearing Auth instances cache.");
			globalCache.set(CACHE_KEYS.GCP_AUTH_INSTANCES, []); // 存入空数组
			return;
		}

		const auths = creds.map(cred => new GoogleAuth({
			credentials: cred,
			scopes: ["https://www.googleapis.com/auth/cloud-platform"]
		}));

		globalCache.set(CACHE_KEYS.GCP_AUTH_INSTANCES, auths); // 缓存 GoogleAuth 实例数组
		console.log(`Successfully initialized and cached ${auths.length} GCP Auth instances.`);
	} catch (e) {
		console.error("Failed to initialize/cache GCP Auth instances:", e);
		globalCache.set(CACHE_KEYS.GCP_AUTH_INSTANCES, []); // 出错时存入空数组
	}
}