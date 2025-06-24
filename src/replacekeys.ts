/**
 * @file 业务逻辑层 (Business Logic Layer)
 * @description
 * 这一层封装了所有与配置项相关的具体业务逻辑和数据操作。
 * 它作为第二层，调用第一层 (`cache.ts`) 获取数据，并向上层 (`proxy_handler.ts`, `manage_api.ts`) 提供服务。
 *
 * 读取操作: 所有 `is...` 或 `get...FromCache` 函数都通过 `cache.ts` 的 `getConfigValue` 实现，
 * 享受三级缓存带来的高性能。
 *
 * 写入操作: 所有 `set...`, `add...`, `remove...` 函数都实现了 "Write-Through" 策略，
 * 即先写入 Deno KV 持久化，再更新 Edge Cache，确保数据一致性。
 */

import { CACHE_KEYS, getConfigValue, setEdgeCacheValue, reloadKvConfig } from "./cache.ts";

// --- 类型定义 ---
export type ApiKeySource = 'user' | 'fallback' | 'pool';
export type ApiKeyResult = { key: string; source: ApiKeySource };

export interface GcpCredentials {
	type: string;
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
	[key: string]: any;
}

// --- KV 键常量 ---
// 这些常量在多处使用，集中定义便于管理。
export const ADMIN_PASSWORD_HASH_KEY = ["admin_password_hash"];
export const TRIGGER_KEYS_KEY = ["trigger_keys"];
export const POOL_KEYS_KEY = ["pool_keys"];
export const FALLBACK_KEY_KEY = ["fallback_key"];
export const GCP_CREDENTIALS_STRING_KEY = ["gcp_credentials_string"];
export const GCP_DEFAULT_LOCATION_KEY = ["gcp_default_location"];
export const VERTEX_MODELS_KEY = ["vertex_models"];
export const FALLBACK_MODELS_KEY = ["fallback_models"];
export const API_RETRY_LIMIT_KEY = ["api_retry_limit"];
export const API_MAPPINGS_KEY = ["api_mappings"];

// --- KV 实例管理 (懒加载) ---
let kv: Deno.Kv | null = null;

/** [导出] 确保 KV 实例已初始化 (异步，懒加载) */
export async function ensureKv(): Promise<Deno.Kv> {
	if (!kv) {
		try {
			kv = await Deno.openKv();
		} catch (error) {
			console.error("Failed to open lazy KV connection:", error);
			throw error;
		}
	}
	return kv;
}

// --- 密码哈希与验证 (保持不变) ---
async function hashPassword(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
	if (!password || !storedHash) return false;
	return await hashPassword(password) === storedHash;
}

// --- KV 直接访问助手 (供内部和管理 API 使用) ---

/** [导出] 用于表示 KV 中未找到键的特殊 Symbol */
export const KV_NOT_FOUND = Symbol("KV_NOT_FOUND");

/**
 * [导出] [内部] 直接从 KV 获取值，能区分 "键不存在" 和 "值为null"。
 * @param key Deno.KvKey
 * @returns Promise<T | null | typeof KV_NOT_FOUND>
 */
export async function getKvValueDirectly<T>(key: Deno.KvKey): Promise<T | null | typeof KV_NOT_FOUND> {
	const kv = await ensureKv();
	const result = await kv.get<T>(key);
	return result.versionstamp === null ? KV_NOT_FOUND : result.value;
}

// --- 管理员密码 (直接读写 KV，不走通用缓存) ---

export async function setAdminPassword(password: string): Promise<void> {
	if (!password || password.length < 8) throw new Error("Password must be at least 8 characters.");
	const kv = await ensureKv();
	const newHash = await hashPassword(password);
	await kv.set(ADMIN_PASSWORD_HASH_KEY, newHash);
	// 手动更新缓存
	await setEdgeCacheValue(CACHE_KEYS.ADMIN_PASSWORD_HASH, newHash);
}

export async function getAdminPasswordHash(): Promise<string | null> {
	const result = await getKvValueDirectly<string>(ADMIN_PASSWORD_HASH_KEY);
	return result === KV_NOT_FOUND ? null : result;
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
	const storedHash = await getAdminPasswordHash();
	return storedHash ? await verifyPassword(password, storedHash) : false;
}

