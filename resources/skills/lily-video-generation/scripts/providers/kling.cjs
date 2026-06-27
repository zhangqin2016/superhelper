"use strict";

// Kling 可灵 video adapter. Async create + poll. text2video / image2video chosen
// by whether an input image is present. Per-request HS256 JWT auth (server-signed
// in gateway mode, locally signed from AccessKey+SecretKey in direct/BYOK mode).
// Quirks: duration is a STRING ("5"/"10"); cfg_scale is 0–1; mode is std/pro.

const { requestJson, sleep, pollIntervalMs, signHs256Jwt } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://api-beijing.klingai.com";

function baseUrl(env) {
  return (env.KLING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function authToken(env, ctx) {
  if (env.KLING_API_KEY) return env.KLING_API_KEY;
  if (env.KLING_ACCESS_KEY && env.KLING_SECRET_KEY) {
    return signHs256Jwt({ accessKey: env.KLING_ACCESS_KEY, secretKey: env.KLING_SECRET_KEY });
  }
  throw new Error(
    ctx.msg(
      "缺少可灵凭证：网关模式需 KLING_API_KEY，直连模式需 KLING_ACCESS_KEY + KLING_SECRET_KEY。",
      "Missing Kling credentials: gateway mode needs KLING_API_KEY, direct mode needs KLING_ACCESS_KEY + KLING_SECRET_KEY.",
    ),
  );
}

module.exports = {
  id: "kling",
  async generate(input, ctx) {
    const env = ctx.env;
    const token = authToken(env, ctx);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const media = Array.isArray(input.media) ? input.media.filter((item) => item && item.url) : [];
    const isI2v = media.length > 0;
    const model = input.model || env.KLING_VIDEO_MODEL || "kling-v1-6";
    const endpoint = isI2v ? "image2video" : "text2video";

    const payload = {
      model_name: model,
      prompt: input.prompt,
      ...(input.negative_prompt ? { negative_prompt: input.negative_prompt } : {}),
      cfg_scale: input.cfg_scale != null ? Number(input.cfg_scale) : 0.5,
      mode: input.mode || "std",
      duration: String(input.duration || 5),
      ...(isI2v
        ? { image: media[0].url, ...(media[1]?.url ? { image_tail: media[1].url } : {}) }
        : { aspect_ratio: input.aspect_ratio || input.ratio || "16:9" }),
    };

    ctx.logProgress(ctx.msg("正在提交可灵视频任务...", "Submitting Kling video task..."));
    const create = await requestJson(`${baseUrl(env)}/v1/videos/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const taskId = create?.data?.task_id || create?.task_id || "";
    if (!taskId) {
      throw new Error(`${ctx.msg("可灵未返回 task_id。", "Kling did not return a task_id.")}\n${JSON.stringify(create, null, 2)}`);
    }
    ctx.logProgress(ctx.msg(`任务已提交：${taskId}`, `Task submitted: ${taskId}`));

    const deadline = Date.now() + Number(input.timeout_ms || 900_000);
    const taskUrl = `${baseUrl(env)}/v1/videos/${endpoint}/${encodeURIComponent(taskId)}`;
    const intervalMs = pollIntervalMs(5000);
    let lastStatus = "";
    while (Date.now() < deadline) {
      const data = await requestJson(taskUrl, { method: "GET", headers });
      const status = String(data?.data?.task_status || data?.task_status || "").toLowerCase();
      if (status && status !== lastStatus) {
        ctx.logProgress(ctx.msg(`任务状态：${status}`, `Task status: ${status}`));
        lastStatus = status;
      }
      if (status === "succeed" || status === "succeeded") {
        const videos = data?.data?.task_result?.videos || data?.task_result?.videos || [];
        const urls = videos.map((item) => item?.url).filter(Boolean);
        if (!urls.length) {
          throw new Error(`${ctx.msg("视频任务完成，但没有找到视频 URL。", "Video task finished but no video URL was returned.")}\n${JSON.stringify(data, null, 2)}`);
        }
        return { taskId, urls };
      }
      if (status === "failed") {
        throw new Error(data?.data?.task_status_msg || data?.message || ctx.msg(`任务失败：${status}`, `Task failed: ${status}`));
      }
      await sleep(intervalMs);
    }
    throw new Error(ctx.msg(`视频生成超时，task_id=${taskId}`, `Video generation timed out, task_id=${taskId}`));
  },
};
