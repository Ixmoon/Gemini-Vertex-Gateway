// src/managers.ts
//
// 该文件负责管理整个应用的所有状态和策略，包括配置、GCP认证和请求处理策略。
//
// 设计理念:
// 1. 内聚性: 将所有单例、懒加载的管理类聚合在此文件中，使职责更清晰。
// 2. 懒加载 (Lazy Initialization): 所有管理器都采用懒加载模式，确保只在首次需要时才进行初始化，
//    从而优化应用的冷启动性能。
// 3. 代码复用: 引入了一个通用的 `LazyManager<T>` 泛型类来封装懒加载的核心逻辑，
//    避免了在多个管理器之间重复实现相同的模式（如实例缓存、竞态条件处理等）。
//
// 管理器:
// - configManager: 负责从构建时生成的 `./config_data.ts` 模块中加载和处理应用配置。
// - gcpAuthManager: 负责管理 GCP 服务账号的认证和令牌获取，支持多凭证轮询。
// - strategyManager: 负责根据请求类型动态地创建和提供相应的处理策略实例。

import { GoogleAuth } from "google-auth-library";
import * as configData from "./config_data.ts";
import type { GcpCredentials, RequestHandlerStrategy, RequestType } from "./types.ts";
import { OptimizedRoundRobinSelector } from "./utils.ts";
import { VertexAIStrategy, GeminiOpenAIStrategy, GeminiNativeStrategy, GenericProxyStrategy } from "./strategies.ts";

// =================================================================================
// --- 1. 通用懒加载管理器 ---
// =================================================================================

/**
 * 一个通用的懒加载管理器。
 * 它封装了懒加载的通用逻辑：一个 `instance` 缓存、一个 `initPromise` 防止初始化竞态。
 * @template T 管理器要创建的实例类型。
 */
class LazyManager<T> {
    private instance: T | null = null;
    private initPromise: Promise<T> | null = null;
    private initializer: () => T | Promise<T>;

    constructor(initializer: () => T | Promise<T>) {
        this.initializer = initializer;
    }

    /**
     * 获取实例。如果实例不存在，则进行初始化。
     * 支持并发调用，并确保 `initializer` 只被执行一次。
     * @returns 返回实例的 Promise。
     */
    public get(): Promise<T> {
        if (this.instance) {
            return Promise.resolve(this.instance);
        }
        if (!this.initPromise) {
            this.initPromise = (async () => {
                try {
                    this.instance = await this.initializer();
                    return this.instance;
                } finally {
                    // 在初始化完成后，可以将 promise 清理掉，以便后续的 get() 调用可以快速返回
                    this.initPromise = null;
                }
            })();
        }
        return this.initPromise;
    }

    /**
     * 同步获取实例。仅当可以确信实例已被初始化时才能使用。
     * 如果实例未初始化，将抛出错误。
     * @returns 返回已初始化的实例。
     */
    public getSync(): T {
        if (!this.instance) {
            throw new Error("Manager not initialized. Use get() for async initialization.");
        }
        return this.instance;
    }
}

// =================================================================================
// --- 2. 应用配置管理器 (ConfigManager) ---
// =================================================================================

export interface AppConfig {
    triggerKeys: Set<string>;
    poolKeys: string[];
    fallbackKey: string | null;
    fallbackModels: Set<string>;
    apiRetryLimit: number;
    gcpCredentials: GcpCredentials[];
    gcpDefaultLocation: string;
    apiMappings: Record<string, string>;
}

const configManager = new LazyManager<AppConfig>(() => {
    return {
        triggerKeys: new Set(configData.triggerKeys),
        poolKeys: configData.poolKeys,
        fallbackKey: configData.fallbackKey,
        fallbackModels: new Set(configData.fallbackModels),
        apiRetryLimit: configData.apiRetryLimit,
        gcpCredentials: configData.gcpCredentials,
        gcpDefaultLocation: configData.gcpDefaultLocation,
        apiMappings: configData.apiMappings,
    };
});
// 立即初始化配置，因为它是所有其他管理器的基础
await configManager.get();


