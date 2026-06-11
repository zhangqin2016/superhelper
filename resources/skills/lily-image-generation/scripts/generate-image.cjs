#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const CREATE_PATH = "/services/aigc/multimodal-generation/generation";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

const ZH = String(process.env.LILY_LOCALE || "").toLowerCase().startsWith("zh");
function msg(zh, en) { return ZH ? zh : en; }

function fail(message, detail) {
  const suffix = detail ? `\n${detail}` : "";
  process.stderr.write(`[lily-image-generation] ${message}${suffix}\n`);
  process.exit(1);
}

function logProgress(message) {
  process.stderr.write(`[lily-image-generation] ${message}\n`);
}

function jsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    fail(msg("stdin 必须是 JSON。", "stdin must be JSON."), error.message);
  }
}

function apiKey() {
  return process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_BAILIAN_API_KEY || "";
}

function baseUrl() {
  return (process.env.DASHSCOPE_IMAGE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function createUrl() {
  return process.env.DASHSCOPE_IMAGE_ENDPOINT || `${baseUrl()}${CREATE_PATH}`;
}

function safeName(prefix, ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${ts}-${rand}.${ext}`;
}

function xmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

async function pollTask(taskId, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const taskUrl = `${baseUrl()}/tasks/${encodeURIComponent(taskId)}`;
  const pollIntervalMs = Math.max(50, Number(process.env.LILY_MEDIA_POLL_INTERVAL_MS || 3000));
  let lastStatus = "";
  while (Date.now() < deadline) {
    const data = await requestJson(taskUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    const status = extractStatus(data);
    if (status && status !== lastStatus) {
      logProgress(msg(`任务状态：${status}`, `Task status: ${status}`));
      lastStatus = status;
    }
    if (status === "SUCCEEDED" || status === "SUCCESS") return data;
    if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
      throw new Error(data?.output?.message || data?.message || msg(`任务失败：${status}`, `Task failed: ${status}`));
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(msg(`图片生成超时，task_id=${taskId}`, `Image generation timed out, task_id=${taskId}`));
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(msg(`下载失败：${response.status} ${response.statusText}`, `Download failed: ${response.status} ${response.statusText}`));
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, bytes);
  return bytes.length;
}

function detectExt(url) {
  const clean = String(url).split("?")[0].toLowerCase();
  const match = clean.match(/\.([a-z0-9]+)$/);
  if (match && ["png", "jpg", "jpeg", "webp", "bmp"].includes(match[1])) return match[1] === "jpeg" ? "jpg" : match[1];
  return "png";
}

async function main() {
  const input = jsonParse(await readStdin());
  const prompt = String(input.prompt || "").trim();
  if (!prompt) fail(msg("缺少 prompt。", "Missing prompt."));
  const key = apiKey();
  if (!key) fail(msg("缺少 DASHSCOPE_API_KEY。请在模型配置或环境变量中配置百炼 API Key。", "Missing DASHSCOPE_API_KEY. Configure the DashScope API key in model settings or environment variables."));

  const model = input.model || process.env.DASHSCOPE_IMAGE_MODEL || "qwen-image-2.0-pro";
  const outputDir = path.resolve(process.cwd(), input.output_dir || "generated-assets");
  fs.mkdirSync(outputDir, { recursive: true });

  const payload = {
    model,
    input: {
      messages: [
        {
          role: "user",
          content: [{ text: prompt }],
        },
      ],
    },
    parameters: {
      negative_prompt: input.negative_prompt || " ",
      size: input.size || "2048*2048",
      n: Number(input.n || 1),
      prompt_extend: input.prompt_extend !== false,
      watermark: input.watermark === true,
    },
  };

  logProgress(msg("正在提交图片生成任务...", "Submitting image generation task..."));
  const create = await requestJson(createUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const taskId = extractTaskId(create);
  if (taskId) logProgress(msg(`任务已提交：${taskId}`, `Task submitted: ${taskId}`));
  const result = taskId ? await pollTask(taskId, key, Number(input.timeout_ms || 240_000)) : create;
  const urls = collectImageUrls(result);
  if (!urls.length) fail(msg("图片任务完成，但没有找到图片 URL。", "Image task finished but no image URL was returned."), JSON.stringify(result, null, 2));

  const files = [];
  for (let i = 0; i < urls.length; i += 1) {
    const ext = detectExt(urls[i]);
    const filePath = path.join(outputDir, safeName(`image-${i + 1}`, ext));
    logProgress(msg(`正在下载生成图片 ${i + 1}/${urls.length}...`, `Downloading image ${i + 1}/${urls.length}...`));
    const bytes = await downloadFile(urls[i], filePath);
    files.push({ path: filePath, bytes });
  }

  process.stdout.write("<generated_media type=\"image\">\n");
  if (taskId) process.stdout.write(`  <task_id>${xmlEscape(taskId)}</task_id>\n`);
  for (const file of files) {
    process.stdout.write(`  <file path="${xmlEscape(file.path)}" bytes="${file.bytes}" />\n`);
  }
  process.stdout.write("</generated_media>\n");
  for (const file of files) {
    process.stdout.write(msg(`\n![生成图片](${file.path})\n已保存到：${file.path}\n`, `\n![Generated image](${file.path})\nSaved to: ${file.path}\n`));
  }
}

main().catch((error) => fail(msg("图片生成失败。", "Image generation failed."), error?.message || String(error)));