// --- 通用 Write-Through 辅助函数 ---

/** [内部] 通用设置函数：写入 KV 后，再写入缓存 */
async function _setKvValueAndCache<T>(kvKey: Deno.KvKey, value: T): Promise<void> {
	const kv = await ensureKv();
	await kv.set(kvKey, value);
	await reloadKvConfig(kvKey); // 调用 cache.ts 的函数重新加载并缓存
}

/** [内部] 通用删除函数：删除 KV 键后，再更新缓存 */
async function _deleteKvKeyAndCache(kvKey: Deno.KvKey): Promise<void> {
	const kv = await ensureKv();
	await kv.delete(kvKey);
	await reloadKvConfig(kvKey); // reload 会从 KV 读取（此时已删除），并缓存 null
}

// --- 触发密钥 (Trigger Keys) ---

export async function getTriggerKeys(): Promise<Set<string>> {
	const result = await getKvValueDirectly<string[]>(TRIGGER_KEYS_KEY);
	return new Set(result === KV_NOT_FOUND ? [] : result);
}

export async function addTriggerKey(key: string): Promise<void> {
	if (!key?.trim()) throw new Error("Key cannot be empty.");
	const kv = await ensureKv();
	const list = (await kv.get<string[]>(TRIGGER_KEYS_KEY)).value || [];
	const set = new Set(list);
	if (!set.has(key.trim())) {
		set.add(key.trim());
		await _setKvValueAndCache(TRIGGER_KEYS_KEY, Array.from(set));
	}
}

export async function removeTriggerKey(key: string): Promise<void> {
	if (!key?.trim()) throw new Error("Key cannot be empty.");
	const kv = await ensureKv();
	const list = (await kv.get<string[]>(TRIGGER_KEYS_KEY)).value || [];
	const newList = list.filter(k => k !== key.trim());
	if (newList.length < list.length) {
		await _setKvValueAndCache(TRIGGER_KEYS_KEY, newList);
	}
}

/** [缓存优先] 检查是否为触发密钥 */
export async function isTriggerKey(providedKey: string | null): Promise<boolean> {
	if (!providedKey) return false;
	const triggerKeys = await getConfigValue<string[]>(CACHE_KEYS.TRIGGER_KEYS) || [];
	return new Set(triggerKeys).has(providedKey.trim());
}

// --- 主密钥池 (Pool Keys) ---

export async function getPoolKeys(): Promise<string[]> {
	const result = await getKvValueDirectly<string[]>(POOL_KEYS_KEY);
	return result === KV_NOT_FOUND ? [] : result;
}

export async function addPoolKeys(keys: string[]): Promise<void> {
	if (!Array.isArray(keys)) throw new Error("Input must be an array of keys.");
	const kv = await ensureKv();
	const existingKeys = (await kv.get<string[]>(POOL_KEYS_KEY)).value || [];
	const keySet = new Set(existingKeys);
	keys.forEach(k => k?.trim() && keySet.add(k.trim()));
	await _setKvValueAndCache(POOL_KEYS_KEY, Array.from(keySet));
}

export async function removePoolKey(key: string): Promise<void> {
	await removeTriggerKey(key); // 复用逻辑
}

export async function clearPoolKeys(): Promise<void> {
	await _deleteKvKeyAndCache(POOL_KEYS_KEY);
}

/** [缓存优先] 获取下一个密钥池密钥 (随机) */
export async function getNextPoolKey(): Promise<string | null> {
	const poolKeys = await getConfigValue<string[]>(CACHE_KEYS.POOL_KEYS) || [];
	if (poolKeys.length === 0) return null;
	return poolKeys[Math.floor(Math.random() * poolKeys.length)];
}

// --- 指定密钥 (Fallback Key) ---

export async function getFallbackKey(): Promise<string | null> {
	const result = await getKvValueDirectly<string>(FALLBACK_KEY_KEY);
	return result === KV_NOT_FOUND ? null : result;
}

