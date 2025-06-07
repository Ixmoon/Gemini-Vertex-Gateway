// --- 导入缓存模块 ---
import { globalCache, CACHE_KEYS, reloadKvConfig, initializeAndCacheGcpAuth } from "./cache.ts"; // Import reloadKvConfig

// --- 类型定义 ---
export type ApiKeySource = 'user' | 'fallback' | 'pool';
export type ApiKeyResult = { key: string; source: ApiKeySource };

// Gcp凭证定义 (Moved from proxy_handler.ts)
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

// --- KV 键常量 (Export all) ---
export const ADMIN_PASSWORD_HASH_KEY = ["admin_password_hash"];
export const TRIGGER_KEYS_KEY = ["trigger_keys"];
export const POOL_KEYS_KEY = ["pool_keys"];
export const POOL_KEY_ATOMIC_INDEX_KEY = ["pool_key_atomic_index"];
export const GCP_CREDENTIAL_ATOMIC_INDEX_KEY = ["gcp_credential_atomic_index"];
export const FALLBACK_KEY_KEY = ["fallback_key"];
export const GCP_CREDENTIALS_STRING_KEY = ["gcp_credentials_string"];
export const GCP_DEFAULT_LOCATION_KEY = ["gcp_default_location"];
export const VERTEX_MODELS_KEY = ["vertex_models"];
export const FALLBACK_MODELS_KEY = ["fallback_models"];
export const API_RETRY_LIMIT_KEY = ["api_retry_limit"];
export const API_MAPPINGS_KEY = ["api_mappings"];

// --- 内存缓存 (Remove old variables) ---
// let cachedApiMappings: Record<string, string> | null = null; // Removed

// --- KV 实例管理 ---
let kv: Deno.Kv | null = null;

export async function openKv(): Promise<Deno.Kv> {
	if (!kv) {
		kv = await Deno.openKv();
	}
	return kv;
}

/** [内部] 确保 KV 实例已初始化 (同步) - Exported */
export function ensureKv(): Deno.Kv {
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

export async function setAdminPassword(password: string): Promise<void> {
	const kv = ensureKv();
	if (!password || typeof password !== 'string' || password.length < 8) {
		throw new Error("Password must be a string of at least 8 characters.");
	}
	const newHash = await hashPassword(password);
	await kv.set(ADMIN_PASSWORD_HASH_KEY, newHash);
	await reloadKvConfig(ADMIN_PASSWORD_HASH_KEY); // Reload cache
}

// [重构] 从缓存获取管理员密码哈希
export function getAdminPasswordHash(): string | null {
	return globalCache.get<string | null>(CACHE_KEYS.ADMIN_PASSWORD_HASH) ?? null;
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
	const storedHash = getAdminPasswordHash(); // Read from cache
	if (!storedHash) {
		return false;
	}
	return verifyPassword(password, storedHash);
}


// --- 内部通用 KV 助手函数 ---

/** [内部] 获取任意类型的单个 KV 值 - Exported */
export async function _getKvValue<T>(key: Deno.KvKey): Promise<T | null> {
	const kv = ensureKv();
	const result = await kv.get<T>(key);
	return result.value ?? null;
}

/** [内部] 设置任意类型的单个 KV 值 */
async function _setKvValue<T>(key: Deno.KvKey, value: T): Promise<void> {
	const kv = ensureKv();
	await kv.set(key, value);
	// Reload cache after setting
	await reloadKvConfig(key);
}

/** [内部] 删除任意 KV 键 */
async function _deleteKvKey(key: Deno.KvKey): Promise<void> {
	const kv = ensureKv();
	await kv.delete(key);
	// Reload cache after deleting (will set default value)
	await reloadKvConfig(key);
}

/** [内部] 从 KV 获取字符串列表 - Exported */
export async function _getList(key: Deno.KvKey): Promise<string[]> {
	// Note: This is still needed for atomic operations/direct KV interactions if any remain
	return (await _getKvValue<string[]>(key)) || [];
}

/** [内部] 向 KV 中存储的列表（视为 Set）添加单个唯一字符串 */
async function _addItemToSet(key: Deno.KvKey, item: string): Promise<boolean> {
	const trimmedItem = item?.trim();
	if (!trimmedItem) {
		throw new Error("Item cannot be empty.");
	}
	// Read directly from KV for check-then-set logic
	const currentList = await _getList(key);
	const currentSet = new Set(currentList);
	if (!currentSet.has(trimmedItem)) {
		currentList.push(trimmedItem);
		const kv = ensureKv();
		await kv.set(key, currentList); // Direct set, then reload
		await reloadKvConfig(key);
		return true; // Added
	}
	return false; // Already exists
}

/** [内部] 从 KV 中存储的列表中移除单个字符串 */
async function _removeItemFromList(key: Deno.KvKey, item: string): Promise<boolean> {
	const trimmedItem = item?.trim();
	if (!trimmedItem) {
		throw new Error("Item cannot be empty.");
	}
	// Read directly from KV for check-then-set logic
	let currentList = await _getList(key);
	const initialLength = currentList.length;
	currentList = currentList.filter(i => i !== trimmedItem);
	if (currentList.length < initialLength) {
		const kv = ensureKv();
		await kv.set(key, currentList); // Direct set, then reload
		await reloadKvConfig(key);
		return true; // Removed
	}
	return false; // Not found
}

/** [内部] 批量向 KV 列表添加项目 (去重) */
async function _addItemsToList(key: Deno.KvKey, itemsToAdd: string[], listName: string): Promise<void> {
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
		const kv = ensureKv();
		await kv.set(key, currentList); // Direct set, then reload
		await reloadKvConfig(key);
	}
}

