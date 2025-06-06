// --- 类型定义 ---
export type ApiKeySource = 'user' | 'fallback' | 'pool'; // 导出 Key 来源类型
export type ApiKeyResult = { key: string; source: ApiKeySource }; // 定义并导出 ApiKeyResult 类型
// --- KV 键常量 ---
const ADMIN_PASSWORD_HASH_KEY = ["admin_password_hash"];
const TRIGGER_KEYS_KEY = ["trigger_keys"]; // 存储为 string[]，逻辑上视为 Set
const POOL_KEYS_KEY = ["pool_keys"]; // string[]
const POOL_KEY_ATOMIC_INDEX_KEY = ["pool_key_atomic_index"]; // 新的原子计数器键 (BigInt)
export const GCP_CREDENTIAL_ATOMIC_INDEX_KEY = ["gcp_credential_atomic_index"]; // GCP 凭证原子计数器键 (BigInt)
const FALLBACK_KEY_KEY = ["fallback_key"]; // string | null
const GCP_CREDENTIALS_STRING_KEY = ["gcp_credentials_string"]; // 存储 GCP JSON 凭证完整字符串
const GCP_DEFAULT_LOCATION_KEY = ["gcp_default_location"]; // 存储默认 GCP Location
const VERTEX_MODELS_KEY = ["vertex_models"]; // 触发 Vertex AI 代理的模型列表 (string[])
const FALLBACK_MODELS_KEY = ["fallback_models"]; // string[]，逻辑上视为 Set
const API_RETRY_LIMIT_KEY = ["api_retry_limit"]; // number | null (用户可配置的最大 API 重试次数)
const API_MAPPINGS_KEY = ["api_mappings"]; // 存储 API 路径映射 (Record<string, string>)
// --- KV 实例管理 ---
let kv: Deno.Kv | null = null;

/**
 * 打开或获取 KV 存储实例 (异步)
 */
export async function openKv(): Promise<Deno.Kv> {
	if (!kv) {
		kv = await Deno.openKv();
	}
	return kv;
}

/**
 * 确保 KV 实例已初始化 (同步)
 */
function ensureKv(): Deno.Kv {
	if (!kv) {
		throw new Error("Deno KV store is not open. Call openKv() first.");
	}
	return kv;
}

// --- 密码哈希与验证 (保持不变) ---

