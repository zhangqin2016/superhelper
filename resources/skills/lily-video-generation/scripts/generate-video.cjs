#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Provider-dispatch shell. The DashScope flow (default) is unchanged; other
// providers (volcengine, ...) are pluggable adapters under ./providers. Each
// adapter owns its API shape and returns { taskId?, urls }; this shell handles
// stdin, provider selection, downloading, and the XML output.
const ADAPTERS = {
  dashscope: require("./providers/dashscope.cjs"),
  lily: require("./providers/lily.cjs"),
  volcengine: require("./providers/volcengine.cjs"),
  kling: require("./providers/kling.cjs"),
  minimax: require("./providers/minimax.cjs"),
  zhipu: require("./providers/zhipu.cjs"),
};

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
  process.stderr.write(`[lily-video-generation] ${message}${suffix}\n`);
  process.exit(1);
}

function logProgress(message) {
  process.stderr.write(`[lily-video-generation] ${message}\n`);
}

function jsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    fail(msg("stdin 必须是 JSON。", "stdin must be JSON."), error.message);
  }
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

async function downloadFile(url, outputPath) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(msg(`下载失败：${response.status} ${response.statusText}`, `Download failed: ${response.status} ${response.statusText}`));
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, bytes);
  return bytes.length;
}

function selectProvider(input) {
  const id = String(input.provider || process.env.LILY_VIDEO_PROVIDER || "dashscope").toLowerCase();
  const adapter = ADAPTERS[id];
  if (!adapter) {
    fail(msg(`不支持的视频 provider：${id}`, `Unsupported video provider: ${id}`), `available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}

async function main() {
  const input = jsonParse(await readStdin());
  const prompt = String(input.prompt || "").trim();
  if (!prompt) fail(msg("缺少 prompt。", "Missing prompt."));
  input.prompt = prompt;

  const adapter = selectProvider(input);
  const outputDir = path.resolve(process.cwd(), input.output_dir || "generated-assets");
  fs.mkdirSync(outputDir, { recursive: true });

  let result;
  try {
    result = await adapter.generate(input, { env: process.env, logProgress, msg });
  } catch (error) {
    fail(msg("视频生成失败。", "Video generation failed."), error?.message || String(error));
  }

  const { taskId = "", urls = [], buffers = [] } = result || {};
  if (!urls.length && !buffers.length) fail(msg("视频任务完成，但没有产物。", "Video task finished but produced no files."));

  const files = [];
  for (let i = 0; i < urls.length; i += 1) {
    const filePath = path.join(outputDir, safeName(`video-${i + 1}`, "mp4"));
    const bytes = await downloadFile(urls[i], filePath);
    files.push({ path: filePath, bytes });
  }
  for (let i = 0; i < buffers.length; i += 1) {
    const filePath = path.join(outputDir, safeName(`video-${urls.length + i + 1}`, buffers[i].ext || "mp4"));
    fs.writeFileSync(filePath, buffers[i].data);
    files.push({ path: filePath, bytes: buffers[i].data.length });
  }

  let xml = "<generated_media type=\"video\">\n";
  if (taskId) xml += `  <task_id>${xmlEscape(taskId)}</task_id>\n`;
  for (const file of files) {
    xml += `  <file path="${xmlEscape(file.path)}" bytes="${file.bytes}" />\n`;
  }
  xml += "</generated_media>\n";
  process.stdout.write(xml);
  // Drop a result record so the workbench can surface the media even if the turn was
  // already torn down (watchdog/interrupt) before this stdout was captured. The
  // main-process media tracker scans these and injects the result into the session.
  writeResultRecord(outputDir, { type: "video", provider: input.provider || process.env.LILY_VIDEO_PROVIDER || "dashscope", taskId, content: xml });
}

function writeResultRecord(outputDir, record) {
  try {
    const dir = path.join(outputDir, ".lily-results");
    fs.mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...record, createdAt: Date.now() }), "utf8");
  } catch { /* best effort — stdout path still works when the turn is alive */ }
}

main().catch((error) => fail(msg("视频生成失败。", "Video generation failed."), error?.message || String(error)));
