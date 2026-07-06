"use strict";

const path = require("node:path");
const { requestJson } = require("./_shared.cjs");

function envValue(env, ...names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function endpointUrl(env) {
  const explicit = envValue(env, "LILY_MEDIA_VIDEO_ENDPOINT", "LILY_GPU_VIDEO_ENDPOINT");
  if (explicit) return explicit;
  const specificBase = envValue(env, "LILY_MEDIA_VIDEO_BASE_URL", "LILY_GPU_VIDEO_BASE_URL");
  if (specificBase) return `${specificBase.replace(/\/+$/, "")}/generate`;
  const base = envValue(env, "LILY_MEDIA_BASE_URL", "LILY_GPU_BASE_URL");
  if (base) return `${base.replace(/\/+$/, "")}/video/generate`;
  return "";
}

function authHeaders(env) {
  const key = envValue(env, "LILY_MEDIA_API_KEY", "LILY_GPU_API_KEY");
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function collectUrls(value, urls = []) {
  if (!value) return urls;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) || /^file:/i.test(value) || path.isAbsolute(value)) urls.push(value);
    return urls;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
    return urls;
  }
  if (typeof value === "object") {
    for (const key of ["video_url", "video", "url", "result_url", "public_url", "download_url", "file_url", "file"]) {
      if (value[key]) collectUrls(value[key], urls);
    }
    for (const key of ["output", "data", "result", "results", "videos", "files"]) {
      if (value[key]) collectUrls(value[key], urls);
    }
  }
  return urls;
}

function collectBuffers(value, buffers = []) {
  if (!value || typeof value !== "object") return buffers;
  const candidates = [];
  for (const key of ["video_base64", "b64_json", "base64", "data_base64"]) {
    if (typeof value[key] === "string") candidates.push(value[key]);
  }
  for (const raw of candidates) {
    const match = raw.match(/^data:video\/([a-z0-9+.-]+);base64,(.+)$/i);
    const ext = match ? match[1].replace("quicktime", "mov") : "mp4";
    const body = match ? match[2] : raw;
    try {
      buffers.push({ ext, data: Buffer.from(body, "base64") });
    } catch {
      // Ignore malformed base64; the caller fails if no usable output remains.
    }
  }
  for (const item of Object.values(value)) {
    if (Array.isArray(item)) for (const child of item) collectBuffers(child, buffers);
    else if (item && typeof item === "object") collectBuffers(item, buffers);
  }
  return buffers.filter((item) => item.data.length > 0);
}

module.exports = {
  id: "lily",
  async generate(input, ctx) {
    const env = ctx.env;
    const url = endpointUrl(env);
    if (!url) {
      throw new Error("Missing LILY_MEDIA_VIDEO_ENDPOINT or LILY_MEDIA_VIDEO_BASE_URL for Lily GPU video generation.");
    }
    const payload = {
      prompt: input.prompt,
      negative_prompt: input.negative_prompt || "",
      ratio: input.ratio || "16:9",
      resolution: input.resolution || "720P",
      duration: Number(input.duration || 5),
      media: Array.isArray(input.media) ? input.media : [],
      model: input.model || env.LILY_MEDIA_VIDEO_MODEL || env.LILY_GPU_VIDEO_MODEL || "wan2.2",
      prompt_extend: input.prompt_extend !== false,
      watermark: input.watermark === true,
    };
    ctx.logProgress(ctx.msg("正在提交 Lily GPU 视频生成任务...", "Submitting Lily GPU video generation task..."));
    const data = await requestJson(url, {
      method: "POST",
      headers: { ...authHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: Number(input.timeout_ms || 900_000),
    });
    const urls = [...new Set(collectUrls(data))];
    const buffers = collectBuffers(data);
    const taskId = data?.task_id || data?.id || data?.output?.task_id || "";
    if (!urls.length && !buffers.length) {
      throw new Error(`Lily GPU video generation returned no video URL or video bytes.\n${JSON.stringify(data, null, 2)}`);
    }
    return { taskId, urls, buffers };
  },
};
