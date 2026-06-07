import dotenv from "dotenv";

dotenv.config();

function pemEnv(name) {
  const b64 = process.env[`${name}_B64`];
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  return String(process.env[name] || "").replace(/\\n/g, "\n");
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || "",
  adminEmail: process.env.ADMIN_EMAIL || "admin@example.com",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminToken: process.env.ADMIN_TOKEN || "",
  sessionSecret: process.env.SESSION_SECRET || "development-session-secret-change-me",
  licensePrivateKey: pemEnv("LICENSE_PRIVATE_KEY"),
  licensePublicKey: pemEnv("LICENSE_PUBLIC_KEY"),
  configSigningPrivateKey: pemEnv("CONFIG_SIGNING_PRIVATE_KEY") || pemEnv("LICENSE_PRIVATE_KEY"),
  configSigningPublicKey: pemEnv("CONFIG_SIGNING_PUBLIC_KEY") || pemEnv("LICENSE_PUBLIC_KEY"),
  allowUnsignedLicenses: process.env.ALLOW_UNSIGNED_LICENSES === "true",
  qiniuPublicBaseUrl: process.env.QINIU_PUBLIC_BASE_URL || "https://qny.lanrensoft.cn",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || "",
  modelGatewayEnabled: process.env.MODEL_GATEWAY_ENABLED !== "false",
  modelGatewayTokenSecret: process.env.MODEL_GATEWAY_TOKEN_SECRET || process.env.SESSION_SECRET || "development-session-secret-change-me",
  modelGatewayTokenTtlSeconds: Number(process.env.MODEL_GATEWAY_TOKEN_TTL_SECONDS || 6 * 60 * 60),
  modelGatewayClientToken: process.env.MODEL_GATEWAY_CLIENT_TOKEN || "",
  modelGatewayProviders: process.env.MODEL_GATEWAY_PROVIDERS || "",
  modelGatewayDefaultProvider: process.env.MODEL_GATEWAY_DEFAULT_PROVIDER || "deepseek",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic",
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY || "",
  dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/apps/anthropic",
  kimiApiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || "",
  kimiBaseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL || "https://api.moonshot.ai/anthropic",
  glmApiKey: process.env.GLM_API_KEY || process.env.ZAI_API_KEY || process.env.ZHIPU_API_KEY || "",
  glmBaseUrl: process.env.GLM_BASE_URL || process.env.ZAI_BASE_URL || "https://api.z.ai/api/anthropic",
  litellmApiKey: process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || "",
  litellmBaseUrl: process.env.LITELLM_BASE_URL || "http://litellm:4000",
  localAnthropicApiKey: process.env.LOCAL_ANTHROPIC_API_KEY || process.env.LOCAL_MODEL_API_KEY || "",
  localAnthropicBaseUrl: process.env.LOCAL_ANTHROPIC_BASE_URL || "",
  localAnthropicModel: process.env.LOCAL_ANTHROPIC_MODEL || "local-qwen",
};

export function requireDatabaseUrl() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
}
