/**
 * L2 - 业务逻辑层
 * 负责处理具体的配置业务，例如密码验证、密钥获取、凭证解析等。
 * 调用 L1 (config_loader) 获取和存储数据。
 */
import { GoogleAuth } from "google-auth-library";
import {
	CONFIG_KEYS,
	getConfig,
	setConfig,
	deleteConfig,
	setCacheValue,
	getCacheValue,
} from "./config_loader.ts";

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

// --- 解析器与校验器 ---
const parseJsonArray = (v: any) => (Array.isArray(v) ? v : null);
const parseJsonStringArray = (v: any) => {
	if (Array.isArray(v) && v.every(i => typeof i === 'string')) return v;
	if (typeof v === 'string') {
		try {
			const arr = JSON.parse(v);
			if (Array.isArray(arr) && arr.every(i => typeof i === 'string')) return arr;
		} catch { /* ignore */ }
	}
	return null;
};
const parseJsonObject = (v: any) => {
	if (v && typeof v === 'object' && !Array.isArray(v)) return v;
	if (typeof v === 'string') {
		try {
			const obj = JSON.parse(v);
			if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
		} catch { /* ignore */ }
	}
	return null;
}
const parseString = (v: any) => (typeof v === 'string' && v ? v : null);
const parsePositiveInt = (v: any) => {
	const num = Number(v);
	return Number.isInteger(num) && num > 0 ? num : null;
};
const isValidGcpCred = (cred: any): cred is GcpCredentials =>
	cred?.type === 'service_account' &&
	cred?.project_id &&
	cred?.private_key_id &&
	cred?.private_key &&
	cred?.client_email;

