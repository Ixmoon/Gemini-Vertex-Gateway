// --- 导入缓存模块 ---
import { CACHE_KEYS, getConfigValue, setEdgeCacheValue } from "./cache.ts"; // 移除 DEFAULT_VALUES 导入

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

// --- KV 键常量 ---
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

// --- KV 实例管理 (保持不变) ---
let kv: Deno.Kv | null = null;

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
	await setEdgeCacheValue(CACHE_KEYS.ADMIN_PASSWORD_HASH, newHash); // 移除 TTL
	console.log("Admin password updated in KV and Edge Cache.");
}

/** [修正] 直接从 KV 获取管理员密码哈希 (用于管理界面) */
export async function getAdminPasswordHash(): Promise<string | null> {
	const result = await getKvValueDirectly<string>(ADMIN_PASSWORD_HASH_KEY);
	return result === KV_NOT_FOUND ? null : result;
}

/** [重构] 验证管理员密码 (直接从 KV 读取哈希) */
export async function verifyAdminPassword(password: string): Promise<boolean> {
	const storedHash = await getAdminPasswordHash(); // await 直接读取 KV
	if (!storedHash) {
		return false; // 哈希不存在，无法验证
	}
	return await verifyPassword(password, storedHash); // verifyPassword 本身是 async
}


// --- 内部通用 KV 助手函数 (用于 Write-Through 和需要直接读 KV 的场景) ---

/** [导出] 用于表示 KV 中未找到键的特殊 Symbol */
export const KV_NOT_FOUND = Symbol("KV_NOT_FOUND");

/**
 * [导出] [内部] 获取任意类型的单个 KV 值 (供 cache.ts 回退使用)
 * 能够区分 KV 中的 null 值和键未找到的情况。
 * @param key Deno.KvKey
 * @returns Promise<T | null | typeof KV_NOT_FOUND>
 */
export async function getKvValueDirectly<T>(key: Deno.KvKey): Promise<T | null | typeof KV_NOT_FOUND> {
	const kv = await ensureKv(); // Use await
	const result = await kv.get<T>(key);

	if (result.versionstamp === null) {
		// versionstamp 为 null 表示键不存在
		return KV_NOT_FOUND;
	} else {
		// versionstamp 存在，表示键存在，返回其值 (可能是 null)
		return result.value;
	}
}

/** [内部] 设置任意类型的单个 KV 值 (写入 KV 并更新 Edge Cache) */
async function _setKvValue<T>(key: Deno.KvKey, value: T): Promise<void> {
	const kv = await ensureKv(); // Use await
	// 1. 写入 KV
	await kv.set(key, value);
	// 2. 更新 Edge Cache (Write-Through)
	const cacheKey = key.join('_');
	await setEdgeCacheValue(cacheKey, value); // 移除 TTL
	// console.log(`Set KV and updated Edge Cache for key: ${cacheKey}`);
}

/** [内部] 删除任意 KV 键 (删除 KV 并更新 Edge Cache 为默认值) */
async function _deleteKvKey(key: Deno.KvKey): Promise<void> {
	const kv = await ensureKv(); // Use await
	// 1. 删除 KV
	await kv.delete(key);
	// 2. 更新 Edge Cache 为默认值 (Write-Through for delete)
	const cacheKey = key.join('_');
	// 删除 KV 后，将缓存值设为 null 来表示删除或不存在
	await setEdgeCacheValue(cacheKey, null); // 移除 TTL
	// console.log(`Deleted KV and set Edge Cache to null for key: ${cacheKey}`);
}