// =================================================================================
// --- 3. GCP 认证管理器 (GcpAuthManager) ---
// =================================================================================

export interface GcpAuth {
    getAuth: () => Promise<{ token: string; projectId: string; } | null>;
}

const gcpAuthManager = new LazyManager<GcpAuth>(() => {
    const config = configManager.getSync();
    const authInstanceCache = new Map<string, GoogleAuth>();
    const credentials = config.gcpCredentials;
    if (credentials.length === 0) {
        console.warn("[GCP] No valid GCP credentials found in the configuration.");
    }
    const credentialSelector = new OptimizedRoundRobinSelector(credentials);

    const getAuthInstance = (credential: GcpCredentials): GoogleAuth => {
        if (!authInstanceCache.has(credential.client_email)) {
            authInstanceCache.set(credential.client_email, new GoogleAuth({
                credentials: credential,
                scopes: ["https://www.googleapis.com/auth/cloud-platform"]
            }));
        }
        return authInstanceCache.get(credential.client_email)!;
    };

    const getAuth = async (): Promise<{ token: string; projectId: string } | null> => {
        const selectedCredential = credentialSelector.next();
        if (!selectedCredential) return null;

        try {
            const auth = getAuthInstance(selectedCredential);
            const token = await auth.getAccessToken();
            if (!token) {
                console.error(`[GCP] Failed to get Access Token for project: ${selectedCredential.project_id}`);
                return null;
            }
            return { token, projectId: selectedCredential.project_id };
        } catch (error) {
            console.error(`[GCP] Error during token acquisition for project ${selectedCredential.project_id}:`, error);
            return null;
        }
    };

    return { getAuth };
});

// =================================================================================
// --- 4. 策略管理器 (StrategyManager) ---
// =================================================================================

/**
 * StrategyManager 负责按需创建和缓存请求处理策略。
 * 它不是一个典型的单例，而是一个策略工厂和缓存的集合。
 */
class StrategyManager {
    private strategyCache = new Map<RequestType, LazyManager<RequestHandlerStrategy>>();

    /**
     * 获取指定类型的请求处理策略。
     * @param type 请求类型枚举
     * @returns 返回一个 Promise，解析为对应的策略实例。
     */
    public get(type: RequestType): Promise<RequestHandlerStrategy> {
        if (!this.strategyCache.has(type)) {
            const initializer = this.createStrategyInitializer(type);
            this.strategyCache.set(type, new LazyManager(initializer));
        }
        return this.strategyCache.get(type)!.get();
    }

    private createStrategyInitializer(type: RequestType): () => Promise<RequestHandlerStrategy> {
        return async (): Promise<RequestHandlerStrategy> => {
            const config = configManager.getSync();

            switch (type) {
                case "VERTEX_AI": {
                    const gcpAuth = await gcpAuthManager.get();
                    return new VertexAIStrategy(config, gcpAuth.getAuth);
                }
                case "GEMINI_OPENAI":
                    return new GeminiOpenAIStrategy();
                case "GEMINI_NATIVE":
                    return new GeminiNativeStrategy();
                case "GENERIC_PROXY":
                    return new GenericProxyStrategy(config);
                default: {
                    // 这利用了 TypeScript 的 never 类型检查，确保所有枚举值都有处理
                    const exhaustiveCheck: never = type;
                    throw new Error(`Unsupported strategy type: ${exhaustiveCheck}`);
                }
            }
        };
    }
}


// =================================================================================
// --- 5. 导出单例实例 ---
// =================================================================================

export { configManager, gcpAuthManager };
export const strategyManager = new StrategyManager();
export const poolKeySelector = new OptimizedRoundRobinSelector(configManager.getSync().poolKeys);