async function hashPassword(password: string): Promise<string> { /* ... Sames as before ... */
	const encoder = new TextEncoder();
	const data = encoder.encode(password);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> { /* ... Sames as before ... */
	if (!password || !storedHash) {
		return false;
	}
	const inputHash = await hashPassword(password);
	return inputHash === storedHash;
}

// --- 管理员密码 KV 操作 (保持不变) ---

export async function setAdminPassword(password: string): Promise<void> { /* ... Sames as before ... */
	const kv = ensureKv();
	if (!password || typeof password !== 'string' || password.length < 8) {
	throw new Error("Password must be a string of at least 8 characters.");
	}
	const newHash = await hashPassword(password);
	await kv.set(ADMIN_PASSWORD_HASH_KEY, newHash);
}

export async function getAdminPasswordHash(): Promise<string | null> { /* ... Sames as before ... */
	const kv = ensureKv();
	const result = await kv.get<string>(ADMIN_PASSWORD_HASH_KEY);
	return result.value;
}

export async function verifyAdminPassword(password: string): Promise<boolean> { /* ... Sames as before ... */
	const storedHash = await getAdminPasswordHash();
	if (!storedHash) {
		return false;
	}
	return verifyPassword(password, storedHash);
}


// --- 内部通用 KV 助手函数 ---

/** [内部] 获取任意类型的单个 KV 值 */
async function _getKvValue<T>(key: string[]): Promise<T | null> {
	const kv = ensureKv();
	const result = await kv.get<T>(key);
	return result.value ?? null; // Return null if value is null or undefined
}

/** [内部] 设置任意类型的单个 KV 值 */
async function _setKvValue<T>(key: string[], value: T): Promise<void> {
	const kv = ensureKv();
	await kv.set(key, value);
}

/** [内部] 删除任意 KV 键 */
async function _deleteKvKey(key: string[]): Promise<void> {
	const kv = ensureKv();
	await kv.delete(key);
}

/** [内部] 从 KV 获取字符串列表 */
async function _getList(key: string[]): Promise<string[]> {
	return (await _getKvValue<string[]>(key)) || [];
}

/** [内部] 向 KV 中存储的列表（视为 Set）添加单个唯一字符串 */
async function _addItemToSet(key: string[], item: string): Promise<boolean> {
	const trimmedItem = item?.trim();
	if (!trimmedItem) {
		throw new Error("Item cannot be empty.");
	}
	const currentList = await _getList(key);
	const currentSet = new Set(currentList);
	if (!currentSet.has(trimmedItem)) {
		currentList.push(trimmedItem);
		await _setKvValue(key, currentList);
		return true; // Added
	}
	return false; // Already exists
}

/** [内部] 从 KV 中存储的列表中移除单个字符串 */
async function _removeItemFromList(key: string[], item: string): Promise<boolean> {
	const trimmedItem = item?.trim();
	if (!trimmedItem) {
		throw new Error("Item cannot be empty.");
	}
	let currentList = await _getList(key);
	const initialLength = currentList.length;
	currentList = currentList.filter(i => i !== trimmedItem);
	if (currentList.length < initialLength) {
		await _setKvValue(key, currentList);
		return true; // Removed
	}
	return false; // Not found
}

/** [内部] 批量向 KV 列表添加项目 (去重) */
async function _addItemsToList(key: string[], itemsToAdd: string[], listName: string): Promise<void> {
	if (!Array.isArray(itemsToAdd)) {
		throw new Error(`${listName} must be an array of strings.`);
	}
	const cleanedInputItems = itemsToAdd.map(item => item?.trim()).filter(item => item && item.length > 0);
	if (cleanedInputItems.length === 0) {
		return;
	}
	const currentList = await _getList(key);
	const currentSet = new Set(currentList);
	let addedCount = 0;
	for (const item of cleanedInputItems) {
		if (!currentSet.has(item)) {
			currentSet.add(item);
			currentList.push(item);
			addedCount++;
		}
	}
	if (addedCount > 0) {
		await _setKvValue(key, currentList);
	}
}

/** [内部] 清空 KV 中的列表 */
async function _clearList(key: string[], _listName: string): Promise<void> {
	await _deleteKvKey(key);
}

/** [内部] 检查模型名称是否存在于指定的 KV 列表（Set）中 */
async function _isModelInKvList(modelName: string | null, listKey: string[]): Promise<boolean> {
	if (!modelName) {
		return false;
	}
	const modelList = await _getList(listKey); // 获取列表
	const modelSet = new Set(modelList);	   // 转换为 Set 以优化查找
	return modelSet.has(modelName.trim());	// 检查是否存在 (已去空格)
}

// --- 触发密钥管理 ---

/** 获取所有触发密钥 (Set) */
export async function getTriggerKeys(): Promise<Set<string>> {
	return new Set(await _getList(TRIGGER_KEYS_KEY));
}

/** 添加触发密钥 */
export async function addTriggerKey(key: string): Promise<void> {
	await _addItemToSet(TRIGGER_KEYS_KEY, key);
}

/** 删除触发密钥 */
export async function removeTriggerKey(key: string): Promise<void> {
	await _removeItemFromList(TRIGGER_KEYS_KEY, key);
}

// 检查触发密钥的逻辑本身不变，但依赖的 getTriggerKeys 已被重构
export async function isTriggerKey(providedKey: string): Promise<boolean> {
	if (!providedKey) return false;
	const triggerKeys = await getTriggerKeys(); // Uses refactored getter
	return triggerKeys.has(providedKey.trim());
}


// --- 主密钥池管理 ---

/** 获取主密钥池中的所有密钥 (Array) */
export async function getPoolKeys(): Promise<string[]> {
	return await _getList(POOL_KEYS_KEY);
}

/** 添加一个或多个密钥到主密钥池 */
export async function addPoolKeys(keys: string[]): Promise<void> {
	await _addItemsToList(POOL_KEYS_KEY, keys, 'Pool Keys');
}

/** 从主密钥池中删除一个密钥 */
export async function removePoolKey(key: string): Promise<void> {
	await _removeItemFromList(POOL_KEYS_KEY, key);
	// 注意：不再需要重置旧索引。原子计数器不受列表长度变化直接影响。
	// 如果需要严格的索引重置，可以在这里删除原子计数器键，但这通常不是轮换模式所必需的。
}

/** 清空主密钥池中的所有密钥 */
export async function clearPoolKeys(): Promise<void> {
	await _clearList(POOL_KEYS_KEY, 'Pool Keys');
	await _deleteKvKey(POOL_KEY_ATOMIC_INDEX_KEY); // 删除原子计数器键
	////console.log("Pool key atomic index cleared.");
}

// [已重构] 获取下一个密钥池密钥 (使用原子计数器轮换)
export async function getNextPoolKey(): Promise<string | null> {
	const kv = ensureKv();
	const poolKeys = await getPoolKeys();

	if (poolKeys.length === 0) {
		////console.warn("Pool key requested but pool is empty.");
		return null;
	}

	// 原子递增计数器并获取新值
	// 原子递增计数器
	const atomicIncRes = await kv.atomic().sum(POOL_KEY_ATOMIC_INDEX_KEY, 1n).commit();

	if (!atomicIncRes.ok) {
		console.error("Failed to atomically increment pool key index");
		// 递增失败，可以尝试返回第一个密钥或 null
		return poolKeys[0]; // 备选：返回第一个
	}

	// 递增成功后，获取当前的计数值
	const currentCountEntry = await kv.get<Deno.KvU64>(POOL_KEY_ATOMIC_INDEX_KEY);
	// sum 操作存储为 KvU64 (BigInt)
	if (currentCountEntry.value === null) {
		console.error("Failed to get pool key index value after increment");
		// 获取失败，可以尝试返回第一个密钥或 null
		return poolKeys[0]; // 备选：返回第一个
	}

	// 使用 BigInt 进行模运算获取索引
	const count = currentCountEntry.value.value; // 获取 BigInt 值
	const index = Number(count % BigInt(poolKeys.length)); // 确保 poolKeys.length > 0

	// 校验计算出的索引（理论上总是有效，除非模数为0，但前面已检查长度）
	if (index < 0 || index >= poolKeys.length) {
		console.error(`Calculated invalid pool key index: ${index} from count ${count}`);
		return poolKeys[0]; // 返回第一个作为备用
	}

	// 返回基于原子计数器计算出的索引对应的密钥
	return poolKeys[index];
}


// --- 指定密钥 (Fallback Key) 管理 ---

/** 获取指定密钥 */
export async function getFallbackKey(): Promise<string | null> {
	return await _getKvValue<string>(FALLBACK_KEY_KEY);
}

/** 设置指定密钥 (留空或 null 以清除) */
export async function setFallbackKey(key: string | null): Promise<void> {
	const trimmedKey = key?.trim();
	if (trimmedKey && trimmedKey.length > 0) {
		await _setKvValue(FALLBACK_KEY_KEY, trimmedKey);
	} else {
		await _deleteKvKey(FALLBACK_KEY_KEY);
	}
}


// --- 指定密钥触发模型 (Fallback Models) 管理 ---

/** 获取触发指定密钥的模型列表 (Set) */
export async function getFallbackModels(): Promise<Set<string>> {
	return new Set(await _getList(FALLBACK_MODELS_KEY));
}

/** 添加一个或多个模型到触发指定密钥的模型列表 */
export async function addFallbackModels(models: string[]): Promise<void> {
	await _addItemsToList(FALLBACK_MODELS_KEY, models, 'Fallback Models');
}

/** 清空触发指定密钥的模型列表 */
export async function clearFallbackModels(): Promise<void> {
	await _clearList(FALLBACK_MODELS_KEY, 'Fallback Models');
}


// --- API 重试次数管理 ---

/**
 * 获取 API 调用最大重试次数 (默认 3)
 */
export async function getApiRetryLimit(): Promise<number> {
	const kv = ensureKv();
	const result = await kv.get<number>(API_RETRY_LIMIT_KEY);
	const limit = result.value;
	// 如果未设置、不是数字或小于 1，则返回默认值 3
	if (limit === null || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
		return 3; // 默认值
	}
	return limit;
}

/**
 * 设置 API 调用最大重试次数
 */
export async function setApiRetryLimit(limit: number): Promise<void> {
	const kv = ensureKv();
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
		throw new Error("API retry limit must be a positive integer.");
	}
	await kv.set(API_RETRY_LIMIT_KEY, limit);
}


