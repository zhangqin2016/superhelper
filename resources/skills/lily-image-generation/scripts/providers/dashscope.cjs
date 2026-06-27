"use strict";

// DashScope (Alibaba Bailian / Qwen-Image) image adapter. This is the original
// hardcoded flow, moved verbatim behind the adapter interface so the default
// provider behaves byte-for-byte as before: multimodal-generation create +
// /tasks/{id} poll, with the same env vars and response parsing.

const { requestJson, sleep, pollIntervalMs } = require("./_shared.cjs");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const CREATE_PATH = "/services/aigc/multimodal-generation/generation";

function apiKey(env) {
  return env.DASHSCOPE_API_KEY || env.ALIYUN_BAILIAN_API_KEY || "";
}

function baseUrl(env) {
  return (env.DASHSCOPE_IMAGE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function createUrl(env) {
  return env.DASHSCOPE_IMAGE_ENDPOINT || `${baseUrl(env)}${CREATE_PATH}`;
}

function extractTaskId(data) {
  return data?.output?.task_id || data?.task_id || data?.data?.task_id || "";
}

function extractStatus(data) {
  return String(data?.output?.task_status || data?.task_status || data?.status || "").toUpperCase();
}

function collectImageUrls(data) {
  const urls = [];
  const output = data?.output || data || {};
  const choices = output.choices || data?.choices || [];
  for (const choice of choices) {
    const content = choice?.message?.content || choice?.content || [];
    for (const item of Array.isArray(content) ? content : []) {
      if (item?.image) urls.push(item.image);
      if (item?.url) urls.push(item.url);
    }
  }
  const candidates = [
    output.results,
    output.task_result?.results,
    output.images,
    output.task_result?.images,
    data?.data,
  ];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = item?.url || item?.image_url || item?.result_url;
      if (url) urls.push(url);
    }
  }
  if (output.url) urls.push(output.url);
  if (output.image_url) urls.push(output.image_url);
  return [...new Set(urls)];
}

async function pollTask(taskId, key, env, timeoutMs, ctx) {
  const deadline = Date.now() + timeoutMs;
  const taskUrl = `${baseUrl(env)}/tasks/${encodeURIComponent(taskId)}`;
  const intervalMs = pollIntervalMs(3000);
  let lastStatus = "";
  while (Date.now() < deadline) {
    const data = await requestJson(taskUrl, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
    const status = extractStatus(data);
    if (status && status !== lastStatus) {
      ctx.logProgress(ctx.msg(`任务状态：${status}`, `Task status: ${status}`));
      lastStatus = status;
    }
    if (status === "SUCCEEDED" || status === "SUCCESS") return data;
    if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
      throw new Error(data?.output?.message || data?.message || ctx.msg(`任务失败：${status}`, `Task failed: ${status}`));
    }
    await sleep(intervalMs);
  }
  throw new Error(ctx.msg(`图片生成超时，task_id=${taskId}`, `Image generation timed out, task_id=${taskId}`));
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
    const model = input.model || env.DASHSCOPE_IMAGE_MODEL || "qwen-image-2.0-pro";
    const payload = {
      model,
      input: { messages: [{ role: "user", content: [{ text: input.prompt }] }] },
      parameters: {
        negative_prompt: input.negative_prompt || " ",
        size: input.size || "2048*2048",
        n: Number(input.n || 1),
        prompt_extend: input.prompt_extend !== false,
        watermark: input.watermark === true,
      },
    };

    ctx.logProgress(ctx.msg("正在提交图片生成任务...", "Submitting image generation task..."));
    const create = await requestJson(createUrl(env), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const taskId = extractTaskId(create);
    if (taskId) ctx.logProgress(ctx.msg(`任务已提交：${taskId}`, `Task submitted: ${taskId}`));
    const result = taskId ? await pollTask(taskId, key, env, Number(input.timeout_ms || 240_000), ctx) : create;
    const urls = collectImageUrls(result);
    if (!urls.length) {
      throw new Error(
        `${ctx.msg("图片任务完成，但没有找到图片 URL。", "Image task finished but no image URL was returned.")}\n${JSON.stringify(result, null, 2)}`,
      );
    }
    return { taskId, urls };
  },
};
