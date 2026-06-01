"use strict";

/**
 * Vision translation — converts image files to text descriptions via DashScope.
 * Used by the send pipeline so non-vision LLMs can "see" user-uploaded images.
 *
 * Keys live in agent settings.json (bundled or userData), not only process.env.
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const { resolveSettingsEnvValue } = require("./agent-settings");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-vl-plus";

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

function imageToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mime = MIME_MAP[ext] || "jpeg";
  const data = fs.readFileSync(filePath);
  return `data:image/${mime};base64,${data.toString("base64")}`;
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
    req.setTimeout(30000, () => {
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
    max_tokens: 1024,
  });
}

/**
 * Translate all images in a files array to a combined text description.
 * @param {Array<{path?: string, name?: string, isImage?: boolean}>} files
 * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: string, detail?: string } | null>}
 */
async function translateImages(files) {
  const imageFiles = (files || []).filter((f) => f?.isImage && f?.path && fs.existsSync(f.path));
  if (imageFiles.length === 0) return null;

  const config = getVisionConfig();
  if (!config.apiKey) {
    return { ok: false, reason: "NO_KEY" };
  }

  const results = [];
  let failed = 0;
  for (const f of imageFiles) {
    try {
      const desc = await translateImage(f.path,
        "请用中文详细描述这张图片的内容，包括界面布局、文字内容、按钮位置、颜色等细节。"
      );
      results.push(`[图片${f.name ? ` "${f.name}"` : ""}的内容：${desc}]`);
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

  return { ok: true, text: results.join("\n\n") };
}

module.exports = {
  getVisionConfig,
  hasVisionApiKey,
  translateImage,
  translateImages,
};
