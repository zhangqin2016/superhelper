#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

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

function envValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function localFilePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^file:/i.test(raw)) return fileURLToPath(raw);
  if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
  return "";
}

function downloadHeaders(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return {};
  }
  const key = envValue("LILY_MEDIA_API_KEY", "LILY_GPU_API_KEY");
  if (key && /^https?:$/.test(parsed.protocol) && /\/llm\/media\/lily\//.test(parsed.pathname)) {
    return { Authorization: `Bearer ${key}` };
  }
  return {};
}

async function downloadFile(url, outputPath) {
  const localPath = localFilePath(url);
  if (localPath) {
    fs.copyFileSync(localPath, outputPath);
    return fs.statSync(outputPath).size;
  }
  const response = await fetch(url, { headers: downloadHeaders(url), signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(msg(`下载失败：${response.status} ${response.statusText}`, `Download failed: ${response.status} ${response.statusText}`));
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, bytes);
  return bytes.length;
}

function inferProviderFromEnv(env) {
  if (env.LILY_MEDIA_VIDEO_ENDPOINT || env.LILY_MEDIA_VIDEO_BASE_URL || env.LILY_MEDIA_BASE_URL || env.LILY_GPU_VIDEO_ENDPOINT || env.LILY_GPU_VIDEO_BASE_URL || env.LILY_GPU_BASE_URL) return "lily";
  if (env.DASHSCOPE_API_KEY || env.ALIYUN_BAILIAN_API_KEY || env.DASHSCOPE_VIDEO_ENDPOINT || env.DASHSCOPE_VIDEO_BASE_URL) return "dashscope";
  if (env.VOLCENGINE_API_KEY || env.ARK_API_KEY) return "volcengine";
  if (env.KLING_API_KEY || (env.KLING_ACCESS_KEY && env.KLING_SECRET_KEY)) return "kling";
  if (env.MINIMAX_API_KEY) return "minimax";
  if (env.ZHIPU_API_KEY || env.BIGMODEL_API_KEY) return "zhipu";
  return "";
}

function selectProvider(input) {
  const id = String(input.provider || process.env.LILY_VIDEO_PROVIDER || inferProviderFromEnv(process.env)).toLowerCase();
  if (!id) {
    fail(
      msg(
        "没有配置视频生成 provider。请先在设置中选择可用服务商，或在 JSON 中显式传入 provider 并配置对应 Key。",
        "No video generation provider is configured. Choose an available provider in Settings, or pass provider explicitly in JSON with the matching key configured.",
      ),
    );
  }
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
  const providerId = adapter.id || String(input.provider || process.env.LILY_VIDEO_PROVIDER || inferProviderFromEnv(process.env)).toLowerCase();
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
  writeResultRecord(outputDir, { type: "video", provider: providerId, taskId, content: xml });
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
