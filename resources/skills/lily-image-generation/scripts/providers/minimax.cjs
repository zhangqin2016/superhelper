"use strict";

// MiniMax 海螺 image adapter. Synchronous: POST /v1/image_generation returns the
// image(s) inline. Bearer auth. China platform may require a GroupId query param
// (delivered via MINIMAX_GROUP_ID in direct mode; appended server-side in gateway
// mode). Result lives at data.image_urls[] (or data.image_base64[]).

const { requestJson } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://api.minimaxi.com";

function apiKey(env) {
  return env.MINIMAX_API_KEY || "";
}

function baseUrl(env) {
  return (env.MINIMAX_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

module.exports = {
  id: "minimax",
  async generate(input, ctx) {
    const env = ctx.env;
    const key = apiKey(env);
    if (!key) {
      throw new Error(ctx.msg("缺少 MINIMAX_API_KEY。请在模型配置或环境变量中配置。", "Missing MINIMAX_API_KEY. Configure it in model settings or environment variables."));
    }
    const model = input.model || env.MINIMAX_IMAGE_MODEL || "image-01";
    const groupQuery = env.MINIMAX_GROUP_ID ? `?GroupId=${encodeURIComponent(env.MINIMAX_GROUP_ID)}` : "";
    const payload = {
      model,
      prompt: input.prompt,
      aspect_ratio: input.aspect_ratio || input.ratio || "1:1",
      response_format: "url",
      n: Number(input.n || 1),
      prompt_optimizer: input.prompt_extend !== false,
      ...(input.subject_reference ? { subject_reference: input.subject_reference } : {}),
    };

    ctx.logProgress(ctx.msg("正在调用 MiniMax 生成图片...", "Calling MiniMax for image generation..."));
    const result = await requestJson(`${baseUrl(env)}/v1/image_generation${groupQuery}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: Number(input.timeout_ms || 120_000),
    });
    if (result?.base_resp && Number(result.base_resp.status_code) !== 0) {
      throw new Error(result.base_resp.status_msg || ctx.msg("MiniMax 图片生成失败。", "MiniMax image generation failed."));
    }
    const urls = Array.isArray(result?.data?.image_urls) ? result.data.image_urls.filter(Boolean) : [];
    const buffers = Array.isArray(result?.data?.image_base64)
      ? result.data.image_base64.filter(Boolean).map((b64) => ({ data: Buffer.from(b64, "base64"), ext: "png" }))
      : [];
    if (!urls.length && !buffers.length) {
      throw new Error(`${ctx.msg("MiniMax 图片任务完成，但没有找到图片。", "MiniMax image task finished but no image was returned.")}\n${JSON.stringify(result, null, 2)}`);
    }
    return { urls, buffers };
  },
};
