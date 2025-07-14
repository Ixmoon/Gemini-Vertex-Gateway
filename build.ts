// build.ts
// 该脚本用于在部署前将 secrets.config.json 的内容转换为一个 TypeScript 模块，
// 以便在 Deno Deploy 等无文件系统访问权限的环境中使用。

try {
  // 1. 读取本地的密钥文件
  const secretsJson = await Deno.readTextFile("secrets.config.json");
  const secrets = JSON.parse(secretsJson);

  // 2. 生成 TypeScript 文件内容
  const tsContent = `// @ts-nocheck
// =================================================================================
// !!! DO NOT COMMIT THIS FILE TO VERSION CONTROL !!!
// 该文件由 build.ts 在构建时自动生成，包含敏感的配置数据。
// =================================================================================

// 这一行是为了让生成的文件能够复用主应用中的类型定义
import type { GcpCredentials } from "./deno_index.ts";

// 导出所有从 JSON 文件读取的配置
export const gcpCredentials: GcpCredentials[] = ${JSON.stringify(secrets.gcpCredentials ?? [], null, 2)};
export const poolKeys: string[] = ${JSON.stringify(secrets.poolKeys ?? [], null, 2)};
export const triggerKeys: string[] = ${JSON.stringify(secrets.triggerKeys ?? [], null, 2)};
export const fallbackKey: string | null = ${JSON.stringify(secrets.fallbackKey ?? null)};
export const fallbackModels: string[] = ${JSON.stringify(secrets.fallbackModels ?? [], null, 2)};
export const apiRetryLimit: number = ${JSON.stringify(secrets.apiRetryLimit ?? 1)};
export const gcpDefaultLocation: string = ${JSON.stringify(secrets.gcpDefaultLocation ?? "global")};
export const apiMappings: Record<string, string> = ${JSON.stringify(secrets.apiMappings ?? {}, null, 2)};
`;

  // 3. 将内容写入到 src 目录下的一个新文件中
  const outputPath = "src/config_data.ts";
  await Deno.writeTextFile(outputPath, tsContent);

  console.log(`✅ 成功生成配置文件: ${outputPath}`);

} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    console.error("❌ 错误: 未找到 'secrets.config.json' 文件。");
    console.error("   请根据项目文档创建一个。");
  } else if (error instanceof Error) {
    console.error("❌ 构建失败:", error.message);
  } else {
    console.error("❌ 构建失败:", error);
  }
  // 以非零状态码退出，以便在 CI/CD 流程中能捕获到失败
  Deno.exit(1); 
}