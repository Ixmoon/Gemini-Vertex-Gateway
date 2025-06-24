/**
 * 配置模块。
 * 所有配置均从环境变量读取，并在模块加载时进行一次性解析和导出。
 * 这个模块是无状态的，并且不执行任何异步操作。
 */

// --- 类型定义 ---

/** API 密钥的来源类型 */
export type ApiKeySource = 'user' | 'fallback' | 'pool';

/** API 密钥选择的结果 */
export type ApiKeyResult = { key: string; source: ApiKeySource };

/** GCP 服务账号凭证的接口定义 */
export interface GcpCredential {
	type: string;
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
	[key: string]: any;
}

// --- 内部辅助函数 ---

const getEnv = (key: string, defaultValue = ""): string => Deno.env.get(key) || defaultValue;

const parseStringList = (envVar: string): string[] => 
    envVar ? envVar.split(',').map(k => k.trim()).filter(Boolean) : [];

const isValidGcpCredential = (cred: any): cred is GcpCredential =>
	cred?.type === 'service_account' &&
	cred?.project_id &&
	cred?.private_key &&
	cred?.client_email;

const parseGcpCredentials = (jsonStr: string): GcpCredential[] => {
	if (!jsonStr) return [];
	try {
		const parsed = JSON.parse(jsonStr);
		return Array.isArray(parsed) 
            ? parsed.filter(isValidGcpCredential) 
            : (isValidGcpCredential(parsed) ? [parsed] : []);
	} catch (e) {
		console.error(`Error parsing GCP_CREDENTIALS_STRING: ${e.message}. It must be a valid JSON object or array of objects.`);
		return [];
	}
};


// --- 导出的配置常量 ---

/** 触发特殊密钥选择逻辑的 API 密钥集合 (来自环境变量 `TRIGGER_KEYS`) */
export const TRIGGER_KEYS = new Set(parseStringList(getEnv("TRIGGER_KEYS")));

/** 用于代理请求的备用 API 密钥池 (来自环境变量 `POOL_KEYS`) */
export const POOL_KEYS = parseStringList(getEnv("POOL_KEYS"));

/** 当请求匹配 `FALLBACK_MODELS` 时使用的特定备用密钥 (来自环境变量 `FALLBACK_KEY`) */
export const FALLBACK_KEY = getEnv("FALLBACK_KEY") || null;

/** 触发使用 `FALLBACK_KEY` 的模型名称集合 (来自环境变量 `FALLBACK_MODELS`) */
export const FALLBACK_MODELS = new Set(parseStringList(getEnv("FALLBACK_MODELS")));

/** 密钥池和 Vertex AI 请求失败后的最大重试次数 (来自环境变量 `API_RETRY_LIMIT`) */
export const API_RETRY_LIMIT = parseInt(getEnv("API_RETRY_LIMIT", "3"), 10) || 3;

/** GCP 服务账号凭证数组 (来自环境变量 `GCP_CREDENTIALS_STRING`) */
export const GCP_CREDENTIALS = parseGcpCredentials(getEnv("GCP_CREDENTIALS_STRING"));

/** GCP Vertex AI 的默认区域 (来自环境变量 `GCP_DEFAULT_LOCATION`) */
export const GCP_DEFAULT_LOCATION = getEnv("GCP_DEFAULT_LOCATION", "global");

/** 
 * API 路径前缀到目标 URL 的映射表。
 * 内置对 /gemini 和 /vertex 的支持，可通过 `API_MAPPINGS` 环境变量覆盖或扩展。
 */
export const API_MAPPINGS = {
    '/gemini': 'https://generativelanguage.googleapis.com',
    '/vertex': 'https://aiplatform.googleapis.com', // 占位符, 实际URL在策略中动态构建
    ...JSON.parse(getEnv("API_MAPPINGS") || '{}') as Record<string, string>,
};


// --- 导出的逻辑函数 ---

/** 检查一个 API 密钥是否为触发密钥。 */
export const isTriggerKey = (key: string | null): boolean => !!key && TRIGGER_KEYS.has(key.trim());

/** 检查一个模型名称是否属于回退模型列表。 */
export const isFallbackModel = (model: string | null): boolean => !!model && FALLBACK_MODELS.has(model.trim());

/** 从密钥池中随机获取一个密钥。 */
export const getNextPoolKey = (): string | null => {
	if (POOL_KEYS.length === 0) return null;
	return POOL_KEYS[Math.floor(Math.random() * POOL_KEYS.length)];
};

/**
 * 核心 API 密钥选择逻辑。根据用户提供的密钥和模型名称，同步决定最终使用的密钥。
 * @param userProvidedKey 用户请求中携带的 API 密钥。
 * @param modelName 请求中指定的模型名称。
 * @returns {ApiKeyResult | null} 包含最终密钥及其来源的对象，或在无法提供密钥时返回 null。
 */
export function resolveApiKey(
	userProvidedKey: string | null,
	modelName: string | null
): ApiKeyResult | null {
	if (!userProvidedKey) return null;

	if (!isTriggerKey(userProvidedKey)) {
		return { key: userProvidedKey, source: 'user' };
	}

	if (isFallbackModel(modelName) && FALLBACK_KEY) {
		return { key: FALLBACK_KEY, source: 'fallback' };
	}

	const poolKey = getNextPoolKey();
	if (poolKey) {
		return { key: poolKey, source: 'pool' };
	}

	console.warn("Trigger key used, but no fallback or pool key was available.");
	return null;
}