"use strict";

// Volcengine Ark (即梦 Seedream) image adapter. Uses the Ark Bearer-key surface
// (NOT the AK/SK-signed visual.volcengineapi.com API). Image generation is
// synchronous: POST /images/generations returns the image inline, no polling.

const { requestJson } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

function apiKey(env) {
  return env.VOLCENGINE_API_KEY || env.ARK_API_KEY || "";
}

function baseUrl(env) {
  return (env.VOLCENGINE_IMAGE_BASE_URL || env.VOLCENGINE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

module.exports = {
  id: "volcengine",
  async generate(input, ctx) {
    const env = ctx.env;
    const key = apiKey(env);
    if (!key) {
      throw new Error(
        ctx.msg(
          "缺少 VOLCENGINE_API_KEY（火山方舟 Ark API Key）。请在模型配置或环境变量中配置。",
          "Missing VOLCENGINE_API_KEY (Volcengine Ark API key). Configure it in model settings or environment variables.",
        ),
      );
    }
    const model = input.model || env.VOLCENGINE_IMAGE_MODEL || "doubao-seedream-4-0-250828";
    const payload = {
      model,
      prompt: input.prompt,
      size: input.size || "2K",
      response_format: "url",
      watermark: input.watermark === true,
      ...(input.seed != null ? { seed: Number(input.seed) } : {}),
      ...(input.image ? { image: input.image } : {}),
    };

    ctx.logProgress(ctx.msg("正在调用火山方舟 Seedream 生成图片...", "Calling Volcengine Seedream for image generation..."));
    const result = await requestJson(`${baseUrl(env)}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: Number(input.timeout_ms || 120_000),
    });

    const data = Array.isArray(result?.data) ? result.data : [];
    const urls = data.map((item) => item?.url).filter(Boolean);
    const buffers = data
      .filter((item) => !item?.url && item?.b64_json)
      .map((item) => ({ data: Buffer.from(item.b64_json, "base64"), ext: "png" }));
    if (!urls.length && !buffers.length) {
      throw new Error(
        `${ctx.msg("火山方舟图片任务完成，但没有找到图片。", "Volcengine image task finished but no image was returned.")}\n${JSON.stringify(result, null, 2)}`,
      );
    }
    return { urls, buffers };
  },
};