/** [内部] 从 KV 获取字符串列表 (仅限内部需要直接读 KV 的场景) */
async function _getList(key: Deno.KvKey): Promise<string[]> {
	// 保持这个函数，因为 _addItemToSet 和 _removeItemFromList 需要先读 KV
	// 使用导出的函数，并处理 KV_NOT_FOUND
	const result = await getKvValueDirectly<string[]>(key);
	if (result === KV_NOT_FOUND || result === null) {
		return []; // 如果未找到或值为 null，返回空数组
	}
	return result; // 否则返回获取到的数组
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
		await setEdgeCacheValue(cacheKey, currentList); // 移除 TTL
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
		await setEdgeCacheValue(cacheKey, currentList); // 移除 TTL
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
		await setEdgeCacheValue(cacheKey, currentList); // 移除 TTL
		// console.log(`Added ${addedCount} items to KV and updated Edge Cache for key: ${cacheKey}`);
	}
}

/** [内部] 清空 KV 中的列表 (删除 KV 并更新 Edge Cache 为默认值) */
async function _clearList(key: Deno.KvKey, listName: string): Promise<void> {
	await _deleteKvKey(key); // _deleteKvKey 内部处理 KV 删除和缓存更新
	console.log(`${listName} list cleared from KV and Edge Cache set to default.`);
}

// --- 触发密钥管理 ---

/** [修正] 直接从 KV 获取触发密钥 (Set) (用于管理界面) */
export async function getTriggerKeys(): Promise<Set<string>> {
	const result = await getKvValueDirectly<string[]>(TRIGGER_KEYS_KEY);
	return result === KV_NOT_FOUND || result === null ? new Set() : new Set(result);
}

/** [重构] 添加触发密钥 (调用 _addItemToSet) */
export async function addTriggerKey(key: string): Promise<void> {
	await _addItemToSet(TRIGGER_KEYS_KEY, key);
}

/** [重构] 移除触发密钥 (调用 _removeItemFromList) */
export async function removeTriggerKey(key: string): Promise<void> {
	await _removeItemFromList(TRIGGER_KEYS_KEY, key);
}

/** [重构] 检查是否为触发密钥 (优先从 Edge Cache 读取) */
export async function isTriggerKey(providedKey: string | null): Promise<boolean> {
	if (!providedKey) return false;
	// 使用 getConfigValue 从缓存读取
	const triggerKeysArray = await getConfigValue<string[]>(CACHE_KEYS.TRIGGER_KEYS);
	const triggerKeys = triggerKeysArray ? new Set(triggerKeysArray) : new Set<string>();
	return triggerKeys.has(providedKey.trim());
}


// --- 主密钥池管理 ---

