#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const CREATE_PATH = "/services/aigc/video-generation/video-synthesis";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

function fail(message, detail) {
  const suffix = detail ? `\n${detail}` : "";
  process.stderr.write(`[lily-video-generation] ${message}${suffix}\n`);
  process.exit(1);
}

function jsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    fail("stdin 必须是 JSON。", error.message);
  }
}

function apiKey() {
  return process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_BAILIAN_API_KEY || "";
}

function baseUrl() {
  return (process.env.DASHSCOPE_VIDEO_BASE_URL || process.env.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function createUrl() {
  return process.env.DASHSCOPE_VIDEO_ENDPOINT || `${baseUrl()}${CREATE_PATH}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.message || data?.code || text || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
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

async function pollTask(taskId, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const taskUrl = `${baseUrl()}/tasks/${encodeURIComponent(taskId)}`;
  const pollIntervalMs = Math.max(50, Number(process.env.LILY_MEDIA_POLL_INTERVAL_MS || 5000));
  while (Date.now() < deadline) {
    const data = await requestJson(taskUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    const status = extractStatus(data);
    if (status === "SUCCEEDED" || status === "SUCCESS") return data;
    if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
      throw new Error(data?.output?.message || data?.message || `任务失败：${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`视频生成超时，task_id=${taskId}`);
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`下载失败：${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, bytes);
  return bytes.length;
}

function safeName(prefix, ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${ts}-${rand}.${ext}`;
}

async function main() {
  const input = jsonParse(await readStdin());
  const prompt = String(input.prompt || "").trim();
  if (!prompt) fail("缺少 prompt。");
  const key = apiKey();
  if (!key) fail("缺少 DASHSCOPE_API_KEY。请在模型配置或环境变量中配置百炼 API Key。");

  const media = Array.isArray(input.media) ? input.media.filter((item) => item && item.type && item.url) : [];
  const model = input.model || process.env.DASHSCOPE_VIDEO_MODEL || (media.length ? "wan2.7-i2v-2026-04-25" : "wan2.7-t2v");
  const outputDir = path.resolve(process.cwd(), input.output_dir || "generated-assets");
  fs.mkdirSync(outputDir, { recursive: true });

  const payload = {
    model,
    input: {
      prompt,
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

  const create = await requestJson(createUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(payload),
  });
  const taskId = extractTaskId(create);
  if (!taskId) fail("百炼未返回 task_id。", JSON.stringify(create, null, 2));

  const result = await pollTask(taskId, key, Number(input.timeout_ms || 900_000));
  const urls = collectVideoUrls(result);
  if (!urls.length) fail("视频任务完成，但没有找到视频 URL。", JSON.stringify(result, null, 2));

  const files = [];
  for (let i = 0; i < urls.length; i += 1) {
    const filePath = path.join(outputDir, safeName(`video-${i + 1}`, "mp4"));
    const bytes = await downloadFile(urls[i], filePath);
    files.push({ path: filePath, bytes });
  }

  process.stdout.write("<generated_media type=\"video\">\n");
  process.stdout.write(`  <task_id>${taskId}</task_id>\n`);
  for (const file of files) {
    process.stdout.write(`  <file path="${file.path}" bytes="${file.bytes}" />\n`);
  }
  process.stdout.write("</generated_media>\n");
}

main().catch((error) => fail("视频生成失败。", error?.message || String(error)));
