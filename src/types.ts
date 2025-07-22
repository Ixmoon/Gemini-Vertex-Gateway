// src/types.ts
//
// 该文件定义了整个应用中共享的核心、通用的 TypeScript 类型和接口。
// 为了保持服务的简洁性和避免过度设计，此文件已移除了所有特定于
// 下游服务（如 Google Gemini）的、非必需的类型定义。
// 职责：
// 1. 定义认证、配置等核心数据结构。
// 2. 定义策略模式所需的核心接口 (`RequestHandlerStrategy`)。

// =================================================================================
// --- 1. 核心业务类型 ---
// =================================================================================

/** GCP 服务账号凭证的结构 */
export interface GcpCredentials {
    type: string;
    project_id: string;
    private_key_id: string;
    private_key: string;
    client_email: string;
    client_id?: string;
}

/** API 密钥的来源类型 */
export type ApiKeySource = 'user' | 'fallback' | 'pool';

/** API 密钥及其来源的组合结果 */
export type ApiKeyResult = { key: string; source: ApiKeySource };

/**
 * 请求的类型。使用字符串字面量联合类型以获得更好的类型安全性和可调试性。
 */
export type RequestType = "VERTEX_AI" | "GEMINI_OPENAI" | "GEMINI_NATIVE" | "GENERIC_PROXY";

/** 认证详情，包含 API 密钥、GCP 令牌等信息 */
export interface AuthenticationDetails {
    key: string | null;
    source: ApiKeySource | null;
    gcpToken: string | null;
    gcpProject: string | null;
    maxRetries: number;
}

/** 策略模式的上下文对象，封装了处理请求所需的所有信息 */
export interface StrategyContext {
    originalUrl: URL;
    originalRequest: Request;
    path: string;
    prefix: string | null;
    /** 如果请求体被缓存，这里是解析后的 JSON 对象 */
    parsedBody: Record<string, any> | null;
    isWebSocket?: boolean;
}

// =================================================================================
// --- 2. 策略模式接口 (Strategy Pattern) ---
// =================================================================================

/**
 * 请求处理策略的接口。
 * 定义了处理一类代理请求所需的标准步骤。
 */
export interface RequestHandlerStrategy {
    /** 获取该策略所需的认证信息 */
    getAuthenticationDetails(c: unknown, ctx: StrategyContext, attempt: number): Promise<AuthenticationDetails>;
    /** 构建目标服务的 URL */
    buildTargetUrl(ctx: StrategyContext, auth: AuthenticationDetails): URL | Promise<URL>;
    /** 构建发往目标服务的请求头 */
    buildRequestHeaders(ctx: StrategyContext, auth: AuthenticationDetails): Headers;
    /** (可选) 转换已解析的请求体对象 */
    transformRequestBody?(body: Record<string, any> | null, ctx: StrategyContext): Record<string, any> | null;
    /** (可选) 在收到目标服务响应后，返回给客户端之前进行处理 */
    handleResponse?(res: Response, ctx: StrategyContext): Promise<Response>;
}