/** [内部] 清空 KV 中的列表 */
async function _clearList(key: Deno.KvKey, _listName: string): Promise<void> {
	await _deleteKvKey(key); // Deletes key and reloads cache with default
}

// --- 触发密钥管理 ---

// [重构] 从缓存获取触发密钥 (Set)
export function getTriggerKeys(): Set<string> {
	const keys = globalCache.get<string[]>(CACHE_KEYS.TRIGGER_KEYS);
	return new Set(keys || []); // Ensure it returns a Set even if cache is empty/null
}

// [重构] 添加触发密钥 (更新 KV 并重载缓存)
export async function addTriggerKey(key: string): Promise<void> {
	await _addItemToSet(TRIGGER_KEYS_KEY, key);
}

// [重构] 删除触发密钥 (更新 KV 并重载缓存)
export async function removeTriggerKey(key: string): Promise<void> {
	await _removeItemFromList(TRIGGER_KEYS_KEY, key);
}

// [重构] 检查触发密钥 (从缓存读取)
export function isTriggerKey(providedKey: string): boolean {
	if (!providedKey) return false;
	const triggerKeys = getTriggerKeys(); // Uses refactored getter (reads from cache)
	return triggerKeys.has(providedKey.trim());
}


// --- 主密钥池管理 ---

// [重构] 获取主密钥池中的所有密钥 (Array) (从缓存读取)
export function getPoolKeys(): string[] {
	return globalCache.get<string[]>(CACHE_KEYS.POOL_KEYS) || [];
}

// [重构] 添加一个或多个密钥到主密钥池 (更新 KV 并重载缓存)
export async function addPoolKeys(keys: string[]): Promise<void> {
	await _addItemsToList(POOL_KEYS_KEY, keys, 'Pool Keys');
}

// [重构] 从主密钥池中删除一个密钥 (更新 KV 并重载缓存)
export async function removePoolKey(key: string): Promise<void> {
	await _removeItemFromList(POOL_KEYS_KEY, key);
	// 原子计数器不受影响
}

// [重构] 清空主密钥池中的所有密钥 (更新 KV 并重载缓存, 删除原子计数器)
export async function clearPoolKeys(): Promise<void> {
	await _clearList(POOL_KEYS_KEY, 'Pool Keys'); // Deletes key and reloads cache
	const kv = ensureKv();
	await kv.delete(POOL_KEY_ATOMIC_INDEX_KEY); // Delete atomic counter separately
	console.log("Pool key list cleared from cache. Pool key atomic index deleted from KV.");
}

