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
  qiniuAccessKey: process.env.QINIU_ACCESS_KEY || process.env.QINIU_AK || "",
  qiniuSecretKey: process.env.QINIU_SECRET_KEY || process.env.QINIU_SK || "",
  qiniuBucket: process.env.QINIU_BUCKET || "lanrensoft",
  qiniuUploadUrl: process.env.QINIU_UPLOAD_URL || "https://upload.qiniup.com",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || "",
  webBaseUrl: process.env.WEB_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || process.env.PUBLIC_BASE_URL || "https://www.lilywb.cn",
  userTokenPepper: process.env.USER_TOKEN_PEPPER || process.env.SESSION_SECRET || "development-session-secret-change-me",
  smsCodePepper: process.env.SMS_CODE_PEPPER || process.env.SESSION_SECRET || "development-session-secret-change-me",
  smsAliyunAccessKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID || "",
  smsAliyunAccessKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || "",
  smsAliyunSignName: process.env.ALIYUN_SMS_SIGN_NAME || "",
  smsAliyunTemplateLogin: process.env.ALIYUN_SMS_TEMPLATE_LOGIN || "",
  smsAliyunRegion: process.env.ALIYUN_SMS_REGION || "cn-hangzhou",
  accountFreeTokens: Number(process.env.ACCOUNT_FREE_TOKENS || 100000),
  accountFreeImages: Number(process.env.ACCOUNT_FREE_IMAGES || 3),
  accountFreeVideos: Number(process.env.ACCOUNT_FREE_VIDEOS || 1),
  accountFreeDays: Number(process.env.ACCOUNT_FREE_DAYS || 7),
  accountUsageEnforcementEnabled: process.env.ACCOUNT_USAGE_ENFORCEMENT !== "false",
  modelGatewayEnabled: process.env.MODEL_GATEWAY_ENABLED !== "false",
  modelGatewayTokenSecret: process.env.MODEL_GATEWAY_TOKEN_SECRET || process.env.SESSION_SECRET || "development-session-secret-change-me",
  modelGatewayTokenTtlSeconds: Number(process.env.MODEL_GATEWAY_TOKEN_TTL_SECONDS || 6 * 60 * 60),
  modelGatewayExpiredTokenGraceSeconds: Number(process.env.MODEL_GATEWAY_EXPIRED_TOKEN_GRACE_SECONDS || 0),
  modelGatewayClientToken: process.env.MODEL_GATEWAY_CLIENT_TOKEN || "",
  modelGatewayProviders: process.env.MODEL_GATEWAY_PROVIDERS || "",
  modelGatewayDefaultProvider: process.env.MODEL_GATEWAY_DEFAULT_PROVIDER || "deepseek",
  // Global default model menu provider allow-list. Empty means no narrowing:
  // expose exactly the configured chat providers. Set DEFAULT_MODEL_PROVIDERS
  // to "deepseek" when production should publish only DeepSeek; use "all" or
  // "*" as explicit no-narrowing aliases.
  defaultModelProviders: String(process.env.DEFAULT_MODEL_PROVIDERS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  modelConfigDeliveryMode: String(process.env.MODEL_CONFIG_DELIVERY_MODE || "gateway").toLowerCase(),
  // Opt-in: query each enabled provider's /models endpoint to auto-discover the
  // models its key supports, augmenting the configured list. Off by default —
  // when off (or on failure) the configured/built-in list is used unchanged.
  modelDiscoveryEnabled: process.env.MODEL_DISCOVERY_ENABLED === "true",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/anthropic",
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY || "",
  dashscopeChatApiKey: process.env.DASHSCOPE_CHAT_API_KEY || process.env.DASHSCOPE_LLM_API_KEY || "",
  dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/apps/anthropic",
  dashscopeModel: process.env.DASHSCOPE_MODEL || "qwen3-coder-plus",
  visionModel: process.env.VISION_MODEL || "qwen-vl-max",
  // Server-side vision + web-search proxies (key stays on server; clients use a
  // gateway token). Vision reuses the DashScope key (dashscopeApiKey).
  visionUpstreamBaseUrl: process.env.VISION_UPSTREAM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  dashscopeMediaBaseUrl: process.env.DASHSCOPE_MEDIA_BASE_URL || "https://dashscope.aliyuncs.com/api/v1",
  webSearchIqsApiKey: process.env.WEBSEARCH_IQS_API_KEY || process.env.IQS_API_KEY || "",
  webSearchIqsApiUrl: process.env.WEBSEARCH_IQS_API_URL || "https://cloud-iqs.aliyuncs.com/search/unified",
  dashscopeImageModel: process.env.DASHSCOPE_IMAGE_MODEL || "qwen-image-2.0-pro",
  dashscopeVideoModel: process.env.DASHSCOPE_VIDEO_MODEL || "wan2.7-t2v",
  dashscopeTtsModel: process.env.DASHSCOPE_TTS_MODEL || "cosyvoice-v3-flash",
  dashscopeTtsVoice: process.env.DASHSCOPE_TTS_VOICE || "longanyang",
  dashscopeImageEndpoint: process.env.DASHSCOPE_IMAGE_ENDPOINT || "",
  dashscopeVideoEndpoint: process.env.DASHSCOPE_VIDEO_ENDPOINT || "",
  dashscopeTtsEndpoint: process.env.DASHSCOPE_TTS_ENDPOINT || "",
  // Volcengine Ark (即梦 Seedream image / Seedance video). Bearer-key surface.
  volcengineApiKey: process.env.VOLCENGINE_API_KEY || process.env.ARK_API_KEY || "",
  volcengineBaseUrl: process.env.VOLCENGINE_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
  volcengineImageModel: process.env.VOLCENGINE_IMAGE_MODEL || "doubao-seedream-4-0-250828",
  volcengineVideoModel: process.env.VOLCENGINE_VIDEO_MODEL || "doubao-seedance-1-0-lite-t2v-250428",
  // Kling 可灵 (JWT auth from AccessKey + SecretKey). The SecretKey stays
  // server-side: in gateway mode the server signs the per-request JWT.
  klingAccessKey: process.env.KLING_ACCESS_KEY || "",
  klingSecretKey: process.env.KLING_SECRET_KEY || "",
  klingBaseUrl: process.env.KLING_BASE_URL || "https://api-beijing.klingai.com",
  klingImageModel: process.env.KLING_IMAGE_MODEL || "kling-v1-5",
  klingVideoModel: process.env.KLING_VIDEO_MODEL || "kling-v1-6",
  // MiniMax 海螺 (Bearer; China platform may require a GroupId).
  minimaxApiKey: process.env.MINIMAX_API_KEY || "",
  minimaxGroupId: process.env.MINIMAX_GROUP_ID || "",
  minimaxBaseUrl: process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com",
  minimaxImageModel: process.env.MINIMAX_IMAGE_MODEL || "image-01",
  minimaxVideoModel: process.env.MINIMAX_VIDEO_MODEL || "MiniMax-Hailuo-2.3",
  // 智谱 Zhipu / BigModel (Bearer raw key). CogView image / CogVideoX video.
  zhipuApiKey: process.env.ZHIPU_API_KEY || process.env.BIGMODEL_API_KEY || "",
  zhipuBaseUrl: process.env.ZHIPU_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
  zhipuImageModel: process.env.ZHIPU_IMAGE_MODEL || "cogview-4-250304",
  zhipuVideoModel: process.env.ZHIPU_VIDEO_MODEL || "cogvideox-3",
  // Default media providers for image/video skills (admin-overridable). Clients
  // can still override per-call via input.provider.
  mediaImageProvider: process.env.MEDIA_IMAGE_PROVIDER || "dashscope",
  mediaVideoProvider: process.env.MEDIA_VIDEO_PROVIDER || "dashscope",
  mediaSpeechProvider: process.env.MEDIA_SPEECH_PROVIDER || process.env.MEDIA_TTS_PROVIDER || "dashscope",
  lilyMediaApiKey: process.env.LILY_MEDIA_API_KEY || process.env.LILY_GPU_API_KEY || "",
  lilyMediaBaseUrl: process.env.LILY_MEDIA_BASE_URL || process.env.LILY_GPU_BASE_URL || "",
  lilyMediaImageBaseUrl: process.env.LILY_MEDIA_IMAGE_BASE_URL || process.env.LILY_GPU_IMAGE_BASE_URL || "",
  lilyMediaVideoBaseUrl: process.env.LILY_MEDIA_VIDEO_BASE_URL || process.env.LILY_GPU_VIDEO_BASE_URL || "",
  lilyMediaSpeechBaseUrl: process.env.LILY_MEDIA_SPEECH_BASE_URL || process.env.LILY_MEDIA_TTS_BASE_URL || process.env.LILY_GPU_SPEECH_BASE_URL || process.env.LILY_GPU_TTS_BASE_URL || "",
  lilyMediaImageEndpoint: process.env.LILY_MEDIA_IMAGE_ENDPOINT || process.env.LILY_GPU_IMAGE_ENDPOINT || "",
  lilyMediaVideoEndpoint: process.env.LILY_MEDIA_VIDEO_ENDPOINT || process.env.LILY_GPU_VIDEO_ENDPOINT || "",
  lilyMediaSpeechEndpoint: process.env.LILY_MEDIA_SPEECH_ENDPOINT || process.env.LILY_MEDIA_TTS_ENDPOINT || process.env.LILY_GPU_SPEECH_ENDPOINT || process.env.LILY_GPU_TTS_ENDPOINT || "",
  lilyMediaSpeechVoice: process.env.LILY_MEDIA_TTS_VOICE || process.env.LILY_GPU_TTS_VOICE || "",
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