// --- GCP 凭证字符串管理 ---

/** 设置 GCP 凭证字符串 */
export async function setGcpCredentialsString(credentials: string): Promise<void> {
	const trimmedCredentials = credentials?.trim();
	if (trimmedCredentials && trimmedCredentials.length > 0) {
		await _setKvValue(GCP_CREDENTIALS_STRING_KEY, trimmedCredentials);
	} else {
		await _deleteKvKey(GCP_CREDENTIALS_STRING_KEY);
	}
}

/** 获取 GCP 凭证字符串 */
export async function getGcpCredentialsString(): Promise<string | null> {
	return await _getKvValue<string>(GCP_CREDENTIALS_STRING_KEY);
}

// --- GCP 默认 Location 管理 ---

/** 设置默认 GCP Location */
export async function setGcpDefaultLocation(location: string): Promise<void> {
	const trimmedLocation = location?.trim();
	if (trimmedLocation && trimmedLocation.length > 0) {
		await _setKvValue(GCP_DEFAULT_LOCATION_KEY, trimmedLocation);
	} else {
		await _deleteKvKey(GCP_DEFAULT_LOCATION_KEY);
	}
}

/** 获取默认 GCP Location (默认 'global') */
export async function getGcpDefaultLocation(): Promise<string> {
	const location = await _getKvValue<string>(GCP_DEFAULT_LOCATION_KEY);
	return location || 'global'; // 如果未设置或为空，则返回 'global'
}


