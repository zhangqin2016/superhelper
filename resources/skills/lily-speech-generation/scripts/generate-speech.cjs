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

function envValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function lilySpeechUrl() {
  const explicit = envValue("LILY_MEDIA_SPEECH_ENDPOINT", "LILY_MEDIA_TTS_ENDPOINT", "LILY_GPU_SPEECH_ENDPOINT", "LILY_GPU_TTS_ENDPOINT");
  if (explicit) return explicit;
  const specificBase = envValue("LILY_MEDIA_SPEECH_BASE_URL", "LILY_MEDIA_TTS_BASE_URL", "LILY_GPU_SPEECH_BASE_URL", "LILY_GPU_TTS_BASE_URL");
  if (specificBase) return `${specificBase.replace(/\/+$/, "")}/generate`;
  const base = envValue("LILY_MEDIA_BASE_URL", "LILY_GPU_BASE_URL");
  if (base) return `${base.replace(/\/+$/, "")}/speech/generate`;
  return "";
}

function lilyAuthHeaders() {
  const key = envValue("LILY_MEDIA_API_KEY", "LILY_GPU_API_KEY");
  return key ? { Authorization: `Bearer ${key}` } : {};
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
    const raw = await response.text();
    let data = {};
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch (error) {
        throw new Error(`${response.status} ${response.statusText} from ${url}: invalid JSON response (${error.message})`);
      }
    }
    if (!response.ok) {
      throw new Error(data?.message || data?.code || `${response.status} ${response.statusText} from ${url}`);
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

function collectAudioBuffers(data) {
  const buffers = [];
  const candidates = [
    data?.audio_base64,
    data?.b64_json,
    data?.base64,
    data?.data_base64,
    data?.output?.audio_base64,
    data?.output?.audio?.audio_base64,
    data?.output?.audio?.base64,
    data?.data?.audio_base64,
  ].filter((value) => typeof value === "string");
  for (const raw of candidates) {
    const match = raw.match(/^data:audio\/([a-z0-9+.-]+);base64,(.+)$/i);
    const ext = match ? match[1].replace("mpeg", "mp3") : "wav";
    const body = match ? match[2] : raw;
    try {
      const bytes = Buffer.from(body, "base64");
      if (bytes.length) buffers.push({ ext, data: bytes });
    } catch {
      // Ignore malformed base64; caller fails if no usable output remains.
    }
  }
  for (const list of [data?.audios, data?.output?.audios, data?.data].filter(Array.isArray)) {
    for (const value of list) {
      if (!value || typeof value !== "object") continue;
      for (const key of ["audio_base64", "b64_json", "base64", "data_base64"]) {
        if (typeof value[key] !== "string") continue;
        const raw = value[key];
        const match = raw.match(/^data:audio\/([a-z0-9+.-]+);base64,(.+)$/i);
        const ext = match ? match[1].replace("mpeg", "mp3") : "wav";
        const body = match ? match[2] : raw;
        try {
          const data = Buffer.from(body, "base64");
          if (data.length) buffers.push({ ext, data });
        } catch {
          // Ignore malformed base64; caller fails if nothing usable remains.
        }
      }
    }
  }
  return buffers;
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(msg(`下载失败：${response.status} ${response.statusText}`, `Download failed: ${response.status} ${response.statusText}`));
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, bytes);
  return bytes.length;
}

function writeGeneratedSpeech(files) {
  process.stdout.write("<generated_media type=\"speech\">\n");
  for (const file of files) {
    process.stdout.write(`  <file path="${file.path}" bytes="${file.bytes}" />\n`);
  }
  process.stdout.write("</generated_media>\n");
}

async function runLilySpeech(input, text, format, outputDir) {
  const url = lilySpeechUrl();
  if (!url) {
    fail("缺少 LILY_MEDIA_SPEECH_ENDPOINT 或 LILY_MEDIA_SPEECH_BASE_URL。", "Missing LILY_MEDIA_SPEECH_ENDPOINT or LILY_MEDIA_SPEECH_BASE_URL.");
  }
  const payload = {
    text,
    input: text,
    voice: input.voice || process.env.LILY_MEDIA_TTS_VOICE || process.env.LILY_GPU_TTS_VOICE || "default",
    format,
    sample_rate: Number(input.sample_rate || 24000),
    model: input.model || process.env.LILY_MEDIA_TTS_MODEL || process.env.LILY_GPU_TTS_MODEL || "qwen3-tts",
  };
  const result = await requestJsonOrBinary(url, {
    method: "POST",
    headers: { ...lilyAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const files = [];
  if (result.bytes) {
    const filePath = path.join(outputDir, safeName("speech", format));
    fs.writeFileSync(filePath, result.bytes);
    files.push({ path: filePath, bytes: result.bytes.length });
  } else {
    const buffers = collectAudioBuffers(result.json);
    for (let i = 0; i < buffers.length; i += 1) {
      const filePath = path.join(outputDir, safeName(`speech-${i + 1}`, buffers[i].ext || format));
      fs.writeFileSync(filePath, buffers[i].data);
      files.push({ path: filePath, bytes: buffers[i].data.length });
    }
    const urls = collectAudioUrls(result.json);
    for (let i = 0; i < urls.length; i += 1) {
      const filePath = path.join(outputDir, safeName(`speech-${buffers.length + i + 1}`, format));
      const bytes = await downloadFile(urls[i], filePath);
      files.push({ path: filePath, bytes });
    }
  }
  if (!files.length) fail("Lily GPU 语音生成完成，但没有找到音频 URL 或音频数据。", JSON.stringify(result.json || {}, null, 2));
  writeGeneratedSpeech(files);
}

async function main() {
  const input = jsonParse(await readStdin());
  const text = String(input.text || input.input || "").trim();
  if (!text) fail(msg("缺少 text。", "Missing text."));
  const provider = String(input.provider || process.env.LILY_SPEECH_PROVIDER || "dashscope").toLowerCase();
  if (provider !== "dashscope" && provider !== "lily") {
    fail(msg(`不支持的语音 provider：${provider}`, `Unsupported speech provider: ${provider}`), "available: dashscope, lily");
  }
  const format = String(input.format || "wav").replace(/[^a-z0-9]/gi, "").toLowerCase() || "wav";
  const outputDir = path.resolve(process.cwd(), input.output_dir || "generated-assets");
  fs.mkdirSync(outputDir, { recursive: true });
  if (provider === "lily") {
    await runLilySpeech(input, text, format, outputDir);
    return;
  }
  const key = apiKey();
  if (!key) fail(msg("缺少 DASHSCOPE_API_KEY。请在模型配置或环境变量中配置百炼 API Key。", "Missing DASHSCOPE_API_KEY. Configure the DashScope API key in model settings or environment variables."));

  const model = input.model || process.env.DASHSCOPE_TTS_MODEL || "cosyvoice-v3-flash";
  const voice = input.voice || process.env.DASHSCOPE_TTS_VOICE || "longanyang";

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

  writeGeneratedSpeech(files);
}

main().catch((error) => fail(msg("语音生成失败。", "Speech generation failed."), error?.message || String(error)));
