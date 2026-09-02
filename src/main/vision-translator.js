"use strict";

/**
 * Vision translation — enriches image files with task-aware text evidence via DashScope.
 * The send pipeline sends this structured evidence to the main model. Original images
 * stay visible in the chat transcript, but are not forwarded by default because many
 * many model gateways do not support image content blocks.
 *
 * Keys live in agent settings.json (bundled or userData), not only process.env.
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const { resolveSettingsEnvValue } = require("./agent-settings");
const { bridgeConcurrency, bridgeImagesConcurrently } = require("./vision-bridge-runner");
const { withLiveFilePath } = require("./live-file-source");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-vl-max";
// qwen-vl inference on a full-size screenshot routinely takes >15s; 15s timed
// out mid-recognition and the image was silently dropped. 60s leaves headroom;
// override with VISION_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_EDGE = 1800;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_JPEG_QUALITY = 88;

const MIME_MAP = {
  jpg: "jpeg", jpeg: "jpeg", png: "png",
  gif: "gif", webp: "webp", bmp: "bmp",
};

function isVisionInputFile(file) {
  file = withLiveFilePath(file);
  if (!file?.path) return false;
  const ext = path.extname(file.path).toLowerCase().replace(/^\./, "");
  return Boolean(MIME_MAP[ext]);
}

function normalizeVisionModel(model) {
  const value = String(model || "").trim();
  if (!value) return DEFAULT_MODEL;
  const legacyAliases = {
    "qwen3.7-plus": "qwen-vl-max",
    "qwen3.7-max": "qwen-vl-max",
    "qwen3.7-flash": "qwen3-vl-flash",
  };
  return legacyAliases[value.toLowerCase()] || value;
}

function getVisionConfig() {
  return {
    baseUrl: resolveSettingsEnvValue("DASHSCOPE_BASE_URL") || DEFAULT_BASE_URL,
    apiKey: resolveSettingsEnvValue("VISION_API_KEY", "DASHSCOPE_API_KEY"),
    model: normalizeVisionModel(resolveSettingsEnvValue("VISION_MODEL")),
  };
}

function hasVisionApiKey() {
  return Boolean(getVisionConfig().apiKey);
}

function getVisionTimeoutMs() {
  const raw = Number.parseInt(resolveSettingsEnvValue("VISION_TIMEOUT_MS"), 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(raw, 5000), 60000);
}

function getBoundedIntegerEnv(key, fallback, min, max) {
  const raw = Number.parseInt(resolveSettingsEnvValue(key), 10);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.max(raw, min), max);
}

function getVisionImageLimits() {
  return {
    maxEdge: getBoundedIntegerEnv("VISION_MAX_EDGE", DEFAULT_MAX_EDGE, 512, 4096),
    maxBytes: getBoundedIntegerEnv("VISION_MAX_BYTES", DEFAULT_MAX_BYTES, 256 * 1024, 12 * 1024 * 1024),
    jpegQuality: getBoundedIntegerEnv("VISION_JPEG_QUALITY", DEFAULT_JPEG_QUALITY, 60, 95),
  };
}

function toDataUrl(buffer, mime) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function optimizeWithSharp(filePath, limits) {
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    return null;
  }

  const image = sharp(filePath, { failOn: "none", animated: false }).rotate();
  const meta = await image.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  const originalSize = fs.statSync(filePath).size;
  if (!width || !height) return null;

  const shouldResize = Math.max(width, height) > limits.maxEdge;
  const shouldCompress = originalSize > limits.maxBytes;
  if (!shouldResize && !shouldCompress) return null;

  let pipeline = image;
  if (shouldResize) {
    pipeline = pipeline.resize({
      width: limits.maxEdge,
      height: limits.maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  let buffer = await pipeline
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: limits.jpegQuality, mozjpeg: true })
    .toBuffer();

  if (buffer.length > limits.maxBytes) {
    buffer = await sharp(buffer, { failOn: "none" })
      .resize({
        width: Math.floor(limits.maxEdge * 0.8),
        height: Math.floor(limits.maxEdge * 0.8),
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: Math.max(72, limits.jpegQuality - 10), mozjpeg: true })
      .toBuffer();
  }

  return {
    dataUrl: toDataUrl(buffer, "image/jpeg"),
    optimized: true,
    originalBytes: originalSize,
    optimizedBytes: buffer.length,
    width,
    height,
  };
}

async function optimizeWithNativeImage(filePath, limits) {
  let nativeImage;
  try {
    ({ nativeImage } = require("electron"));
  } catch {
    return null;
  }
  if (!nativeImage) return null;

  const originalSize = fs.statSync(filePath).size;
  const img = nativeImage.createFromPath(filePath);
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const maxOriginalEdge = Math.max(size.width || 0, size.height || 0);
  const shouldResize = maxOriginalEdge > limits.maxEdge;
  const shouldCompress = originalSize > limits.maxBytes;
  if (!shouldResize && !shouldCompress) return null;

  const scale = shouldResize ? limits.maxEdge / maxOriginalEdge : 1;
  const resized = shouldResize
    ? img.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "best",
      })
    : img;
  const buffer = resized.toJPEG(limits.jpegQuality);
  return {
    dataUrl: toDataUrl(buffer, "image/jpeg"),
    optimized: true,
    originalBytes: originalSize,
    optimizedBytes: buffer.length,
    width: size.width || 0,
    height: size.height || 0,
  };
}

async function imageToDataUrl(filePath) {
  const limits = getVisionImageLimits();
  try {
    const optimized =
      (await optimizeWithSharp(filePath, limits)) ||
      (await optimizeWithNativeImage(filePath, limits));
    if (optimized?.dataUrl) {
      if (optimized.optimizedBytes < optimized.originalBytes) {
        console.info(
          `[vision-translator] optimized ${path.basename(filePath)} ` +
          `${optimized.width}x${optimized.height} ${optimized.originalBytes}B -> ${optimized.optimizedBytes}B`,
        );
      }
      return optimized.dataUrl;
    }
  } catch (err) {
    console.warn(`[vision-translator] image optimize skipped for ${path.basename(filePath)}:`, err.message);
  }

  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mime = MIME_MAP[ext] || "jpeg";
  const data = fs.readFileSync(filePath);
  return toDataUrl(data, `image/${mime}`);
}

function includesAny(text, words) {
  const value = String(text || "").toLowerCase();
  return words.some((word) => value.includes(String(word).toLowerCase()));
}

function inferVisionMode(userText = "", files = []) {
  const fileNames = (files || []).map((f) => f?.name || path.basename(f?.path || "")).join(" ");
  const haystack = `${userText || ""} ${fileNames}`;

  if (includesAny(haystack, [
    "bug", "报错", "错误", "异常", "失败", "不能用", "卡住", "崩溃", "闪退",
    "issue", "session id", "already in use", "error",
  ])) {
    return "bug_screenshot";
  }

  if (includesAny(haystack, [
    "代码", "code", "terminal", "终端", "控制台", "console", "日志", "log",
    "stack", "trace", "exception", "命令行",
  ])) {
    return "code_screenshot";
  }

  if (includesAny(haystack, [
    "设计", "设计稿", "ui", "页面", "样式", "布局", "颜色", "间距", "figma",
    "视觉", "对齐",
  ])) {
    return "design_review";
  }

  if (includesAny(haystack, [
    "表格", "excel", "csv", "table", "单元格", "数据", "报表", "行列",
  ])) {
    return "table_or_data";
  }

  return "general";
}

function buildVisionPrompt({ userText = "", mode = "general" } = {}) {
  const question = String(userText || "").trim() || "The user uploaded an image without providing text.";
  const base = [
    "You are the visual recognition layer in an AI chat product. Your output will serve as evidence context for the subsequent main CLI model.",
    "Do not write implementation code, CSS, or full plans. Extract structured facts and let the downstream CLI model decide how to act.",
    "Do not give generic image descriptions; prioritize answering what the user actually wants to know.",
    "If you cannot see clearly, cannot determine, or can only speculate, you MUST state this explicitly under \"Uncertainties\".",
    "",
    `User question: ${question}`,
    `Inferred image type: ${mode}`,
    "",
  ];

  const sectionsByMode = {
    bug_screenshot: [
      "Please output using the following structure:",
      "[Image Recognition Result]",
      "Type:",
      "Conclusion related to user question:",
      "Visible text / OCR:",
      "Key errors / exceptions:",
      "Possible trigger flow:",
      "UI / layout clues:",
      "Keywords useful for code search:",
      "Suggested priority areas to check:",
      "Uncertainties:",
    ],
    code_screenshot: [
      "Please output using the following structure:",
      "[Image Recognition Result]",
      "Type:",
      "Conclusion related to user question:",
      "Visible text / OCR:",
      "Code / command / log snippets:",
      "Key errors / exceptions:",
      "Keywords useful for code search:",
      "Uncertainties:",
    ],
    design_review: [
      "Return JSON only. Do not wrap it in Markdown fences.",
      "Use this exact schema:",
      "{",
      "  \"schema_version\": 1,",
      "  \"mode\": \"ui_screenshot\",",
      "  \"page_type\": \"\",",
      "  \"answer_to_user_question\": \"\",",
      "  \"layout\": {",
      "    \"structure\": [],",
      "    \"main_problem\": \"\"",
      "  },",
      "  \"components\": [",
      "    {",
      "      \"type\": \"\",",
      "      \"text\": \"\",",
      "      \"position\": \"\",",
      "      \"state\": \"\",",
      "      \"problem\": \"\",",
      "      \"evidence\": \"\"",
      "    }",
      "  ],",
      "  \"issues\": [",
      "    {",
      "      \"level\": \"high|medium|low\",",
      "      \"problem\": \"\",",
      "      \"suggestion\": \"\",",
      "      \"evidence\": \"\"",
      "    }",
      "  ],",
      "  \"visible_text\": [],",
      "  \"keywords_for_code_search\": [],",
      "  \"uncertainties\": []",
      "}",
      "Only include problems visible in the image. If no issue is visible, return an empty issues array.",
    ],
    table_or_data: [
      "Please output using the following structure:",
      "[Image Recognition Result]",
      "Type:",
      "Conclusion related to user question:",
      "Visible text / OCR:",
      "Table structure:",
      "Key values / fields:",
      "Anomalous data:",
      "Uncertainties:",
    ],
    general: [
      "Please output using the following structure:",
      "[Image Recognition Result]",
      "Type:",
      "Conclusion related to user question:",
      "Visible text / OCR:",
      "Key objects / regions:",
      "UI / layout clues:",
      "Keywords useful for further analysis:",
      "Uncertainties:",
    ],
  };

  return base.concat(sectionsByMode[mode] || sectionsByMode.general).join("\n");
}

// OpenAI-compatible vision providers are inconsistent here: some return a
// string, while others return an array of content parts. Only text parts are
// useful to the downstream model; an image-only or malformed response must be
// treated as a failed recognition instead of a successful empty result.
function normalizeVisionContent(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part.trim();
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text.trim();
        if (part.content !== undefined) return normalizeVisionContent(part.content);
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    if (content.text !== undefined) return normalizeVisionContent(content.text);
    if (content.content !== undefined) return normalizeVisionContent(content.content);
  }
  return "";
}

function callVisionApi(config, payload) {
  const url = new URL(`${config.baseUrl.replace(/\/?$/, "/")}chat/completions`);
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Vision API ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try {
          const parsed = JSON.parse(data);
          const content = normalizeVisionContent(parsed?.choices?.[0]?.message?.content);
          if (!content) {
            return reject(new Error("Vision API returned no readable image content"));
          }
          resolve(content);
        } catch (err) {
          if (err?.message === "Vision API returned no readable image content") {
            return reject(err);
          }
          reject(new Error("Vision API returned an invalid response"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(getVisionTimeoutMs(), () => {
      req.destroy();
      reject(new Error("Vision API timeout"));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Translate a single image to a text description.
 * @param {string} filePath  Absolute path to the image file.
 * @param {string} [prompt]  Custom prompt for the vision model.
 * @returns {Promise<string>} Text description.
 */