// --- 管理员密码 ---
async function hashPassword(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getAdminPasswordHash(): Promise<string | null> {
	return getConfig(CONFIG_KEYS.ADMIN_PASSWORD_HASH, parseString, null);
}

export async function setAdminPassword(password: string): Promise<void> {
	if (!password || password.length < 8) {
		throw new Error("Password must be at least 8 characters long.");
	}
	const hash = await hashPassword(password);
	await setConfig(CONFIG_KEYS.ADMIN_PASSWORD_HASH, hash);
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
	const storedHash = await getAdminPasswordHash();
	if (!storedHash) return false;
	const inputHash = await hashPassword(password);
	return inputHash === storedHash;
}

// --- 触发密钥 (Trigger Keys) ---
export async function getTriggerKeys(): Promise<Set<string>> {
	const arr = await getConfig(CONFIG_KEYS.TRIGGER_KEYS, parseJsonStringArray, []);
	return new Set(arr);
}
export async function setTriggerKeys(keys: string[]): Promise<void> {
	await setConfig(CONFIG_KEYS.TRIGGER_KEYS, keys);
}
export async function isTriggerKey(key: string | null): Promise<boolean> {
	if (!key) return false;
	const triggerKeys = await getTriggerKeys();
	return triggerKeys.has(key);
}

// --- 主密钥池 (Pool Keys) ---
export async function getPoolKeys(): Promise<string[]> {
	return getConfig(CONFIG_KEYS.POOL_KEYS, parseJsonStringArray, []);
}
export async function setPoolKeys(keys: string[]): Promise<void> {
	await setConfig(CONFIG_KEYS.POOL_KEYS, keys);
}
export async function getNextPoolKey(): Promise<string | null> {
	const poolKeys = await getPoolKeys();
	if (poolKeys.length === 0) return null;
	return poolKeys[Math.floor(Math.random() * poolKeys.length)];
}

// --- 指定密钥 (Fallback Key) ---
export async function getFallbackKey(): Promise<string | null> {
	return getConfig(CONFIG_KEYS.FALLBACK_KEY, parseString, null);
}
export async function setFallbackKey(key: string | null): Promise<void> {
	if (key && key.trim()) {
		await setConfig(CONFIG_KEYS.FALLBACK_KEY, key.trim());
	} else {
		await deleteConfig(CONFIG_KEYS.FALLBACK_KEY);
	}
}

// --- 指定密钥触发模型 (Fallback Models) ---
export async function getFallbackModels(): Promise<Set<string>> {
	const arr = await getConfig(CONFIG_KEYS.FALLBACK_MODELS, parseJsonStringArray, []);
	return new Set(arr);
}
export async function setFallbackModels(models: string[]): Promise<void> {
	await setConfig(CONFIG_KEYS.FALLBACK_MODELS, models);
}
export async function isFallbackModel(model: string | null): Promise<boolean> {
	if (!model) return false;
	const fallbackModels = await getFallbackModels();
	return fallbackModels.has(model);
}

// --- API 重试次数 ---
export async function getApiRetryLimit(): Promise<number> {
	return getConfig(CONFIG_KEYS.API_RETRY_LIMIT, parsePositiveInt, 3);
}
export async function setApiRetryLimit(limit: number): Promise<void> {
	if (!parsePositiveInt(limit)) throw new Error("Retry limit must be a positive integer.");
	await setConfig(CONFIG_KEYS.API_RETRY_LIMIT, limit);
}

// --- GCP 配置 ---
export async function getGcpCredentialsString(): Promise<string | null> {
	return getConfig(CONFIG_KEYS.GCP_CREDENTIALS, parseString, null);
}
export async function setGcpCredentialsString(creds: string | null): Promise<void> {
	if (creds && creds.trim()) {
		await setConfig(CONFIG_KEYS.GCP_CREDENTIALS, creds.trim());
	} else {
		await deleteConfig(CONFIG_KEYS.GCP_CREDENTIALS);
	}
}
export async function getGcpDefaultLocation(): Promise<string> {
	return getConfig(CONFIG_KEYS.GCP_DEFAULT_LOCATION, parseString, "global");
}
export async function setGcpDefaultLocation(location: string): Promise<void> {
	await setConfig(CONFIG_KEYS.GCP_DEFAULT_LOCATION, location);
}

// --- API 路径映射 ---
export async function getApiMappings(): Promise<Record<string, string>> {
	return getConfig(CONFIG_KEYS.API_MAPPINGS, parseJsonObject, {});
}
export async function setApiMappings(mappings: Record<string, string>): Promise<void> {
	await setConfig(CONFIG_KEYS.API_MAPPINGS, mappings);
}

// --- 核心密钥选择逻辑 ---
export async function getApiKeyForRequest(userKey: string | null, modelName: string | null): Promise<ApiKeyResult | null> {
	if (!userKey) return null;

	const isKeyATrigger = await isTriggerKey(userKey);
	if (!isKeyATrigger) {
		return { key: userKey, source: 'user' };
	}

	if (await isFallbackModel(modelName)) {
		const fallbackKey = await getFallbackKey();
		if (fallbackKey) return { key: fallbackKey, source: 'fallback' };
	}

	const poolKey = await getNextPoolKey();
	if (poolKey) return { key: poolKey, source: 'pool' };

	return null; // 触发但无可用密钥
}

// --- GCP 认证逻辑 ---
async function parseGcpCreds(jsonStr: string | null): Promise<GcpCredentials[]> {
	if (!jsonStr) return [];
	try {
		const data = JSON.parse(jsonStr);
		if (Array.isArray(data)) return data.filter(isValidGcpCred);
		if (isValidGcpCred(data)) return [data];
	} catch (e) {
		console.error("Could not parse GCP credentials JSON:", e);
	}
	return [];
}

export async function getGcpAuth(): Promise<{ token: string; projectId: string } | null> {
	const credsStr = await getGcpCredentialsString();
	const creds = await parseGcpCreds(credsStr);
	if (creds.length === 0) return null;

	const selectedCred = creds[Math.floor(Math.random() * creds.length)];
	const tokenCacheKey = `${CONFIG_KEYS.GCP_AUTH_TOKEN_PREFIX.cache}${selectedCred.client_email}`;

	// 1. 尝试从缓存获取 Token
	const cachedTokenResponse = await getCacheValue(tokenCacheKey);
	if (cachedTokenResponse) {
		const token = await cachedTokenResponse.json().catch(() => null);
		if (token && typeof token === 'string') {
			return { token, projectId: selectedCred.project_id };
		}
	}

	// 2. 缓存未命中，生成新 Token
	try {
		const auth = new GoogleAuth({
			credentials: selectedCred,
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
		});
		const newToken = await auth.getAccessToken();
		if (!newToken) throw new Error("GoogleAuth returned a null token.");

		// 3. 缓存新 Token，有效期10分钟
		const TOKEN_TTL_SECONDS = 10 * 60;
		await setCacheValue(tokenCacheKey, newToken, TOKEN_TTL_SECONDS);

		return { token: newToken, projectId: selectedCred.project_id };
	} catch (error) {
		console.error(`GCP Auth: Failed to get new token for ${selectedCred.client_email}:`, error);
		return null;
	}
}