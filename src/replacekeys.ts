// --- 导入缓存模块 ---
import { CACHE_KEYS, getConfigValue, setEdgeCacheValue, DEFAULT_VALUES } from "./cache.ts";

// 定义用于 Write-Through 的默认 TTL (秒)
const WRITE_THROUGH_TTL_SECONDS = 5 * 60; // 5 minutes

// --- 类型定义 (保持不变) ---
export type ApiKeySource = 'user' | 'fallback' | 'pool';
export type ApiKeyResult = { key: string; source: ApiKeySource };

// Gcp凭证定义 (保持不变)
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

// --- KV 键常量 (移除不再使用的原子索引键) ---
export const ADMIN_PASSWORD_HASH_KEY = ["admin_password_hash"];
export const TRIGGER_KEYS_KEY = ["trigger_keys"];
export const POOL_KEYS_KEY = ["pool_keys"];
// export const GCP_CREDENTIAL_ATOMIC_INDEX_KEY = ["gcp_credential_atomic_index"]; // Removed
export const FALLBACK_KEY_KEY = ["fallback_key"];
export const GCP_CREDENTIALS_STRING_KEY = ["gcp_credentials_string"];
export const GCP_DEFAULT_LOCATION_KEY = ["gcp_default_location"];
export const VERTEX_MODELS_KEY = ["vertex_models"];
export const FALLBACK_MODELS_KEY = ["fallback_models"];
export const API_RETRY_LIMIT_KEY = ["api_retry_limit"];
export const API_MAPPINGS_KEY = ["api_mappings"];

// --- KV 实例管理 (保持不变) ---
let kv: Deno.Kv | null = null;