/** [修正] 直接从 KV 获取主密钥池中的所有密钥 (Array) (用于管理界面) */
export async function getPoolKeys(): Promise<string[]> {
	const result = await getKvValueDirectly<string[]>(POOL_KEYS_KEY);
	return result === KV_NOT_FOUND || result === null ? [] : result;
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

/** [重构] 获取下一个密钥池密钥 (优先从 Edge Cache 读取列表, 随机选择) */
export async function getNextPoolKey(): Promise<string | null> {
	// 使用 getConfigValue 从缓存读取
	const poolKeys = await getConfigValue<string[]>(CACHE_KEYS.POOL_KEYS);

	if (!poolKeys || poolKeys.length === 0) {
		// console.warn("Pool key requested but pool is empty or failed to load from cache/KV.");
		return null;
	}

	// 随机选择一个索引
	const randomIndex = Math.floor(Math.random() * poolKeys.length);
	return poolKeys[randomIndex];
}


// --- 指定密钥 (Fallback Key) 管理 ---

/** [修正] 直接从 KV 获取指定密钥 (用于管理界面) */
export async function getFallbackKey(): Promise<string | null> {
	const result = await getKvValueDirectly<string>(FALLBACK_KEY_KEY);
	return result === KV_NOT_FOUND ? null : result;
}

/** [新增] 从 Edge Cache 获取指定密钥 (用于代理逻辑) */
export async function getFallbackKeyFromCache(): Promise<string | null> {
	// 使用 getConfigValue 从缓存读取
	const fallbackKey = await getConfigValue<string>(CACHE_KEYS.FALLBACK_KEY);
	return fallbackKey; // getConfigValue 内部处理了 KV 回退和 null 情况
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

/** [修正] 直接从 KV 获取触发指定密钥的模型列表 (Set) (用于管理界面) */
export async function getFallbackModels(): Promise<Set<string>> {
	const result = await getKvValueDirectly<string[]>(FALLBACK_MODELS_KEY);
	return result === KV_NOT_FOUND || result === null ? new Set() : new Set(result);
}

/** [重构] 添加指定密钥触发模型 (调用 _addItemsToList) */
export async function addFallbackModels(models: string[]): Promise<void> {
	await _addItemsToList(FALLBACK_MODELS_KEY, models, 'Fallback Models');
}

/** [重构] 清空指定密钥触发模型 (调用 _clearList) */
export async function clearFallbackModels(): Promise<void> {
	await _clearList(FALLBACK_MODELS_KEY, 'Fallback Models');
}

/** [重构] 检查模型名称是否属于 Fallback 模型列表 (优先从 Edge Cache 读取) */
export async function isFallbackModel(modelName: string | null): Promise<boolean> {
	if (!modelName) return false;
	// 使用 getConfigValue 从缓存读取
	const fallbackModelsArray = await getConfigValue<string[]>(CACHE_KEYS.FALLBACK_MODELS);
	const fallbackModels = fallbackModelsArray ? new Set(fallbackModelsArray) : new Set<string>();
	return fallbackModels.has(modelName.trim());
}


// --- API 重试次数管理 ---

/** [修正] 直接从 KV 获取 API 调用最大重试次数 (用于管理界面) */
export async function getApiRetryLimit(): Promise<number> {
	const result = await getKvValueDirectly<number>(API_RETRY_LIMIT_KEY);
	// 如果 KV 未找到、值为 null 或无效，则使用默认值 3
	return result === KV_NOT_FOUND || result === null || !Number.isInteger(result) || result < 1 ? 3 : result;
}

/** [新增] 从 Edge Cache 获取 API 调用最大重试次数 (用于代理逻辑) */
export async function getApiRetryLimitFromCache(): Promise<number> {
	// 使用 getConfigValue 从缓存读取
	const limit = await getConfigValue<number>(CACHE_KEYS.API_RETRY_LIMIT);
	// 如果缓存或 KV 回退结果无效，则使用默认值 3
	return limit === null || !Number.isInteger(limit) || limit < 1 ? 3 : limit;
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
		await _setKvValue(GCP_CREDENTIALS_STRING_KEY, trimmedCredentials);
	} else {
		await _deleteKvKey(GCP_CREDENTIALS_STRING_KEY);
	}
}

/** [修正] 直接从 KV 获取 GCP 凭证字符串 (用于管理界面) */
export async function getGcpCredentialsString(): Promise<string | null> {
	const result = await getKvValueDirectly<string>(GCP_CREDENTIALS_STRING_KEY);
	return result === KV_NOT_FOUND ? null : result;
}

// --- GCP 凭证解析 (保持不变) ---
export const isValidCred = (cred: any): cred is GcpCredentials =>
	cred?.type === 'service_account' && // 添加类型检查
	cred?.project_id &&
	cred?.private_key_id &&
	cred?.private_key &&
	cred?.client_email;
// --- GCP 凭证解析 (保持不变) ---
// isValidCred is now defined and exported only once in this file (in the parseCreds section).
// The previous duplicate definition has been removed.
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

/** [修正] 直接从 KV 获取默认 GCP Location (用于管理界面) */
export async function getGcpDefaultLocation(): Promise<string> {
	const result = await getKvValueDirectly<string>(GCP_DEFAULT_LOCATION_KEY);
	// 如果 KV 未找到、值为 null 或为空，则使用默认值 'global'
	return result === KV_NOT_FOUND || result === null || result === '' ? 'global' : result;
}

/** [新增] 从 Edge Cache 获取默认 GCP Location (用于代理逻辑) */
export async function getGcpDefaultLocationFromCache(): Promise<string> {
	// 使用 getConfigValue 从缓存读取
	const location = await getConfigValue<string>(CACHE_KEYS.GCP_DEFAULT_LOCATION);
	// 如果缓存或 KV 回退结果无效，则使用默认值 'global'
	return location === null || location === '' ? 'global' : location;
}


// --- Vertex AI 模型列表管理 ---

/** [修正] 直接从 KV 获取触发 Vertex AI 代理的模型列表 (Set) (用于管理界面) */
export async function getVertexModels(): Promise<Set<string>> {
	const result = await getKvValueDirectly<string[]>(VERTEX_MODELS_KEY);
	return result === KV_NOT_FOUND || result === null ? new Set() : new Set(result);
}

/** [重构] 添加 Vertex AI 模型 (调用 _addItemsToList) */
export async function addVertexModels(models: string[]): Promise<void> {
	await _addItemsToList(VERTEX_MODELS_KEY, models, 'Vertex Models');
}

/** [重构] 清空 Vertex AI 模型列表 (调用 _clearList) */
export async function clearVertexModels(): Promise<void> {
	await _clearList(VERTEX_MODELS_KEY, 'Vertex Models');
}

/** [重构] 检查模型名称是否属于 Vertex AI 模型列表 (优先从 Edge Cache 读取) */
export async function isVertexModel(modelName: string | null): Promise<boolean> {
	if (!modelName) return false;
	// 使用 getConfigValue 从缓存读取
	const vertexModelsArray = await getConfigValue<string[]>(CACHE_KEYS.VERTEX_MODELS);
	const vertexModels = vertexModelsArray ? new Set(vertexModelsArray) : new Set<string>();
	return vertexModels.has(modelName.trim());
}

// --- API 路径映射管理 ---

/** [修正] 直接从 KV 获取 API 路径映射 (用于管理界面) */
export async function getApiMappings(): Promise<Record<string, string>> {
	const result = await getKvValueDirectly<Record<string, string>>(API_MAPPINGS_KEY);
	return result === KV_NOT_FOUND || result === null ? {} : result;
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

/** [重构] 获取请求的 API Key (依赖 Edge Cache 读取) */
export async function getApiKeyForRequest(
	userProvidedKey: string | null,
	modelName: string | null
): Promise<ApiKeyResult | null> {
	if (!userProvidedKey) {
		// console.log("getApiKeyForRequest: No user provided key.");
		return null; // 没有提供 key，直接返回 null
	}

	// 检查是否为触发密钥 (已修改为优先读缓存)
	const isKeyTrigger = await isTriggerKey(userProvidedKey);

	if (!isKeyTrigger) {
		// console.log("getApiKeyForRequest: User key is not a trigger key.");
		return { key: userProvidedKey, source: 'user' }; // 不是触发密钥，直接使用用户提供的密钥
	}

	// 是触发密钥，检查模型是否在 Fallback 列表 (已修改为优先读缓存)
	if (await isFallbackModel(modelName)) {
		// 从缓存读取 Fallback Key
		const fallbackKey = await getFallbackKeyFromCache(); // 使用新增的缓存函数
		if (fallbackKey) {
			// console.log(`getApiKeyForRequest: Using fallback key for model "${modelName}".`);
			return { key: fallbackKey, source: 'fallback' }; // 找到 Fallback Key，使用它
		} else {
			console.warn(`Fallback model "${modelName}" triggered, but no fallback key is set.`);
			// Fallback 模型触发但未设置 Fallback Key，继续尝试 Pool Key
		}
	}

	// 不是 Fallback 模型或 Fallback Key 未设置，尝试从 Pool 获取 (已修改为优先读缓存 + 随机)
	const poolKey = await getNextPoolKey();
	if (poolKey) {
		// console.log("getApiKeyForRequest: Using a pool key.");
		return { key: poolKey, source: 'pool' }; // 找到 Pool Key，使用它
	}

	// 如果 Pool Key 也为空
	console.warn("getApiKeyForRequest: Trigger key provided, but fallback not applicable and pool is empty.");
	return null; // 触发密钥，但无法匹配 Fallback 且 Pool 为空，返回 null
}