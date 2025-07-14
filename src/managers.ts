// src/managers.ts
//
// 该文件负责管理整个应用的配置。
//
// 它定义了 AppConfig 接口，作为应用配置的统一数据结构。
//
// 它实现了 ConfigManager 类，这是一个单例管理器，负责：
// 1. 从构建时生成的 `./config_data.ts` 模块中导入原始配置数据。
// 2. 在首次访问时，将导入的数据初始化并转换为运行时的 AppConfig 格式（例如将数组转换为 Set）。
// 3. 为应用的其他部分提供一个统一的、懒加载的 get() 方法来获取配置。
//
// 这种设计将配置的来源（构建时生成）和使用（运行时访问）解耦，
// 使得应用代码无需关心配置是如何加载的。

import type { GcpCredentials } from "./deno_index.ts";
import * as configData from "./config_data.ts";

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

class ConfigManager {
    private config: AppConfig | null = null;

    private initialize(): AppConfig {
        const newConfig: AppConfig = {
            triggerKeys: new Set(configData.triggerKeys),
            poolKeys: configData.poolKeys,
            fallbackKey: configData.fallbackKey,
            fallbackModels: new Set(configData.fallbackModels),
            apiRetryLimit: configData.apiRetryLimit,
            gcpCredentials: configData.gcpCredentials,
            gcpDefaultLocation: configData.gcpDefaultLocation,
            apiMappings: configData.apiMappings,
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