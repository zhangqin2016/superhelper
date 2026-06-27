"use strict";

// DashScope (Alibaba Bailian / 通义万相 Wan) video adapter. Original hardcoded
// flow moved verbatim behind the adapter interface: video-synthesis create
// (X-DashScope-Async) + /tasks/{id} poll, same env vars and response parsing, so
// the default provider behaves exactly as before.

const { requestJson, sleep, pollIntervalMs } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const CREATE_PATH = "/services/aigc/video-generation/video-synthesis";

function apiKey(env) {
  return env.DASHSCOPE_API_KEY || env.ALIYUN_BAILIAN_API_KEY || "";
}

function baseUrl(env) {
  return (env.DASHSCOPE_VIDEO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function createUrl(env) {
  return env.DASHSCOPE_VIDEO_ENDPOINT || `${baseUrl(env)}${CREATE_PATH}`;
}

function extractTaskId(data) {
  return data?.output?.task_id || data?.task_id || data?.data?.task_id || "";
}

function extractStatus(data) {
  return String(data?.output?.task_status || data?.task_status || data?.status || "").toUpperCase();
}

function collectVideoUrls(data) {
  const output = data?.output || data || {};
  const urls = [];
  for (const key of ["video_url", "url", "result_url"]) {
    if (output[key]) urls.push(output[key]);
    if (output.task_result?.[key]) urls.push(output.task_result[key]);
  }
  const lists = [output.results, output.videos, output.task_result?.results, data?.data];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = item?.video_url || item?.url || item?.result_url;
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

async function pollTask(taskId, key, env, timeoutMs, ctx) {
  const deadline = Date.now() + timeoutMs;
  const taskUrl = `${baseUrl(env)}/tasks/${encodeURIComponent(taskId)}`;
  const intervalMs = pollIntervalMs(5000);
  while (Date.now() < deadline) {
    const data = await requestJson(taskUrl, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
    const status = extractStatus(data);
    if (status === "SUCCEEDED" || status === "SUCCESS") return data;
    if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
      throw new Error(data?.output?.message || data?.message || ctx.msg(`任务失败：${status}`, `Task failed: ${status}`));
    }
    await sleep(intervalMs);
  }
  throw new Error(ctx.msg(`视频生成超时，task_id=${taskId}`, `Video generation timed out, task_id=${taskId}`));
}

module.exports = {
  id: "dashscope",
  async generate(input, ctx) {
    const env = ctx.env;
    const key = apiKey(env);
    if (!key) {
      throw new Error(
        ctx.msg(
          "缺少 DASHSCOPE_API_KEY。请在模型配置或环境变量中配置百炼 API Key。",
          "Missing DASHSCOPE_API_KEY. Configure the DashScope API key in model settings or environment variables.",
        ),
      );
    }
    const media = Array.isArray(input.media) ? input.media.filter((item) => item && item.type && item.url) : [];
    const model = input.model || env.DASHSCOPE_VIDEO_MODEL || (media.length ? "wan2.7-i2v-2026-04-25" : "wan2.7-t2v");
    const payload = {
      model,
      input: {
        prompt: input.prompt,
        ...(input.negative_prompt ? { negative_prompt: input.negative_prompt } : {}),
        ...(media.length ? { media } : {}),
        ...(input.audio_url ? { audio_url: input.audio_url } : {}),
      },
      parameters: {
        resolution: input.resolution || "720P",
        ratio: input.ratio || "16:9",
        duration: Number(input.duration || 5),
        prompt_extend: input.prompt_extend !== false,
        watermark: input.watermark === true,
      },
    };

    const create = await requestJson(createUrl(env), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
      body: JSON.stringify(payload),
    });
    const taskId = extractTaskId(create);
    if (!taskId) {
      throw new Error(`${ctx.msg("百炼未返回 task_id。", "DashScope did not return a task_id.")}\n${JSON.stringify(create, null, 2)}`);
    }
    const result = await pollTask(taskId, key, env, Number(input.timeout_ms || 900_000), ctx);
    const urls = collectVideoUrls(result);
    if (!urls.length) {
      throw new Error(
        `${ctx.msg("视频任务完成，但没有找到视频 URL。", "Video task finished but no video URL was returned.")}\n${JSON.stringify(result, null, 2)}`,
      );
    }
    return { taskId, urls };
  },
};
