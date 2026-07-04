#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Provider-dispatch shell. The DashScope flow (default) is unchanged; other
// providers (volcengine, ...) are pluggable adapters under ./providers. Each
// adapter owns its API shape and returns { urls?, buffers? }; this shell handles
// stdin, provider selection, downloading/persisting, and the XML output.
const ADAPTERS = {
  dashscope: require("./providers/dashscope.cjs"),
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

function selectProvider(input) {
  const id = String(input.provider || process.env.LILY_IMAGE_PROVIDER || "dashscope").toLowerCase();
  const adapter = ADAPTERS[id];
  if (!adapter) {
    fail(msg(`不支持的图片 provider：${id}`, `Unsupported image provider: ${id}`), `available: ${Object.keys(ADAPTERS).join(", ")}`);
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
    fail(msg("图片生成失败。", "Image generation failed."), error?.message || String(error));
  }

  const { taskId = "", urls = [], buffers = [] } = result || {};
  const files = [];
  for (let i = 0; i < urls.length; i += 1) {
    const ext = detectExt(urls[i]);
    const filePath = path.join(outputDir, safeName(`image-${i + 1}`, ext));
    logProgress(msg(`正在下载生成图片 ${i + 1}/${urls.length}...`, `Downloading image ${i + 1}/${urls.length}...`));
    const bytes = await downloadFile(urls[i], filePath);
    files.push({ path: filePath, bytes });
  }
  for (let i = 0; i < buffers.length; i += 1) {
    const filePath = path.join(outputDir, safeName(`image-${urls.length + i + 1}`, buffers[i].ext || "png"));
    fs.writeFileSync(filePath, buffers[i].data);
    files.push({ path: filePath, bytes: buffers[i].data.length });
  }
  if (!files.length) fail(msg("图片任务完成，但没有产物。", "Image task finished but produced no files."));

  let xml = "<generated_media type=\"image\">\n";
  if (taskId) xml += `  <task_id>${xmlEscape(taskId)}</task_id>\n`;
  for (const file of files) {
    xml += `  <file path="${xmlEscape(file.path)}" bytes="${file.bytes}" />\n`;
  }
  xml += "</generated_media>\n";
  process.stdout.write(xml);
  // Result record for the main-process media tracker — surfaces the media even if the
  // turn was torn down before this stdout was captured. Best-effort.
  try {
    const dir = path.join(outputDir, ".lily-results");
    fs.mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ type: "image", provider: input.provider || process.env.LILY_IMAGE_PROVIDER || "dashscope", taskId, content: xml, createdAt: Date.now() }), "utf8");
  } catch { /* best effort */ }
}

main().catch((error) => fail(msg("图片生成失败。", "Image generation failed."), error?.message || String(error)));
