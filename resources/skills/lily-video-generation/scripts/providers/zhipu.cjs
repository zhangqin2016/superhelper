"use strict";

// 智谱 Zhipu / BigModel (CogVideoX) video adapter. Async 2-step: create returns a
// top-level `id` + task_status; poll GET {base}/async-result/{id} until SUCCESS.
// Bearer auth with the raw API key. base already includes /api/paas/v4. Result
// URLs live at video_result[].url. image_url enables image-to-video.

const { requestJson, sleep, pollIntervalMs } = require("./_shared.cjs");

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
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const media = Array.isArray(input.media) ? input.media.filter((item) => item && item.url) : [];
    const model = input.model || env.ZHIPU_VIDEO_MODEL || "cogvideox-3";

    const payload = {
      model,
      prompt: input.prompt,
      ...(media[0]?.url ? { image_url: media[0].url } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.size || input.resolution ? { size: input.size || input.resolution } : {}),
      duration: Number(input.duration || 5),
      ...(input.fps ? { fps: Number(input.fps) } : {}),
      ...(input.with_audio != null ? { with_audio: input.with_audio === true } : {}),
    };

    ctx.logProgress(ctx.msg("正在提交智谱 CogVideoX 视频任务...", "Submitting Zhipu CogVideoX video task..."));
    const create = await requestJson(`${baseUrl(env)}/videos/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const taskId = create?.id || "";
    if (!taskId) {
      throw new Error(`${ctx.msg("智谱未返回任务 id。", "Zhipu did not return a task id.")}\n${JSON.stringify(create, null, 2)}`);
    }
    ctx.logProgress(ctx.msg(`任务已提交：${taskId}`, `Task submitted: ${taskId}`));

    const deadline = Date.now() + Number(input.timeout_ms || 900_000);
    const taskUrl = `${baseUrl(env)}/async-result/${encodeURIComponent(taskId)}`;
    const intervalMs = pollIntervalMs(5000);
    let lastStatus = "";
    while (Date.now() < deadline) {
      const data = await requestJson(taskUrl, { method: "GET", headers });
      const status = String(data?.task_status || "").toUpperCase();
      if (status && status !== lastStatus) {
        ctx.logProgress(ctx.msg(`任务状态：${status}`, `Task status: ${status}`));
        lastStatus = status;
      }
      if (status === "SUCCESS") {
        const urls = Array.isArray(data?.video_result) ? data.video_result.map((item) => item?.url).filter(Boolean) : [];
        if (!urls.length) {
          throw new Error(`${ctx.msg("视频任务完成，但没有找到视频 URL。", "Video task finished but no video URL was returned.")}\n${JSON.stringify(data, null, 2)}`);
        }
        return { taskId, urls };
      }
      if (status === "FAIL" || status === "FAILED") {
        throw new Error(ctx.msg(`任务失败：${status}`, `Task failed: ${status}`));
      }
      await sleep(intervalMs);
    }
    throw new Error(ctx.msg(`视频生成超时，task_id=${taskId}`, `Video generation timed out, task_id=${taskId}`));
  },
};
