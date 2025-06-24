import { GoogleAuth } from "google-auth-library";
import { ConfigKeys, getConfig, setConfig, getKvValueDirectly, KV_NOT_FOUND, getCacheValue, setCacheValue, parseGcpCredentials } from "./config.ts";

// --- 类型定义 ---
export type ApiKeySource = 'user' | 'fallback' | 'pool';
export type ApiKeyResult = { key: string; source: ApiKeySource };
export interface GcpCredentials {
	type: string;
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
}

// --- 内部辅助函数 ---

/** 密码哈希 */
async function hashPassword(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 校验GCP凭证对象是否有效 */
const isValidGcpCred = (cred: any): cred is GcpCredentials =>
	cred?.type === 'service_account' &&
	cred?.project_id &&
	cred?.private_key_id &&
	cred?.private_key &&
	cred?.client_email;

/** 解析GCP凭证字符串(兼容多种格式) */
export const parseCreds = (jsonStr: string): GcpCredentials[] => {
	if (!jsonStr) return [];
	try {
		const p = JSON.parse(jsonStr);
		return Array.isArray(p) ? p.filter(isValidGcpCred) : (isValidGcpCred(p) ? [p] : []);
	} catch {
		try {
			const fixedJson = `[${jsonStr.replace(/}\s*,?\s*{/g, '},{')}]`;
			const p = JSON.parse(fixedJson);
			return Array.isArray(p) ? p.filter(isValidGcpCred) : [];
		} catch {
			return (jsonStr.match(/\{(?:[^{}]|{[^{}]*})*\}/g) || [])
				.map(s => { try { const p = JSON.parse(s); return isValidGcpCred(p) ? p : null; } catch { return null; } })
				.filter((c): c is GcpCredentials => c !== null);
		}
	}
};


// --- 管理员密码服务 ---
export async function setAdminPassword(password: string): Promise<void> {
	if (!password || password.length < 8) throw new Error("密码必须至少为8个字符。");
	const hash = await hashPassword(password);
	await setConfig(ConfigKeys.ADMIN_PASSWORD_HASH, hash);
}

export async function getAdminPasswordHash(): Promise<string | null> {
    const result = await getKvValueDirectly<string>(ConfigKeys.ADMIN_PASSWORD_HASH.kvKey);
    return result === KV_NOT_FOUND ? null : result;
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
	const storedHash = await getAdminPasswordHash();
	if (!password || !storedHash) return false;
	const inputHash = await hashPassword(password);
	return inputHash === storedHash;
}

// --- 密钥与模型列表服务 (代理逻辑使用) ---

export async function isTriggerKey(key: string | null): Promise<boolean> {
	if (!key) return false;
	const keys = await getConfig(ConfigKeys.TRIGGER_KEYS, []);
	return new Set(keys).has(key);
}

export async function getNextPoolKey(): Promise<string | null> {
	const keys = await getConfig(ConfigKeys.POOL_KEYS, []);
	if (keys.length === 0) return null;
	return keys[Math.floor(Math.random() * keys.length)];
}

export async function isFallbackModel(model: string | null): Promise<boolean> {
	if (!model) return false;
	const models = await getConfig(ConfigKeys.FALLBACK_MODELS, []);
	return new Set(models).has(model);
}

export async function getFallbackKey(): Promise<string | null> {
	return await getConfig(ConfigKeys.FALLBACK_KEY, null);
}

export async function isVertexModel(model: string | null): Promise<boolean> {
	if (!model) return false;
	const models = await getConfig(ConfigKeys.VERTEX_MODELS, []);
	return new Set(models).has(model);
}

export async function getApiRetryLimit(): Promise<number> {
	return await getConfig(ConfigKeys.API_RETRY_LIMIT, 3);
}

export async function getGcpDefaultLocation(): Promise<string> {
	return await getConfig(ConfigKeys.GCP_DEFAULT_LOCATION, "global");
}

export async function getApiMappings(): Promise<Record<string, string>> {
	return await getConfig(ConfigKeys.API_MAPPINGS, {});
}

// --- 核心密钥选择逻辑 (代理逻辑使用) ---
export async function getApiKeyForRequest(userProvidedKey: string | null, modelName: string | null): Promise<ApiKeyResult | null> {
	if (!userProvidedKey) return null;

	if (!(await isTriggerKey(userProvidedKey))) {
		return { key: userProvidedKey, source: 'user' };
	}

	if (await isFallbackModel(modelName)) {
		const fallbackKey = await getFallbackKey();
		if (fallbackKey) return { key: fallbackKey, source: 'fallback' };
	}

	const poolKey = await getNextPoolKey();
	if (poolKey) return { key: poolKey, source: 'pool' };

	console.warn("Trigger key used, but no fallback/pool key available.");
	return null;
}

// --- GCP 认证服务 ---
export async function getGcpAuth(): Promise<{ token: string; projectId: string } | null> {
    const credsStr = await getConfig(ConfigKeys.GCP_CREDENTIALS_STRING, null);
    if (!credsStr) return null;

    const creds = parseGcpCredentials(credsStr);
    if (creds.length === 0) return null;

    const selectedCred = creds[Math.floor(Math.random() * creds.length)];
    const tokenCacheKey = `${ConfigKeys.GCP_AUTH_TOKEN_PREFIX.key}${selectedCred.client_email}`;

    // 1. 优先从缓存获取Token
    const cachedToken = await getCacheValue<string>(tokenCacheKey);
    if (cachedToken) {
        return { token: cachedToken, projectId: selectedCred.project_id };
    }

    // 2. 缓存未命中，生成新Token
    try {
        const auth = new GoogleAuth({
            credentials: selectedCred,
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        });
        const newToken = await auth.getAccessToken();
        if (!newToken) throw new Error("GoogleAuth returned null token.");

        // 3. 将新Token存入缓存，有效期10分钟 (600秒)
        await setCacheValue(tokenCacheKey, newToken, 600);

        return { token: newToken, projectId: selectedCred.project_id };
    } catch (error) {
        console.error(`[GCP Auth] Failed to get new token for ${selectedCred.client_email}:`, error);
        return null;
    }
}


// --- 管理 API 服务 (直接读写 KV 和缓存) ---
// 使用泛型函数简化管理API的 "get/set/add/remove/clear" 操作

async function getList(keyMeta: ConfigKeyMeta): Promise<string[]> {
    const res = await getKvValueDirectly<string[]>(keyMeta.kvKey);
    return res === KV_NOT_FOUND ? [] : (res || []);
}

async function addItem(keyMeta: ConfigKeyMeta, item: string): Promise<void> {
    const list = await getList(keyMeta);
    const set = new Set(list);
    if (!set.has(item)) {
        await setConfig(keyMeta, [...list, item]);
    }
}

async function addItems(keyMeta: ConfigKeyMeta, items: string[]): Promise<void> {
    const list = await getList(keyMeta);
    const set = new Set(list);
    const newItems = items.filter(i => i && !set.has(i));
    if (newItems.length > 0) {
        await setConfig(keyMeta, [...list, ...newItems]);
    }
}

async function removeItem(keyMeta: ConfigKeyMeta, item: string): Promise<void> {
    const list = await getList(keyMeta);
    const newList = list.filter(i => i !== item);
    if (newList.length < list.length) {
        await setConfig(keyMeta, newList);
    }
}

// 导出给 manage_api.ts 使用的函数
export const manage = {
    // Trigger Keys
    getTriggerKeys: async () => new Set(await getList(ConfigKeys.TRIGGER_KEYS)),
    addTriggerKey: (key: string) => addItem(ConfigKeys.TRIGGER_KEYS, key),
    removeTriggerKey: (key: string) => removeItem(ConfigKeys.TRIGGER_KEYS, key),

    // Pool Keys
    getPoolKeys: () => getList(ConfigKeys.POOL_KEYS),
    addPoolKeys: (keys: string[]) => addItems(ConfigKeys.POOL_KEYS, keys),
    removePoolKey: (key: string) => removeItem(ConfigKeys.POOL_KEYS, key),
    clearPoolKeys: () => setConfig(ConfigKeys.POOL_KEYS, []),

    // Fallback Key
    getFallbackKeyDirect: async () => {
        const res = await getKvValueDirectly<string>(ConfigKeys.FALLBACK_KEY.kvKey);
        return res === KV_NOT_FOUND ? null : res;
    },
    setFallbackKey: (key: string | null) => setConfig(ConfigKeys.FALLBACK_KEY, key),

    // Fallback Models
    getFallbackModels: async () => new Set(await getList(ConfigKeys.FALLBACK_MODELS)),
    addFallbackModels: (models: string[]) => addItems(ConfigKeys.FALLBACK_MODELS, models),
    clearFallbackModels: () => setConfig(ConfigKeys.FALLBACK_MODELS, []),

    // Retry Limit
    getApiRetryLimitDirect: async () => {
        const res = await getKvValueDirectly<number>(ConfigKeys.API_RETRY_LIMIT.kvKey);
        return res === KV_NOT_FOUND ? 3 : (res || 3);
    },
    setApiRetryLimit: (limit: number) => {
        if (!Number.isInteger(limit) || limit < 1) throw new Error("重试次数必须是正整数");
        setConfig(ConfigKeys.API_RETRY_LIMIT, limit);
    },

    // GCP Credentials
    getGcpCredentialsString: async () => {
        const res = await getKvValueDirectly<string>(ConfigKeys.GCP_CREDENTIALS_STRING.kvKey);
        return res === KV_NOT_FOUND ? null : res;
    },
    setGcpCredentialsString: (creds: string | null) => setConfig(ConfigKeys.GCP_CREDENTIALS_STRING, creds),

    // GCP Location
    getGcpDefaultLocationDirect: async () => {
        const res = await getKvValueDirectly<string>(ConfigKeys.GCP_DEFAULT_LOCATION.kvKey);
        return res === KV_NOT_FOUND ? 'global' : (res || 'global');
    },
    setGcpDefaultLocation: (loc: string | null) => setConfig(ConfigKeys.GCP_DEFAULT_LOCATION, loc),

    // Vertex Models
    getVertexModels: async () => new Set(await getList(ConfigKeys.VERTEX_MODELS)),
    setVertexModels: (models: string[]) => setConfig(ConfigKeys.VERTEX_MODELS, models),
    clearVertexModels: () => setConfig(ConfigKeys.VERTEX_MODELS, []),

    // API Mappings
    getApiMappingsDirect: async () => {
        const res = await getKvValueDirectly<Record<string, string>>(ConfigKeys.API_MAPPINGS.kvKey);
        return res === KV_NOT_FOUND ? {} : (res || {});
    },
    setApiMappings: (mappings: Record<string, string>) => {
        // 可选：添加验证逻辑
        for (const [prefix, url] of Object.entries(mappings)) {
            if (!prefix.startsWith('/')) throw new Error(`无效前缀: ${prefix}`);
            try { new URL(url); } catch { throw new Error(`无效URL: ${url}`); }
        }
        setConfig(ConfigKeys.API_MAPPINGS, mappings);
    },
    clearApiMappings: () => setConfig(ConfigKeys.API_MAPPINGS, {}),
};