// [重构] 获取下一个密钥池密钥 (从缓存读取列表, KV 原子操作)
export async function getNextPoolKey(): Promise<string | null> {
	const poolKeys = getPoolKeys(); // Read list from cache

	if (poolKeys.length === 0) {
		////console.warn("Pool key requested but pool is empty.");
		return null;
	}

	const kv = ensureKv(); // Ensure KV is initialized
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

// [重构] 获取指定密钥 (从缓存读取)
export function getFallbackKey(): string | null {
	return globalCache.get<string | null>(CACHE_KEYS.FALLBACK_KEY) ?? null;
}

// [重构] 设置指定密钥 (更新 KV 并重载缓存)
export async function setFallbackKey(key: string | null): Promise<void> {
	const trimmedKey = key?.trim();
	if (trimmedKey && trimmedKey.length > 0) {
		await _setKvValue(FALLBACK_KEY_KEY, trimmedKey);
	} else {
		await _deleteKvKey(FALLBACK_KEY_KEY);
	}
}


// --- 指定密钥触发模型 (Fallback Models) 管理 ---

// [重构] 获取触发指定密钥的模型列表 (Set) (从缓存读取)
export function getFallbackModels(): Set<string> {
	const models = globalCache.get<string[]>(CACHE_KEYS.FALLBACK_MODELS);
	return new Set(models || []);
}

// [重构] 添加一个或多个模型到触发指定密钥的模型列表 (更新 KV 并重载缓存)
export async function addFallbackModels(models: string[]): Promise<void> {
	await _addItemsToList(FALLBACK_MODELS_KEY, models, 'Fallback Models');
}

// [重构] 清空触发指定密钥的模型列表 (更新 KV 并重载缓存)
export async function clearFallbackModels(): Promise<void> {
	await _clearList(FALLBACK_MODELS_KEY, 'Fallback Models');
}


// --- API 重试次数管理 ---

// [重构] 获取 API 调用最大重试次数 (从缓存读取)
export function getApiRetryLimit(): number {
	// Use the default from cache.ts if cache returns undefined
	return globalCache.get<number>(CACHE_KEYS.API_RETRY_LIMIT) ?? 3;
}

// [重构] 设置 API 调用最大重试次数 (更新 KV 并重载缓存)
export async function setApiRetryLimit(limit: number): Promise<void> {
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
		throw new Error("API retry limit must be a positive integer.");
	}
	await _setKvValue(API_RETRY_LIMIT_KEY, limit);
}


// --- GCP 凭证字符串管理 ---

// [重构] 设置 GCP 凭证字符串 (更新 KV 并重载缓存, 触发 Auth 重建)
export async function setGcpCredentialsString(credentials: string | null): Promise<void> {
	const trimmedCredentials = credentials?.trim();
	if (trimmedCredentials && trimmedCredentials.length > 0) {
		// Directly set value in KV, reloadKvConfig will handle cache & auth rebuild
		const kv = ensureKv();
		await kv.set(GCP_CREDENTIALS_STRING_KEY, trimmedCredentials);
		await reloadKvConfig(GCP_CREDENTIALS_STRING_KEY);
	} else {
		// Directly delete key in KV, reloadKvConfig will handle cache & auth rebuild
		const kv = ensureKv();
		await kv.delete(GCP_CREDENTIALS_STRING_KEY);
		await reloadKvConfig(GCP_CREDENTIALS_STRING_KEY);
	}
}

// [重构] 获取 GCP 凭证字符串 (从缓存读取)
export function getGcpCredentialsString(): string | null {
	return globalCache.get<string | null>(CACHE_KEYS.GCP_CREDENTIALS_STRING) ?? null;
}

// --- GCP 凭证解析 (Moved from proxy_handler.ts) ---
const isValidCred = (cred: any): cred is GcpCredentials =>
	cred?.type &&
	cred?.project_id &&
	cred?.private_key_id &&
	cred?.private_key &&
	cred?.client_email;

export const parseCreds = (jsonStr: string): GcpCredentials[] => {
	try {
		const p = JSON.parse(jsonStr);
		if (Array.isArray(p)) {
			return p.filter(isValidCred);
		}
	} catch { /* 忽略第一个解析错误 */ }

	try {
		let f = jsonStr.trim();
		if (!f.startsWith('[')) {
			f = `[${f.replace(/}\s*{/g, '},{')}]`;
		}
		const p = JSON.parse(f);
		if (Array.isArray(p)) {
			return p.filter(isValidCred);
		}
	} catch { /* 忽略第二个解析错误 */ }

	return (jsonStr.match(/\{(?:[^{}]|{[^{}]*})*\}/g) || [])
		.map(s => {
			try {
				const p = JSON.parse(s.trim());
				return isValidCred(p) ? p : null;
			} catch {
				return null;
			}
		})
		.filter(Boolean) as GcpCredentials[];
};


