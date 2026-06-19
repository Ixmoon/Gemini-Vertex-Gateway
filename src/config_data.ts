// @ts-nocheck
// =================================================================================
// 这是一个安全的空占位文件，仅含空值，不包含任何密钥，可安全提交。
// 部署时 build.ts 会用 secrets.config.json 的真实内容覆盖本文件（仅存在于 CI，
// 不会被提交回仓库）。请勿在本地用真实密钥生成后提交本文件。
// =================================================================================

// 复用主应用中的类型定义
import type { GcpCredentials } from "./types.ts";

// 导出所有从 JSON 文件读取的配置
export const gcpCredentials: GcpCredentials[] = [];
export const poolKeys: string[] = [];
export const triggerKeys: string[] = [];
export const fallbackKey: string | null = null;
export const fallbackModels: string[] = [];
export const apiRetryLimit: number = 1;
export const gcpDefaultLocation: string = "global";
export const apiMappings: Record<string, string> = {};