export async function openKv(): Promise<Deno.Kv> {
	if (!kv) {
		try {
			kv = await Deno.openKv();
			console.log("Deno KV store opened successfully.");
		} catch (error) {
			console.error("Failed to open Deno KV store:", error);
			throw new Error(`Failed to open Deno KV: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return kv;
}

/** [内部] 确保 KV 实例已初始化 (异步，懒加载) - Exported */
export async function ensureKv(): Promise<Deno.Kv> {
	if (!kv) {
		console.log("KV connection not initialized. Opening lazily...");
		try {
			kv = await Deno.openKv();
			console.log("Lazy KV connection successful.");
		} catch (error) {
			console.error("Failed to open lazy KV connection:", error);
			throw error; // Re-throw the error so the caller knows
		}
	}
	return kv;
}

// --- 密码哈希与验证 (保持不变) ---
async function hashPassword(password: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(password);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
	if (!password || !storedHash) {
		return false;
	}
	const inputHash = await hashPassword(password);
	// 使用 crypto.subtle.timingSafeEqual 进行更安全的比较（虽然理论上 SHA256 不易受时序攻击）
	// 但需要将 hex string 转回 ArrayBuffer，这里简单比较字符串
	return inputHash === storedHash;
}

// --- 管理员密码 KV 操作 ---

/** [重构] 设置管理员密码 (写入 KV 并更新 Edge Cache) */
export async function setAdminPassword(password: string): Promise<void> {
	const kv = await ensureKv(); // Use await
	if (!password || typeof password !== 'string' || password.length < 8) {
		throw new Error("Password must be a string of at least 8 characters.");
	}
	const newHash = await hashPassword(password);
	// 1. 写入 KV
	await (await kv).set(ADMIN_PASSWORD_HASH_KEY, newHash); // Corrected: await kv first
	// 2. 更新 Edge Cache (Write-Through)
	await setEdgeCacheValue(CACHE_KEYS.ADMIN_PASSWORD_HASH, newHash, WRITE_THROUGH_TTL_SECONDS);
	console.log("Admin password updated in KV and Edge Cache.");
}

/** [重构] 从 Edge Cache 获取管理员密码哈希 */
export async function getAdminPasswordHash(): Promise<string | null> {
	return await getConfigValue<string | null>(CACHE_KEYS.ADMIN_PASSWORD_HASH, DEFAULT_VALUES[CACHE_KEYS.ADMIN_PASSWORD_HASH]);
}

/** [重构] 验证管理员密码 (从 Edge Cache 读取哈希) */
export async function verifyAdminPassword(password: string): Promise<boolean> {
	const storedHash = await getAdminPasswordHash(); // await 读取 Edge Cache
	if (!storedHash) {
		return false; // 哈希不存在，无法验证
	}
	return await verifyPassword(password, storedHash); // verifyPassword 本身是 async
}


// --- 内部通用 KV 助手函数 (用于 Write-Through 和需要直接读 KV 的场景) ---

/** [内部] 获取任意类型的单个 KV 值 (仅限内部使用) */
async function _getKvValue<T>(key: Deno.KvKey): Promise<T | null> {
	const kv = await ensureKv(); // Use await
	const result = await kv.get<T>(key);
	return result.value ?? null;
}

/** [内部] 设置任意类型的单个 KV 值 (写入 KV 并更新 Edge Cache) */
async function _setKvValue<T>(key: Deno.KvKey, value: T): Promise<void> {
	const kv = await ensureKv(); // Use await
	// 1. 写入 KV
	await kv.set(key, value);
	// 2. 更新 Edge Cache (Write-Through)
	const cacheKey = key.join('_');
	await setEdgeCacheValue(cacheKey, value, WRITE_THROUGH_TTL_SECONDS);
	// console.log(`Set KV and updated Edge Cache for key: ${cacheKey}`);
}

/** [内部] 删除任意 KV 键 (删除 KV 并更新 Edge Cache 为默认值) */
async function _deleteKvKey(key: Deno.KvKey): Promise<void> {
	const kv = await ensureKv(); // Use await
	// 1. 删除 KV
	await kv.delete(key);
	// 2. 更新 Edge Cache 为默认值 (Write-Through for delete)
	const cacheKey = key.join('_');
	const defaultValue = DEFAULT_VALUES[cacheKey]; // 获取该键的默认值
	await setEdgeCacheValue(cacheKey, defaultValue, WRITE_THROUGH_TTL_SECONDS);
	// console.log(`Deleted KV and set Edge Cache to default for key: ${cacheKey}`);
}

/** [内部] 从 KV 获取字符串列表 (仅限内部需要直接读 KV 的场景) */
async function _getList(key: Deno.KvKey): Promise<string[]> {
	// 保持这个函数，因为 _addItemToSet 和 _removeItemFromList 需要先读 KV
	return (await _getKvValue<string[]>(key)) || [];
}

/** [内部] 向 KV 中存储的列表（视为 Set）添加单个唯一字符串 (写入 KV 并更新 Edge Cache) */
async function _addItemToSet(key: Deno.KvKey, item: string): Promise<boolean> {
	const trimmedItem = item?.trim();
	if (!trimmedItem) {
		throw new Error("Item cannot be empty.");
	}
	// 1. 直接从 KV 读取当前列表以进行检查
	const currentList = await _getList(key);
	const currentSet = new Set(currentList);

	if (!currentSet.has(trimmedItem)) {
		// 2. 如果不存在，添加到列表并写入 KV
		currentList.push(trimmedItem);
		const kv = await ensureKv(); // Use await
		await kv.set(key, currentList); // Direct set to KV

		// 3. 更新 Edge Cache (Write-Through)
		const cacheKey = key.join('_');
		await setEdgeCacheValue(cacheKey, currentList, WRITE_THROUGH_TTL_SECONDS);
		// console.log(`Added item to KV and updated Edge Cache for key: ${cacheKey}`);
		return true; // Added
	}
	return false; // Already exists
}

/** [内部] 从 KV 中存储的列表中移除单个字符串 (写入 KV 并更新 Edge Cache) */
async function _removeItemFromList(key: Deno.KvKey, item: string): Promise<boolean> {
	const trimmedItem = item?.trim();
	if (!trimmedItem) {
		throw new Error("Item cannot be empty.");
	}
	// 1. 直接从 KV 读取当前列表以进行检查
	let currentList = await _getList(key);
	const initialLength = currentList.length;
	currentList = currentList.filter(i => i !== trimmedItem);

	if (currentList.length < initialLength) {
		// 2. 如果找到并移除，写入 KV
		const kv = await ensureKv(); // Use await
		await kv.set(key, currentList); // Direct set to KV

		// 3. 更新 Edge Cache (Write-Through)
		const cacheKey = key.join('_');
		await setEdgeCacheValue(cacheKey, currentList, WRITE_THROUGH_TTL_SECONDS);
		// console.log(`Removed item from KV and updated Edge Cache for key: ${cacheKey}`);
		return true; // Removed
	}
	return false; // Not found
}

/** [内部] 批量向 KV 列表添加项目 (去重) (写入 KV 并更新 Edge Cache) */
async function _addItemsToList(key: Deno.KvKey, itemsToAdd: string[], listName: string): Promise<void> {
	if (!Array.isArray(itemsToAdd)) {
		throw new Error(`${listName} must be an array of strings.`);
	}
	const cleanedInputItems = itemsToAdd.map(item => item?.trim()).filter(item => item && item.length > 0);
	if (cleanedInputItems.length === 0) {
		return; // 没有有效项可添加
	}

	// 1. 直接从 KV 读取当前列表以进行检查
	const currentList = await _getList(key);
	const currentSet = new Set(currentList);
	let addedCount = 0;

	for (const item of cleanedInputItems) {
		if (!currentSet.has(item)) {
			currentSet.add(item); // 先更新 Set，避免重复添加
			currentList.push(item);
			addedCount++;
		}
	}

	if (addedCount > 0) {
		// 2. 如果有新项添加，写入 KV
		const kv = await ensureKv(); // Use await
		await kv.set(key, currentList); // Direct set to KV

		// 3. 更新 Edge Cache (Write-Through)
		const cacheKey = key.join('_');
		await setEdgeCacheValue(cacheKey, currentList, WRITE_THROUGH_TTL_SECONDS);
		// console.log(`Added ${addedCount} items to KV and updated Edge Cache for key: ${cacheKey}`);
	}
}

/** [内部] 清空 KV 中的列表 (删除 KV 并更新 Edge Cache 为默认值) */
async function _clearList(key: Deno.KvKey, listName: string): Promise<void> {
	await _deleteKvKey(key); // _deleteKvKey 内部处理 KV 删除和缓存更新
	console.log(`${listName} list cleared from KV and Edge Cache set to default.`);
}

// --- 触发密钥管理 ---

/** [重构] 从 Edge Cache 获取触发密钥 (Set) */
export async function getTriggerKeys(): Promise<Set<string>> {
	const keys = await getConfigValue<string[]>(CACHE_KEYS.TRIGGER_KEYS, DEFAULT_VALUES[CACHE_KEYS.TRIGGER_KEYS]);
	return new Set(keys || []);
}

/** [重构] 添加触发密钥 (调用 _addItemToSet) */
export async function addTriggerKey(key: string): Promise<void> {
	await _addItemToSet(TRIGGER_KEYS_KEY, key);
}

/** [重构] 移除触发密钥 (调用 _removeItemFromList) */
export async function removeTriggerKey(key: string): Promise<void> {
	await _removeItemFromList(TRIGGER_KEYS_KEY, key);
}

/** [重构] 检查是否为触发密钥 (从 Edge Cache 读取) */
export async function isTriggerKey(providedKey: string | null): Promise<boolean> {
	if (!providedKey) return false;
	const triggerKeys = await getTriggerKeys(); // await 读取 Edge Cache
	return triggerKeys.has(providedKey.trim());
}


// --- 主密钥池管理 ---

/** [重构] 获取主密钥池中的所有密钥 (Array) (从 Edge Cache 读取) */
export async function getPoolKeys(): Promise<string[]> {
	return await getConfigValue<string[]>(CACHE_KEYS.POOL_KEYS, DEFAULT_VALUES[CACHE_KEYS.POOL_KEYS]);
}

/** [重构] 添加密钥到主密钥池 (调用 _addItemsToList) */
export async function addPoolKeys(keys: string[]): Promise<void> {
	await _addItemsToList(POOL_KEYS_KEY, keys, 'Pool Keys');
}

/** [重构] 从主密钥池移除单个密钥 (调用 _removeItemFromList) */
export async function removePoolKey(key: string): Promise<void> {
	await _removeItemFromList(POOL_KEYS_KEY, key);
}

/** [重构] 清空主密钥池 (调用 _clearList) */
export async function clearPoolKeys(): Promise<void> {
	await _clearList(POOL_KEYS_KEY, 'Pool Keys');
}

/** [重构] 获取下一个密钥池密钥 (从 Edge Cache 读取列表, 随机选择) */
export async function getNextPoolKey(): Promise<string | null> {
	const poolKeys = await getPoolKeys(); // await 读取 Edge Cache

	if (!poolKeys || poolKeys.length === 0) {
		// console.warn("Pool key requested but pool is empty or failed to load from cache.");
		return null;
	}

	// 随机选择一个索引
	const randomIndex = Math.floor(Math.random() * poolKeys.length);
	return poolKeys[randomIndex];
}


// --- 指定密钥 (Fallback Key) 管理 ---

/** [重构] 获取指定密钥 (从 Edge Cache 读取) */
export async function getFallbackKey(): Promise<string | null> {
	return await getConfigValue<string | null>(CACHE_KEYS.FALLBACK_KEY, DEFAULT_VALUES[CACHE_KEYS.FALLBACK_KEY]);
}

/** [重构] 设置指定密钥 (调用 _setKvValue/_deleteKvKey) */
export async function setFallbackKey(key: string | null): Promise<void> {
	const trimmedKey = key?.trim();
	if (trimmedKey && trimmedKey.length > 0) {
		await _setKvValue(FALLBACK_KEY_KEY, trimmedKey);
	} else {
		// 如果传入 null 或空字符串，则删除
		await _deleteKvKey(FALLBACK_KEY_KEY);
	}
}


// --- 指定密钥触发模型 (Fallback Models) 管理 ---

/** [重构] 获取触发指定密钥的模型列表 (Set) (从 Edge Cache 读取) */
export async function getFallbackModels(): Promise<Set<string>> {
	const models = await getConfigValue<string[]>(CACHE_KEYS.FALLBACK_MODELS, DEFAULT_VALUES[CACHE_KEYS.FALLBACK_MODELS]);
	return new Set(models || []);
}

/** [重构] 添加指定密钥触发模型 (调用 _addItemsToList) */
export async function addFallbackModels(models: string[]): Promise<void> {
	await _addItemsToList(FALLBACK_MODELS_KEY, models, 'Fallback Models');
}

/** [重构] 清空指定密钥触发模型 (调用 _clearList) */
export async function clearFallbackModels(): Promise<void> {
	await _clearList(FALLBACK_MODELS_KEY, 'Fallback Models');
}


// --- API 重试次数管理 ---

/** [重构] 获取 API 调用最大重试次数 (从 Edge Cache 读取) */
export async function getApiRetryLimit(): Promise<number> {
	return await getConfigValue<number>(CACHE_KEYS.API_RETRY_LIMIT, DEFAULT_VALUES[CACHE_KEYS.API_RETRY_LIMIT]);
}

/** [重构] 设置 API 调用最大重试次数 (调用 _setKvValue) */
export async function setApiRetryLimit(limit: number): Promise<void> {
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
		throw new Error("API retry limit must be a positive integer.");
	}
	await _setKvValue(API_RETRY_LIMIT_KEY, limit);
}


// --- GCP 凭证字符串管理 ---

/** [重构] 设置 GCP 凭证字符串 (调用 _setKvValue/_deleteKvKey) */
export async function setGcpCredentialsString(credentials: string | null): Promise<void> {
	const trimmedCredentials = credentials?.trim();
	if (trimmedCredentials && trimmedCredentials.length > 0) {
		// 验证一下是否能解析，避免存入完全无效的字符串？可选
		// try {
		// 	parseCreds(trimmedCredentials);
		// } catch (e) {
		// 	throw new Error("Invalid GCP credentials format provided.");
		// }
		await _setKvValue(GCP_CREDENTIALS_STRING_KEY, trimmedCredentials);
	} else {
		await _deleteKvKey(GCP_CREDENTIALS_STRING_KEY);
	}
}

/** [重构] 获取 GCP 凭证字符串 (从 Edge Cache 读取) */
export async function getGcpCredentialsString(): Promise<string | null> {
	return await getConfigValue<string | null>(CACHE_KEYS.GCP_CREDENTIALS_STRING, DEFAULT_VALUES[CACHE_KEYS.GCP_CREDENTIALS_STRING]);
}

// --- GCP 凭证解析 (保持不变) ---
const isValidCred = (cred: any): cred is GcpCredentials =>
	cred?.type === 'service_account' && // 添加类型检查
	cred?.project_id &&
	cred?.private_key_id &&
	cred?.private_key &&
	cred?.client_email;

export const parseCreds = (jsonStr: string): GcpCredentials[] => {
	if (!jsonStr || typeof jsonStr !== 'string') {
		return [];
	}
	try {
		// 尝试直接解析 JSON
		const p = JSON.parse(jsonStr);
		if (Array.isArray(p)) {
			// 如果是数组，过滤有效的凭证
			return p.filter(isValidCred);
		} else if (isValidCred(p)) {
			// 如果是单个有效凭证对象
			return [p];
		}
	} catch { /* 忽略 JSON 解析错误，尝试其他方法 */ }

	try {
		// 尝试处理逗号分隔的 JSON 对象（可能缺少外层括号）
		let f = jsonStr.trim();
		if (!f.startsWith('[')) {
			f = `[${f.replace(/}\s*,?\s*{/g, '},{')}]`; // 修复可能的缺失逗号
		}
		const p = JSON.parse(f);
		if (Array.isArray(p)) {
			return p.filter(isValidCred);
		}
	} catch { /* 忽略第二种解析错误 */ }

	// 尝试使用正则表达式提取 JSON 对象（作为最后的手段）
	return (jsonStr.match(/\{(?:[^{}]|{[^{}]*})*\}/g) || [])
		.map(s => {
			try {
				const p = JSON.parse(s.trim());
				return isValidCred(p) ? p : null;
			} catch {
				return null;
			}
		})
		.filter((c): c is GcpCredentials => c !== null); // 类型守卫过滤
};


// --- GCP 默认 Location 管理 ---

/** [重构] 设置默认 GCP Location (调用 _setKvValue/_deleteKvKey) */
export async function setGcpDefaultLocation(location: string | null): Promise<void> {
	const trimmedLocation = location?.trim();
	if (trimmedLocation && trimmedLocation.length > 0) {
		await _setKvValue(GCP_DEFAULT_LOCATION_KEY, trimmedLocation);
	} else {
		// 如果传入 null 或空字符串，则删除（恢复默认 'global' 由 get 处理）
		await _deleteKvKey(GCP_DEFAULT_LOCATION_KEY);
	}
}

/** [重构] 获取默认 GCP Location (从 Edge Cache 读取) */
export async function getGcpDefaultLocation(): Promise<string> {
	return await getConfigValue<string>(CACHE_KEYS.GCP_DEFAULT_LOCATION, DEFAULT_VALUES[CACHE_KEYS.GCP_DEFAULT_LOCATION]);
}


// --- Vertex AI 模型列表管理 ---

/** [重构] 获取触发 Vertex AI 代理的模型列表 (Set) (从 Edge Cache 读取) */
export async function getVertexModels(): Promise<Set<string>> {
	const models = await getConfigValue<string[]>(CACHE_KEYS.VERTEX_MODELS, DEFAULT_VALUES[CACHE_KEYS.VERTEX_MODELS]);
	return new Set(models || []);
}

/** [重构] 添加 Vertex AI 模型 (调用 _addItemsToList) */
export async function addVertexModels(models: string[]): Promise<void> {
	await _addItemsToList(VERTEX_MODELS_KEY, models, 'Vertex Models');
}

/** [重构] 清空 Vertex AI 模型列表 (调用 _clearList) */
export async function clearVertexModels(): Promise<void> {
	await _clearList(VERTEX_MODELS_KEY, 'Vertex Models');
}

/** [重构] 检查模型名称是否属于 Vertex AI 模型列表 (从 Edge Cache 读取) */
export async function isVertexModel(modelName: string | null): Promise<boolean> {
	if (!modelName) return false;
	const vertexModels = await getVertexModels(); // await 读取 Edge Cache
	return vertexModels.has(modelName.trim());
}

// --- API 路径映射管理 ---

/** [重构] 获取 API 路径映射 (从 Edge Cache 读取) */
export async function getApiMappings(): Promise<Record<string, string>> {
	return await getConfigValue<Record<string, string>>(CACHE_KEYS.API_MAPPINGS, DEFAULT_VALUES[CACHE_KEYS.API_MAPPINGS]);
}

/** [重构] 设置 API 路径映射 (调用 _setKvValue) */
export async function setApiMappings(mappings: Record<string, string>): Promise<void> {
	if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) { // 更严格的对象检查
		throw new Error("Mappings must be a non-null, non-array object.");
	}
	// 可选：添加对 prefix 和 URL 格式的验证
	for (const [prefix, url] of Object.entries(mappings)) {
		if (typeof prefix !== 'string' || !prefix.startsWith('/')) {
			throw new Error(`Invalid prefix format: "${prefix}". Must start with '/'.`);
		}
		if (typeof url !== 'string' || !url.startsWith('http')) {
			throw new Error(`Invalid URL format for prefix "${prefix}": "${url}". Must start with 'http'.`);
		}
		try {
			new URL(url); // 验证 URL 是否可解析
		} catch {
			throw new Error(`Invalid URL for prefix "${prefix}": "${url}".`);
		}
	}
	await _setKvValue(API_MAPPINGS_KEY, mappings);
}

/** [重构] 清空 API 路径映射 (调用 _deleteKvKey) */
export async function clearApiMappings(): Promise<void> {
	await _deleteKvKey(API_MAPPINGS_KEY);
}

// --- 核心 API 密钥选择逻辑 (使用重构后的缓存读取函数) ---

/** [重构] 检查模型名称是否属于 Fallback 模型列表 (从 Edge Cache 读取) */
export async function isFallbackModel(modelName: string | null): Promise<boolean> {
	if (!modelName) return false;
	const fallbackModels = await getFallbackModels(); // await 读取 Edge Cache
	return fallbackModels.has(modelName.trim());
}

/** [重构] 获取请求的 API Key (依赖 Edge Cache 读取) */
export async function getApiKeyForRequest(
	userProvidedKey: string | null,
	modelName: string | null
): Promise<ApiKeyResult | null> {
	if (!userProvidedKey) {
		// console.log("getApiKeyForRequest: No user provided key.");
		return null; // 没有提供 key，直接返回 null
	}

	// 检查是否为触发密钥 (从缓存读取)
	const isKeyTrigger = await isTriggerKey(userProvidedKey);

	if (!isKeyTrigger) {
		// console.log("getApiKeyForRequest: User key is not a trigger key.");
		return { key: userProvidedKey, source: 'user' }; // 不是触发密钥，直接使用用户提供的密钥
	}

	// 是触发密钥，检查模型是否在 Fallback 列表 (从缓存读取)
	if (await isFallbackModel(modelName)) {
		const fallbackKey = await getFallbackKey(); // 从缓存读取 Fallback Key
		if (fallbackKey) {
			// console.log(`getApiKeyForRequest: Using fallback key for model "${modelName}".`);
			return { key: fallbackKey, source: 'fallback' }; // 找到 Fallback Key，使用它
		} else {
			console.warn(`Fallback model "${modelName}" triggered, but no fallback key is set.`);
			// Fallback 模型触发但未设置 Fallback Key，继续尝试 Pool Key
		}
	}

	// 不是 Fallback 模型或 Fallback Key 未设置，尝试从 Pool 获取 (从缓存读取 + 随机)
	const poolKey = await getNextPoolKey();
	if (poolKey) {
		// console.log("getApiKeyForRequest: Using a pool key.");
		return { key: poolKey, source: 'pool' }; // 找到 Pool Key，使用它
	}

	// 如果 Pool Key 也为空
	console.warn("getApiKeyForRequest: Trigger key provided, but fallback not applicable and pool is empty.");
	return null; // 触发密钥，但无法匹配 Fallback 且 Pool 为空，返回 null
}

// 移除不再使用的 _getKvValue 和 _getList 的导出
// _getKvValue 不再需要导出
// _getList 仍然被 _addItemToSet 和 _removeItemFromList 使用，保留内部定义