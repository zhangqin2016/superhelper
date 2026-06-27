"use strict";

// 智谱 Zhipu / BigModel (CogView) image adapter. Synchronous: POST
// {base}/images/generations returns the URL inline. Bearer auth with the raw
// API key (JWT optional, not used). base already includes /api/paas/v4.

const { requestJson } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

function apiKey(env) {
  return env.ZHIPU_API_KEY || env.BIGMODEL_API_KEY || "";
}

function baseUrl(env) {
  return (env.ZHIPU_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

module.exports = {
  id: "zhipu",
  async generate(input, ctx) {
    const env = ctx.env;
    const key = apiKey(env);
    if (!key) {
      throw new Error(ctx.msg("缺少 ZHIPU_API_KEY。请在模型配置或环境变量中配置。", "Missing ZHIPU_API_KEY. Configure it in model settings or environment variables."));
    }
    const model = input.model || env.ZHIPU_IMAGE_MODEL || "cogview-4-250304";
    const payload = {
      model,
      prompt: input.prompt,
      size: input.size || "1024x1024",
    };

    ctx.logProgress(ctx.msg("正在调用智谱 CogView 生成图片...", "Calling Zhipu CogView for image generation..."));
    const result = await requestJson(`${baseUrl(env)}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: Number(input.timeout_ms || 120_000),
    });
    const urls = Array.isArray(result?.data) ? result.data.map((item) => item?.url).filter(Boolean) : [];
    if (!urls.length) {
      throw new Error(`${ctx.msg("智谱图片任务完成，但没有找到图片 URL。", "Zhipu image task finished but no image URL was returned.")}\n${JSON.stringify(result, null, 2)}`);
    }
    return { urls };
  },
};
