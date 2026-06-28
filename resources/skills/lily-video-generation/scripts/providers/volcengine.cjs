"use strict";

// Volcengine Ark (即梦 Seedance) video adapter. Ark Bearer-key surface. Video is
// async: POST /contents/generations/tasks returns a top-level `id`; poll
// GET /contents/generations/tasks/{id} until status succeeded. Quirk: Seedance
// generation params go as `--flags` inside the content text string, not as
// top-level fields. Result URL lives at content.video_url.

const { requestJson, sleep, pollIntervalMs } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

function apiKey(env) {
  return env.VOLCENGINE_API_KEY || env.ARK_API_KEY || "";
}

function baseUrl(env) {
  return (env.VOLCENGINE_VIDEO_BASE_URL || env.VOLCENGINE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

// Map our normalized inputs onto Seedance --flags appended to the prompt text.
function buildText(input) {
  const flags = [];
  const resolution = String(input.resolution || "720p").toLowerCase();
  flags.push(`--resolution ${resolution}`);
  flags.push(`--duration ${Number(input.duration || 5)}`);
  if (input.ratio) flags.push(`--ratio ${input.ratio}`);
  if (input.camerafixed != null) flags.push(`--camerafixed ${input.camerafixed ? "true" : "false"}`);
  if (input.seed != null) flags.push(`--seed ${Number(input.seed)}`);
  if (input.watermark === true) flags.push("--watermark true");
  return `${input.prompt} ${flags.join(" ")}`.trim();
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
    const media = Array.isArray(input.media) ? input.media.filter((item) => item && item.url) : [];
    const model = input.model || env.VOLCENGINE_VIDEO_MODEL
      || (media.length ? "doubao-seedance-1-0-lite-i2v-250428" : "doubao-seedance-1-0-lite-t2v-250428");

    const content = [{ type: "text", text: buildText(input) }];
    for (const item of media) {
      content.push({
        type: "image_url",
        image_url: { url: item.url },
        ...(item.role ? { role: item.role } : {}),
      });
    }

    ctx.logProgress(ctx.msg("正在提交火山方舟 Seedance 视频任务...", "Submitting Volcengine Seedance video task..."));
    const create = await requestJson(`${baseUrl(env)}/contents/generations/tasks`, {
      method: "POST",
      timeoutMs: Number(input.submit_timeout_ms || 180_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, content }),
    });
    const taskId = create?.id || create?.data?.id || "";
    if (!taskId) {
      throw new Error(`${ctx.msg("火山方舟未返回任务 id。", "Volcengine did not return a task id.")}\n${JSON.stringify(create, null, 2)}`);
    }
    ctx.logProgress(ctx.msg(`任务已提交：${taskId}`, `Task submitted: ${taskId}`));

    const deadline = Date.now() + Number(input.timeout_ms || 900_000);
    const taskUrl = `${baseUrl(env)}/contents/generations/tasks/${encodeURIComponent(taskId)}`;
    const intervalMs = pollIntervalMs(5000);
    let lastStatus = "";
    while (Date.now() < deadline) {
      const data = await requestJson(taskUrl, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
      const status = String(data?.status || "").toLowerCase();
      if (status && status !== lastStatus) {
        ctx.logProgress(ctx.msg(`任务状态：${status}`, `Task status: ${status}`));
        lastStatus = status;
      }
      if (status === "succeeded" || status === "success") {
        const url = data?.content?.video_url || data?.content?.url;
        if (!url) {
          throw new Error(
            `${ctx.msg("视频任务完成，但没有找到视频 URL。", "Video task finished but no video URL was returned.")}\n${JSON.stringify(data, null, 2)}`,
          );
        }
        return { taskId, urls: [url] };
      }
      if (status === "failed" || status === "cancelled" || status === "canceled") {
        throw new Error(data?.error?.message || data?.message || ctx.msg(`任务失败：${status}`, `Task failed: ${status}`));
      }
      await sleep(intervalMs);
    }
    throw new Error(ctx.msg(`视频生成超时，task_id=${taskId}`, `Video generation timed out, task_id=${taskId}`));
  },
};