export async function setFallbackKey(key: string | null): Promise<void> {
	const trimmedKey = key?.trim();
	if (trimmedKey) {
		await _setKvValueAndCache(FALLBACK_KEY_KEY, trimmedKey);
	} else {
		await _deleteKvKeyAndCache(FALLBACK_KEY_KEY);
	}
}

// --- 指定密钥触发模型 (Fallback Models) ---

export async function getFallbackModels(): Promise<Set<string>> {
	const result = await getKvValueDirectly<string[]>(FALLBACK_MODELS_KEY);
	return new Set(result === KV_NOT_FOUND ? [] : result);
}

export async function addFallbackModels(models: string[]): Promise<void> {
	if (!Array.isArray(models)) throw new Error("Input must be an array of models.");
	const kv = await ensureKv();
	const existingModels = (await kv.get<string[]>(FALLBACK_MODELS_KEY)).value || [];
	const modelSet = new Set(existingModels);
	models.forEach(m => m?.trim() && modelSet.add(m.trim()));
	await _setKvValueAndCache(FALLBACK_MODELS_KEY, Array.from(modelSet));
}

export async function clearFallbackModels(): Promise<void> {
	await _deleteKvKeyAndCache(FALLBACK_MODELS_KEY);
}

/** [缓存优先] 检查模型是否为 Fallback 模型 */
export async function isFallbackModel(modelName: string | null): Promise<boolean> {
	if (!modelName) return false;
	const fallbackModels = await getConfigValue<string[]>(CACHE_KEYS.FALLBACK_MODELS) || [];
	return new Set(fallbackModels).has(modelName.trim());
}

// --- API 重试次数 ---

export async function getApiRetryLimit(): Promise<number> {
	const result = await getKvValueDirectly<number>(API_RETRY_LIMIT_KEY);
	return (result === KV_NOT_FOUND || result === null || result < 1) ? 3 : result;
}

export async function setApiRetryLimit(limit: number): Promise<void> {
	if (!Number.isInteger(limit) || limit < 1) throw new Error("Retry limit must be a positive integer.");
	await _setKvValueAndCache(API_RETRY_LIMIT_KEY, limit);
}

/** [缓存优先] 获取 API 重试次数 */
export async function getApiRetryLimitFromCache(): Promise<number> {
	const limit = await getConfigValue<number>(CACHE_KEYS.API_RETRY_LIMIT);
	return (limit === null || !Number.isInteger(limit) || limit < 1) ? 3 : limit;
}

// --- GCP 配置 ---

export async function setGcpCredentialsString(credentials: string | null): Promise<void> {
	const trimmed = credentials?.trim();
	if (trimmed) {
		await _setKvValueAndCache(GCP_CREDENTIALS_STRING_KEY, trimmed);
	} else {
		await _deleteKvKeyAndCache(GCP_CREDENTIALS_STRING_KEY);
	}
}

export async function getGcpCredentialsString(): Promise<string | null> {
	const result = await getKvValueDirectly<string>(GCP_CREDENTIALS_STRING_KEY);
	return result === KV_NOT_FOUND ? null : result;
}

export async function setGcpDefaultLocation(location: string | null): Promise<void> {
	const trimmed = location?.trim();
	if (trimmed) {
		await _setKvValueAndCache(GCP_DEFAULT_LOCATION_KEY, trimmed);
	} else {
		await _deleteKvKeyAndCache(GCP_DEFAULT_LOCATION_KEY);
	}
}

export async function getGcpDefaultLocation(): Promise<string> {
	const result = await getKvValueDirectly<string>(GCP_DEFAULT_LOCATION_KEY);
	return (result === KV_NOT_FOUND || result === null || result === '') ? 'global' : result;
}

/** [缓存优先] 获取 GCP 默认 Location */
export async function getGcpDefaultLocationFromCache(): Promise<string> {
	const location = await getConfigValue<string>(CACHE_KEYS.GCP_DEFAULT_LOCATION);
	return location || 'global';
}

// --- GCP 凭证解析 (保持不变) ---
export const isValidCred = (cred: any): cred is GcpCredentials =>
	!!(cred?.type === 'service_account' && cred?.project_id && cred?.private_key_id && cred?.private_key && cred?.client_email);

