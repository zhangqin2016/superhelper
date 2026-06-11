#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const CREATE_PATH = "/services/audio/tts/SpeechSynthesizer";

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
  process.stderr.write(`[lily-speech-generation] ${message}${suffix}\n`);
  process.exit(1);
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
  return (process.env.DASHSCOPE_TTS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function createUrl() {
  return process.env.DASHSCOPE_TTS_ENDPOINT || `${baseUrl()}${CREATE_PATH}`;
}

function safeName(prefix, ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${ts}-${rand}.${ext}`;
}

async function requestJsonOrBinary(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.message || data?.code || `${response.status} ${response.statusText}`);
    }
    return { json: data };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(bytes.toString("utf8") || `${response.status} ${response.statusText}`);
  return { bytes };
}

function collectAudioUrls(data) {
  const output = data?.output || data || {};
  const urls = [];
  for (const key of ["audio_url", "url", "result_url"]) {
    if (output[key]) urls.push(output[key]);
    if (output.audio?.[key]) urls.push(output.audio[key]);
  }
  const lists = [output.results, output.audios, data?.data];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = item?.audio_url || item?.url || item?.result_url;
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(msg(`下载失败：${response.status} ${response.statusText}`, `Download failed: ${response.status} ${response.statusText}`));
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, bytes);
  return bytes.length;
}

async function main() {
  const input = jsonParse(await readStdin());
  const text = String(input.text || input.input || "").trim();
  if (!text) fail(msg("缺少 text。", "Missing text."));
  const key = apiKey();
  if (!key) fail(msg("缺少 DASHSCOPE_API_KEY。请在模型配置或环境变量中配置百炼 API Key。", "Missing DASHSCOPE_API_KEY. Configure the DashScope API key in model settings or environment variables."));

  const model = input.model || process.env.DASHSCOPE_TTS_MODEL || "cosyvoice-v3-flash";
  const voice = input.voice || process.env.DASHSCOPE_TTS_VOICE || "longanyang";
  const format = String(input.format || "wav").replace(/[^a-z0-9]/gi, "").toLowerCase() || "wav";
  const outputDir = path.resolve(process.cwd(), input.output_dir || "generated-assets");
  fs.mkdirSync(outputDir, { recursive: true });

  const payload = {
    model,
    input: {
      text,
      voice,
      format,
      sample_rate: Number(input.sample_rate || 24000),
    },
  };

  const result = await requestJsonOrBinary(createUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const files = [];
  if (result.bytes) {
    const filePath = path.join(outputDir, safeName("speech", format));
    fs.writeFileSync(filePath, result.bytes);
    files.push({ path: filePath, bytes: result.bytes.length });
  } else {
    const urls = collectAudioUrls(result.json);
    if (!urls.length) fail(msg("语音合成完成，但没有找到音频 URL。", "Speech synthesis finished but no audio URL was returned."), JSON.stringify(result.json, null, 2));
    for (let i = 0; i < urls.length; i += 1) {
      const filePath = path.join(outputDir, safeName(`speech-${i + 1}`, format));
      const bytes = await downloadFile(urls[i], filePath);
      files.push({ path: filePath, bytes });
    }
  }

  process.stdout.write("<generated_media type=\"speech\">\n");
  for (const file of files) {
    process.stdout.write(`  <file path="${file.path}" bytes="${file.bytes}" />\n`);
  }
  process.stdout.write("</generated_media>\n");
}

main().catch((error) => fail(msg("语音生成失败。", "Speech generation failed."), error?.message || String(error)));
