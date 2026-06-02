"use strict";

/**
 * Vision translation — enriches image files with task-aware text evidence via DashScope.
 * The send pipeline keeps the original image and adds this structured evidence when available.
 *
 * Keys live in agent settings.json (bundled or userData), not only process.env.
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const { resolveSettingsEnvValue } = require("./agent-settings");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-vl-max";
const DEFAULT_TIMEOUT_MS = 15000;

const MIME_MAP = {
  jpg: "jpeg", jpeg: "jpeg", png: "png",
  gif: "gif", webp: "webp", bmp: "bmp",
};

function getVisionConfig() {
  return {
    baseUrl: resolveSettingsEnvValue("DASHSCOPE_BASE_URL") || DEFAULT_BASE_URL,
    apiKey: resolveSettingsEnvValue("VISION_API_KEY", "DASHSCOPE_API_KEY"),
    model: resolveSettingsEnvValue("VISION_MODEL") || DEFAULT_MODEL,
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

function imageToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mime = MIME_MAP[ext] || "jpeg";
  const data = fs.readFileSync(filePath);
  return `data:image/${mime};base64,${data.toString("base64")}`;
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
    "截图", "issue", "session id", "already in use", "error",
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
  const question = String(userText || "").trim() || "用户只上传了图片，没有输入文字。";
  const base = [
    "你是 AI 聊天产品中的图片理解工具。你的输出会作为后续主模型的证据上下文。",
    "不要泛泛描述图片；优先回答用户真正关心的问题。",
    "如果看不清、无法确定或只能推测，必须明确写在“不确定点”。",
    "",
    `用户问题：${question}`,
    `图片类型推断：${mode}`,
    "",
  ];

  const sectionsByMode = {
    bug_screenshot: [
      "请按以下结构输出：",
      "[图片识别结果]",
      "类型：",
      "和用户问题相关的结论：",
      "可见文字/OCR：",
      "关键错误/异常：",
      "可能的触发流程：",
      "UI/布局线索：",
      "可用于代码搜索的关键词：",
      "建议优先检查的位置：",
      "不确定点：",
    ],
    code_screenshot: [
      "请按以下结构输出：",
      "[图片识别结果]",
      "类型：",
      "和用户问题相关的结论：",
      "可见文字/OCR：",
      "代码/命令/日志片段：",
      "关键错误/异常：",
      "可用于代码搜索的关键词：",
      "不确定点：",
    ],
    design_review: [
      "请按以下结构输出：",
      "[图片识别结果]",
      "类型：",
      "和用户问题相关的结论：",
      "可见文字/OCR：",
      "页面结构：",
      "视觉问题：",
      "交互状态/控件：",
      "可用于代码搜索的关键词：",
      "不确定点：",
    ],
    table_or_data: [
      "请按以下结构输出：",
      "[图片识别结果]",
      "类型：",
      "和用户问题相关的结论：",
      "可见文字/OCR：",
      "表格结构：",
      "关键数值/字段：",
      "异常数据：",
      "不确定点：",
    ],
    general: [
      "请按以下结构输出：",
      "[图片识别结果]",
      "类型：",
      "和用户问题相关的结论：",
      "可见文字/OCR：",
      "关键对象/区域：",
      "UI/布局线索：",
      "可用于继续分析的关键词：",
      "不确定点：",
    ],
  };

  return base.concat(sectionsByMode[mode] || sectionsByMode.general).join("\n");
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
        if (res.statusCode >= 400) {
          return reject(new Error(`Vision API ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(data)?.choices?.[0]?.message?.content || data);
        } catch {
          resolve(data);
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
  const imageUrl = imageToDataUrl(filePath);
  const question = prompt || "请用中文详细描述这张图片的内容。";
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
 * @returns {Promise<{ ok: true, text: string, mode: string, keepOriginal: boolean } | { ok: false, reason: string, detail?: string } | null>}
 */
async function translateImages(files, options = {}) {
  const imageFiles = (files || []).filter((f) => f?.isImage && f?.path && fs.existsSync(f.path));
  if (imageFiles.length === 0) return null;

  const config = getVisionConfig();
  if (!config.apiKey) {
    return { ok: false, reason: "NO_KEY" };
  }

  const results = [];
  let failed = 0;
  const mode = options.mode || inferVisionMode(options.userText, imageFiles);
  const prompt = buildVisionPrompt({ userText: options.userText, mode });
  for (const f of imageFiles) {
    try {
      const desc = await translateImage(f.path, prompt);
      const label = f.name || path.basename(f.path);
      results.push(`[图片识别结果: "${label}"]\n${desc}`);
    } catch (err) {
      failed += 1;
      console.warn(`Vision translation failed for ${f.name || f.path}:`, err.message);
      results.push(`[图片: ${f.name || path.basename(f.path)}]`);
    }
  }

  if (failed === imageFiles.length) {
    return {
      ok: false,
      reason: "API_FAILED",
      detail: "图片识别服务暂时不可用，请稍后再试。",
    };
  }

  return {
    ok: true,
    text: results.join("\n\n"),
    mode,
    keepOriginal: true,
  };
}

module.exports = {
  buildVisionPrompt,
  getVisionConfig,
  getVisionTimeoutMs,
  hasVisionApiKey,
  inferVisionMode,
  translateImage,
  translateImages,
};