export const parseCreds = (jsonStr: string): GcpCredentials[] => {
	if (!jsonStr) return [];
	try {
		const data = JSON.parse(jsonStr);
		if (Array.isArray(data)) return data.filter(isValidCred);
		if (isValidCred(data)) return [data];
	} catch (e) {
		// 如果直接解析失败，尝试解析逗号分隔的多个JSON对象
		try {
			const fixedJson = `[${jsonStr.replace(/}\s*,?\s*{/g, '},{')}]`;
			const data = JSON.parse(fixedJson);
			if (Array.isArray(data)) return data.filter(isValidCred);
		} catch (e2) {
			console.warn("Failed to parse GCP credentials string:", e, e2);
		}
	}
	return [];
};

// --- Vertex AI 模型列表 ---

export async function getVertexModels(): Promise<Set<string>> {
	const result = await getKvValueDirectly<string[]>(VERTEX_MODELS_KEY);
	return new Set(result === KV_NOT_FOUND ? [] : result);
}

export async function addVertexModels(models: string[]): Promise<void> {
    if (!Array.isArray(models)) throw new Error("Input must be an array of models.");
	// 注意：这里是覆盖写，而不是追加
	const modelSet = new Set(models.map(m => m?.trim()).filter(Boolean));
    await _setKvValueAndCache(VERTEX_MODELS_KEY, Array.from(modelSet));
}

export async function clearVertexModels(): Promise<void> {
	await _deleteKvKeyAndCache(VERTEX_MODELS_KEY);
}

/** [缓存优先] 检查模型是否为 Vertex AI 模型 */
export async function isVertexModel(modelName: string | null): Promise<boolean> {
	if (!modelName) return false;
	const vertexModels = await getConfigValue<string[]>(CACHE_KEYS.VERTEX_MODELS) || [];
	return new Set(vertexModels).has(modelName.trim());
}

// --- API 路径映射 ---

export async function getApiMappings(): Promise<Record<string, string>> {
	const result = await getKvValueDirectly<Record<string, string>>(API_MAPPINGS_KEY);
	return result === KV_NOT_FOUND ? {} : result;
}

export async function setApiMappings(mappings: Record<string, string>): Promise<void> {
	if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) {
		throw new Error("Mappings must be a non-null, non-array object.");
	}
	// 可选的格式验证
	for (const [prefix, url] of Object.entries(mappings)) {
		if (!prefix.startsWith('/')) throw new Error(`Invalid prefix: "${prefix}". Must start with '/'.`);
		try { new URL(url); } catch { throw new Error(`Invalid URL for prefix "${prefix}": "${url}".`); }
	}
	await _setKvValueAndCache(API_MAPPINGS_KEY, mappings);
}

export async function clearApiMappings(): Promise<void> {
	await _deleteKvKeyAndCache(API_MAPPINGS_KEY);
}

// --- 核心 API 密钥选择逻辑 (依赖缓存读取) ---

/**
 * [缓存优先] 根据用户输入和模型名称，决定最终使用的 API Key。
 * 这是密钥替换策略的核心。
 */
export async function getApiKeyForRequest(
	userProvidedKey: string | null,
	modelName: string | null
): Promise<ApiKeyResult | null> {
	if (!userProvidedKey) return null;

	if (!await isTriggerKey(userProvidedKey)) {
		return { key: userProvidedKey, source: 'user' };
	}

	// 是触发密钥，开始执行替换逻辑
	if (await isFallbackModel(modelName)) {
		const fallbackKey = await getConfigValue<string>(CACHE_KEYS.FALLBACK_KEY);
		if (fallbackKey) {
			return { key: fallbackKey, source: 'fallback' };
		}
		console.warn(`Fallback model "${modelName}" triggered, but no fallback key is set. Trying pool.`);
	}

	const poolKey = await getNextPoolKey();
	if (poolKey) {
		return { key: poolKey, source: 'pool' };
	}

	console.warn("Trigger key provided, but fallback not applicable and pool is empty.");
	return null;
}