// --- GCP 默认 Location 管理 ---

// [重构] 设置默认 GCP Location (更新 KV 并重载缓存)
export async function setGcpDefaultLocation(location: string | null): Promise<void> {
	const trimmedLocation = location?.trim();
	if (trimmedLocation && trimmedLocation.length > 0) {
		await _setKvValue(GCP_DEFAULT_LOCATION_KEY, trimmedLocation);
	} else {
		await _deleteKvKey(GCP_DEFAULT_LOCATION_KEY);
	}
}

// [重构] 获取默认 GCP Location (从缓存读取)
export function getGcpDefaultLocation(): string {
	// Use the default from cache.ts if cache returns undefined
	return globalCache.get<string>(CACHE_KEYS.GCP_DEFAULT_LOCATION) ?? 'global';
}


// --- Vertex AI 模型列表管理 ---

// [重构] 获取触发 Vertex AI 代理的模型列表 (Set) (从缓存读取)
export function getVertexModels(): Set<string> {
	const models = globalCache.get<string[]>(CACHE_KEYS.VERTEX_MODELS);
	return new Set(models || []);
}

// [重构] 添加一个或多个模型到触发 Vertex AI 代理的模型列表 (更新 KV 并重载缓存)
export async function addVertexModels(models: string[]): Promise<void> {
	await _addItemsToList(VERTEX_MODELS_KEY, models, 'Vertex Models');
}

// [重构] 清空触发 Vertex AI 代理的模型列表 (更新 KV 并重载缓存)
export async function clearVertexModels(): Promise<void> {
	await _clearList(VERTEX_MODELS_KEY, 'Vertex Models');
}

// [重构] 检查模型名称是否属于 Vertex AI 模型列表 (从缓存读取)
export function isVertexModel(modelName: string | null): boolean {
	if (!modelName) return false;
	const vertexModels = getVertexModels(); // 使用缓存化的 getter
	return vertexModels.has(modelName.trim());
}

// --- API 路径映射管理 ---

// [重构] 获取 API 路径映射 (从缓存读取)
export function getApiMappings(): Record<string, string> {
	return globalCache.get<Record<string, string>>(CACHE_KEYS.API_MAPPINGS) || {};
}

// [重构] 设置 API 路径映射 (更新 KV 并重载缓存)
export async function setApiMappings(mappings: Record<string, string>): Promise<void> {
	if (typeof mappings !== 'object' || mappings === null) {
		throw new Error("Mappings must be a non-null object.");
	}
	await _setKvValue(API_MAPPINGS_KEY, mappings);
}

// [重构] 清空 API 路径映射 (更新 KV 并重载缓存)
export async function clearApiMappings(): Promise<void> {
	await _deleteKvKey(API_MAPPINGS_KEY);
}

// --- 核心 API 密钥选择逻辑 (使用重构后的缓存读取函数) ---

// [重构] 检查模型名称是否属于 Fallback 模型列表 (从缓存读取)
export function isFallbackModel(modelName: string | null): boolean {
	if (!modelName) return false;
	const fallbackModels = getFallbackModels(); // 使用缓存化的 getter
	return fallbackModels.has(modelName.trim());
}

// [重构] 获取请求的 API Key (依赖缓存和原子操作)
export async function getApiKeyForRequest(
	userProvidedKey: string | null,
	modelName: string | null
): Promise<ApiKeyResult | null> {
	if (!userProvidedKey) {
		return null;
	}

	// isTriggerKey now reads from cache
	const isKeyTrigger = isTriggerKey(userProvidedKey);

	if (!isKeyTrigger) {
		return { key: userProvidedKey, source: 'user' };
	}

	// isFallbackModel now reads from cache
	if (isFallbackModel(modelName)) {
		const fallbackKey = getFallbackKey(); // Reads from cache
		if (fallbackKey) {
			return { key: fallbackKey, source: 'fallback' };
		}
	}

	// getNextPoolKey reads list from cache, uses atomic op
	const poolKey = await getNextPoolKey();
	if (poolKey) {
		return { key: poolKey, source: 'pool' };
	}

	return null;
}