"use strict";

// OpenAI-compatible Images API adapter (BYOK). Covers api.openai.com
// (gpt-image-1 / dall-e-3) and any self-hosted / proxy endpoint that speaks the
// same POST /images/generations shape. The user configures endpoint + key +
// image model under Settings → media providers ("own" source), which arrives
// here as OPENAI_IMAGE_API_KEY / OPENAI_IMAGE_BASE_URL / OPENAI_IMAGE_MODEL.
//
// Response handling is deliberately permissive so one adapter fits real OpenAI
// and the many compatible servers: we ask for b64_json (no second authed fetch)
// but also accept a returned url, and read the model/size the user set without
// hardcoding provider-specific values.

const { requestJson } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function apiKey(env) {
  return env.OPENAI_IMAGE_API_KEY || env.OPENAI_API_KEY || "";
}

function baseUrl(env) {
  return String(env.OPENAI_IMAGE_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function generationsUrl(env) {
  const base = baseUrl(env);
  // Accept a base that already ends in /images/generations, else append it.
  return /\/images\/generations$/.test(base) ? base : `${base}/images/generations`;
}

// Collect b64 payloads and/or urls from the several shapes compatible servers
// use (data[].b64_json / data[].url / top-level image / output[]).
function collectImages(data) {
  const buffers = [];
  const urls = [];
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.output) ? data.output : [];
  for (const row of rows) {
    const b64 = row?.b64_json || row?.b64 || row?.image_base64;
    if (b64) buffers.push({ data: Buffer.from(String(b64), "base64"), ext: "png" });
    const url = row?.url || row?.image_url || row?.image;
    if (!b64 && url) urls.push(url);
  }
  if (!buffers.length && !urls.length) {
    const b64 = data?.b64_json || data?.image_base64;
    if (b64) buffers.push({ data: Buffer.from(String(b64), "base64"), ext: "png" });
    else if (data?.url || data?.image) urls.push(data.url || data.image);
  }
  return { buffers, urls };
}

module.exports = {
  id: "openai",
  async generate(input, ctx) {
    const env = ctx.env;
    const key = apiKey(env);
    if (!key) {
      throw new Error(
        ctx.msg(
          "缺少 OpenAI 图片生成 API Key。请在设置 → 图片服务商中配置你自己的 Key、API 地址与图片模型。",
          "Missing OpenAI image API key. Configure your own key, base URL and image model under Settings → image providers.",
        ),
      );
    }
    const model = input.model || env.OPENAI_IMAGE_MODEL || "gpt-image-1";
    const payload = {
      model,
      prompt: input.prompt,
      n: Number(input.n || 1),
      ...(input.size ? { size: input.size } : {}),
      response_format: input.response_format || "b64_json",
    };

    ctx.logProgress(ctx.msg(`正在请求图片生成（${model}）...`, `Requesting image generation (${model})...`));
    let data;
    try {
      data = await requestJson(generationsUrl(env), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: Number(input.timeout_ms || 240_000),
      });
    } catch (error) {
      // gpt-image-1 rejects response_format (always returns b64). Retry once
      // without it rather than failing — adapt from the actual server response.
      if (/response_format/i.test(error?.message || "")) {
        const { response_format: _drop, ...rest } = payload;
        data = await requestJson(generationsUrl(env), {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(rest),
          timeoutMs: Number(input.timeout_ms || 240_000),
        });
      } else {
        throw error;
      }
    }

    const { buffers, urls } = collectImages(data);
    if (!buffers.length && !urls.length) {
      throw new Error(
        `${ctx.msg("图片任务完成，但没有找到图片数据。", "Image task finished but no image data was returned.")}\n${JSON.stringify(data, null, 2).slice(0, 800)}`,
      );
    }
    return { buffers, urls };
  },
};