// --- Vertex AI 模型列表管理 ---

/** 获取触发 Vertex AI 代理的模型列表 (Set) */
export async function getVertexModels(): Promise<Set<string>> {
	return new Set(await _getList(VERTEX_MODELS_KEY));
}

/** 添加一个或多个模型到触发 Vertex AI 代理的模型列表 */
export async function addVertexModels(models: string[]): Promise<void> {
	await _addItemsToList(VERTEX_MODELS_KEY, models, 'Vertex Models');
}

/** 清空触发 Vertex AI 代理的模型列表 */
export async function clearVertexModels(): Promise<void> {
	await _clearList(VERTEX_MODELS_KEY, 'Vertex Models');
}

/** 检查模型名称是否属于 Vertex AI 模型列表 */
export async function isVertexModel(modelName: string | null): Promise<boolean> {
	return await _isModelInKvList(modelName, VERTEX_MODELS_KEY); // 调用通用辅助函数
}
// --- API 路径映射管理 ---

/** 获取 API 路径映射 */
export async function getApiMappings(): Promise<Record<string, string>> {
	const mappings = await _getKvValue<Record<string, string>>(API_MAPPINGS_KEY);
	return mappings || {}; // 如果 KV 中不存在或为 null，返回空对象
}

/** 设置 API 路径映射 */
export async function setApiMappings(mappings: Record<string, string>): Promise<void> {
	if (typeof mappings !== 'object' || mappings === null) {
		throw new Error("Mappings must be a non-null object.");
	}
	// 可以添加更严格的验证，例如检查键和值是否都是字符串
	await _setKvValue(API_MAPPINGS_KEY, mappings);
}

/** 清空 API 路径映射 */
export async function clearApiMappings(): Promise<void> {
	await _deleteKvKey(API_MAPPINGS_KEY);
}

// --- 核心 API 密钥选择逻辑 ---

/** 检查模型名称是否属于 Fallback 模型列表 */
export async function isFallbackModel(modelName: string | null): Promise<boolean> {
	return await _isModelInKvList(modelName, FALLBACK_MODELS_KEY); // 调用通用辅助函数
}
export async function getApiKeyForRequest(
	userProvidedKey: string | null,
	modelName: string | null
): Promise<ApiKeyResult | null> { // 使用导出的 ApiKeyResult 类型
	if (!userProvidedKey) {
		return null;
	}

	const isKeyTrigger = await isTriggerKey(userProvidedKey); // Uses refactored isTriggerKey

	if (!isKeyTrigger) {
		return { key: userProvidedKey, source: 'user' };
	}

	// 使用新的 isFallbackModel 函数检查
	if (await isFallbackModel(modelName)) {
		const fallbackKey = await getFallbackKey(); // 获取 Fallback Key
		if (fallbackKey) {
			return { key: fallbackKey, source: 'fallback' };
		}
		// 如果模型在 fallback 列表但没有设置 fallback key，则继续尝试 Pool Key
	}
	const poolKey = await getNextPoolKey(); // Uses refactored getNextPoolKey which uses refactored getPoolKeys
	if (poolKey) {
		return { key: poolKey, source: 'pool' };
	}

	return null;
}