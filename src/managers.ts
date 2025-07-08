// src/managers.ts

export const ENV_KEYS = {
	TRIGGER_KEYS: "TRIGGER_KEYS",
	POOL_KEYS: "POOL_KEYS",
	FALLBACK_KEY: "FALLBACK_KEY",
	FALLBACK_MODELS: "FALLBACK_MODELS",
	API_RETRY_LIMIT: "API_RETRY_LIMIT",
	GCP_CREDENTIALS: "GCP_CREDENTIALS",
	GCP_DEFAULT_LOCATION: "GCP_DEFAULT_LOCATION",
	API_MAPPINGS: "API_MAPPINGS",
};

const getSetFromEnv = (varName: string): Set<string> => {
	const val = Deno.env.get(varName);
	return val ? new Set(val.split(',').map(s => s.trim()).filter(Boolean)) : new Set();
};

export interface AppConfig {
    triggerKeys: Set<string>;
    poolKeys: string[];
    fallbackKey: string | null;
    fallbackModels: Set<string>;
    apiRetryLimit: number;
    gcpCredentialsString: string | null;
    gcpDefaultLocation: string;
    apiMappings: Record<string, string>;
}

class ConfigManager {
    private config: AppConfig | null = null;

    private initialize(): AppConfig {
        const newConfig: AppConfig = {
            triggerKeys: getSetFromEnv(ENV_KEYS.TRIGGER_KEYS),
            poolKeys: Array.from(getSetFromEnv(ENV_KEYS.POOL_KEYS)),
            fallbackKey: Deno.env.get(ENV_KEYS.FALLBACK_KEY) || null,
            fallbackModels: getSetFromEnv(ENV_KEYS.FALLBACK_MODELS),
            apiRetryLimit: (() => {
                const limit = parseInt(Deno.env.get(ENV_KEYS.API_RETRY_LIMIT) || "1", 10);
                return isNaN(limit) || limit < 1 ? 1 : limit;
            })(),
            gcpCredentialsString: Deno.env.get(ENV_KEYS.GCP_CREDENTIALS) || null,
            gcpDefaultLocation: Deno.env.get(ENV_KEYS.GCP_DEFAULT_LOCATION) || "global",
            apiMappings: (() => {
                const mappings: Record<string, string> = {};
                const raw = Deno.env.get(ENV_KEYS.API_MAPPINGS);
                if (raw) {
                    raw.split(',').forEach(pair => {
                        const parts = pair.trim().match(/^(\/.*?):(.+)$/);
                        if (parts && parts.length === 3) {
                            try {
                                new URL(parts[2]);
                                mappings[parts[1]] = parts[2];
                            } catch {
                                console.warn(`[Config] Invalid URL in API_MAPPINGS for prefix "${parts[1]}"`);
                            }
                        }
                    });
                }
                return mappings;
            })(),
        };
        this.config = newConfig;
        return this.config;
    }

    public get(): AppConfig {
        if (this.config) {
            return this.config;
        }
        return this.initialize();
    }
}

export const configManager = new ConfigManager();