// src/types.ts
//
// 该文件定义了整个应用中共享的所有核心 TypeScript 类型和接口。
// 将类型定义集中在此处，可以提高代码的模块化和可维护性，
// 并避免在不同文件之间出现循环依赖问题。

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

/** 策略模式的上下文对象，封装了处理请求所需的所有原始信息 */
export interface StrategyContext {
    originalUrl: URL;
    originalRequest: Request;
    path: string;
    prefix: string | null;
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
    /** 处理和转换请求体 */
    processRequestBody(ctx: StrategyContext): Promise<BodyInit | null> | BodyInit | null;
    /** (可选) 在收到目标服务响应后，返回给客户端之前进行处理 */
    handleResponse?(res: Response, ctx: StrategyContext): Promise<Response>;
}

// =================================================================================
// --- 3. 特定于模型的请求/响应体类型 ---
// =================================================================================

/** Google 安全设置 */
interface GoogleSafetySetting {
    category: string;
    threshold: string;
}

/** Google 特定设置 */
interface GoogleSpecificSettings {
    safety_settings?: GoogleSafetySetting[];
}

/** 包含模型供应商特定字段的请求体 */
export interface ModelProviderRequestBody {
    model?: string;
    reasoning_effort?: string; // Vertex AI specific
    google?: GoogleSpecificSettings; // Vertex AI specific
}

/** Gemini 模型列表接口中的模型对象 */
export interface GeminiModel {
    id: string;
}