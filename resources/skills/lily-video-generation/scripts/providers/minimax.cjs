"use strict";

// MiniMax 海螺 video adapter. Async 3-step: create -> poll status -> retrieve
// file download URL. Bearer auth; China platform may require a GroupId query
// param on the create/query/retrieve calls (MINIMAX_GROUP_ID in direct mode,
// appended server-side in gateway mode).
//   create:   POST /v1/video_generation            -> top-level task_id
//   poll:     GET  /v1/query/video_generation?task_id=  -> status + file_id
//   retrieve: GET  /v1/files/retrieve?file_id=      -> file.download_url

const { requestJson, sleep, pollIntervalMs } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://api.minimaxi.com";

function apiKey(env) {
  return env.MINIMAX_API_KEY || "";
}

function baseUrl(env) {
  return (env.MINIMAX_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function groupParam(env, leading) {
  if (!env.MINIMAX_GROUP_ID) return "";
  return `${leading}GroupId=${encodeURIComponent(env.MINIMAX_GROUP_ID)}`;
}

function checkBaseResp(data, ctx) {
  if (data?.base_resp && Number(data.base_resp.status_code) !== 0) {
    throw new Error(data.base_resp.status_msg || ctx.msg("MiniMax 调用失败。", "MiniMax call failed."));
  }
}

module.exports = {
  id: "minimax",
  async generate(input, ctx) {
    const env = ctx.env;
    const key = apiKey(env);
    if (!key) {
      throw new Error(ctx.msg("缺少 MINIMAX_API_KEY。请在模型配置或环境变量中配置。", "Missing MINIMAX_API_KEY. Configure it in model settings or environment variables."));
    }
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const media = Array.isArray(input.media) ? input.media.filter((item) => item && item.url) : [];
    const model = input.model || env.MINIMAX_VIDEO_MODEL || "MiniMax-Hailuo-2.3";
    const base = baseUrl(env);

    const payload = {
      model,
      prompt: input.prompt,
      duration: Number(input.duration || 6),
      resolution: input.resolution || "1080P",
      ...(media[0]?.url ? { first_frame_image: media[0].url } : {}),
      ...(media[1]?.url ? { last_frame_image: media[1].url } : {}),
    };

    ctx.logProgress(ctx.msg("正在提交 MiniMax 视频任务...", "Submitting MiniMax video task..."));
    const create = await requestJson(`${base}/v1/video_generation${groupParam(env, "?")}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    checkBaseResp(create, ctx);
    const taskId = create?.task_id || "";
    if (!taskId) {
      throw new Error(`${ctx.msg("MiniMax 未返回 task_id。", "MiniMax did not return a task_id.")}\n${JSON.stringify(create, null, 2)}`);
    }
    ctx.logProgress(ctx.msg(`任务已提交：${taskId}`, `Task submitted: ${taskId}`));

    const deadline = Date.now() + Number(input.timeout_ms || 900_000);
    const intervalMs = pollIntervalMs(10_000);
    let fileId = "";
    let lastStatus = "";
    while (Date.now() < deadline) {
      const data = await requestJson(
        `${base}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}${groupParam(env, "&")}`,
        { method: "GET", headers },
      );
      checkBaseResp(data, ctx);
      const status = String(data?.status || "").toLowerCase();
      if (status && status !== lastStatus) {
        ctx.logProgress(ctx.msg(`任务状态：${status}`, `Task status: ${status}`));
        lastStatus = status;
      }
      if (status === "success") {
        fileId = data?.file_id || "";
        break;
      }
      if (status === "fail" || status === "failed") {
        throw new Error(ctx.msg(`任务失败：${status}`, `Task failed: ${status}`));
      }
      await sleep(intervalMs);
    }
    if (!fileId) {
      throw new Error(ctx.msg(`视频生成超时，task_id=${taskId}`, `Video generation timed out, task_id=${taskId}`));
    }

    const file = await requestJson(
      `${base}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}${groupParam(env, "&")}`,
      { method: "GET", headers },
    );
    checkBaseResp(file, ctx);
    const url = file?.file?.download_url || "";
    if (!url) {
      throw new Error(`${ctx.msg("视频任务完成，但没有找到下载地址。", "Video task finished but no download URL was returned.")}\n${JSON.stringify(file, null, 2)}`);
    }
    return { taskId, urls: [url] };
  },
};