async function translateImage(filePath, prompt) {
  const config = getVisionConfig();
  if (!config.apiKey) {
    throw new Error("VISION_API_KEY or DASHSCOPE_API_KEY not configured");
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Image file not found: ${filePath}`);
  }
  const imageUrl = await imageToDataUrl(filePath);
  const question = prompt || "Please describe the content of this image in detail.";
  return callVisionApi(config, {
    model: config.model,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: imageUrl } },
        { type: "text", text: question },
      ],
    }],
    stream: false,
    max_tokens: 2048,
  });
}

/**
 * Translate all images in a files array to a combined text description.
 * @param {Array<{path?: string, name?: string, isImage?: boolean}>} files
 * @returns {Promise<{ ok: true, text: string, mode: string, keepOriginal: boolean, sourceCount: number, recognizedCount: number, failedCount: number } | { ok: false, reason: string, detail?: string } | null>}
 */
async function translateImages(files, options = {}) {
  const candidates = (files || [])
    .map((file) => withLiveFilePath(file))
    .filter((f) => isVisionInputFile(f));
  if (candidates.length === 0) return null;

  const imageFiles = candidates.filter((file) => {
    try {
      return fs.statSync(file.path).isFile();
    } catch {
      return false;
    }
  });
  if (imageFiles.length === 0) return null;

  const config = getVisionConfig();
  if (!config.apiKey) {
    return { ok: false, reason: "NO_KEY" };
  }

  const results = [];
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const failedFiles = candidates.filter((file) => !imageFiles.includes(file));
  const failureDetails = [];
  let failed = failedFiles.length;
  let recognized = 0;
  for (const f of failedFiles) {
    results.push(`[Image: ${f.name || path.basename(f.path)}]`);
  }
  const mode = options.mode || inferVisionMode(options.userText, imageFiles);
  const prompt = buildVisionPrompt({ userText: options.userText, mode });
  const bridged = await bridgeImagesConcurrently(imageFiles, {
    translate: (file) => translateImage(file.path, prompt),
    onProgress,
    isReadable: normalizeVisionContent,
    concurrency: bridgeConcurrency(resolveSettingsEnvValue("VISION_CONCURRENCY")),
  });
  for (const slot of bridged) {
    results.push(slot.text);
    if (slot.ok) {
      recognized += 1;
      continue;
    }
    failed += 1;
    failedFiles.push(slot.file);
    failureDetails.push(slot.detail);
  }

  if (recognized === 0) {
    return {
      ok: false,
      reason: "API_FAILED",
      detail: [
        "Image recognition service is temporarily unavailable.",
        failureDetails[0] ? `Cause: ${failureDetails[0]}.` : "",
        "Please try again later.",
      ].filter(Boolean).join(" "),
      failedFiles,
    };
  }

  return {
    ok: true,
    text: results.join("\n\n"),
    mode,
    // Never discard an image that the bridge failed to read. This keeps a
    // native-vision retry or local file-intelligence fallback possible.
    keepOriginal: failed > 0,
    sourceCount: candidates.length,
    recognizedCount: recognized,
    failedCount: failed,
    failedFiles,
  };
}

function hasVisionInputFiles(files) {
  return (files || []).some((f) => isVisionInputFile(f));
}

function isImageOnlyUserMessage(text, files) {
  return !String(text || "").trim() && hasVisionInputFiles(files);
}

function buildEnrichedUserText(userText, visionText) {
  return require("./engine-message-layers").appendExtractedContext(
    userText,
    visionText,
    "Image recognition result",
  );
}

module.exports = {
  buildEnrichedUserText,
  buildVisionPrompt,
  getVisionConfig,
  getVisionImageLimits,
  getVisionTimeoutMs,
  hasVisionApiKey,
  hasVisionInputFiles,
  inferVisionMode,
  imageToDataUrl,
  isImageOnlyUserMessage,
  isVisionInputFile,
  normalizeVisionContent,
  normalizeVisionModel,
  translateImage,
  translateImages,
};
