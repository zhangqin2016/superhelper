"use strict";

/**
 * Vision translation — converts image files to text descriptions via DashScope.
 * Used by the send pipeline so non-vision LLMs can "see" user-uploaded images.
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");

const BASE_URL = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const API_KEY = process.env.VISION_API_KEY || process.env.DASHSCOPE_API_KEY || "";
const MODEL = process.env.VISION_MODEL || "qwen-vl-plus";

const MIME_MAP = {
  jpg: "jpeg", jpeg: "jpeg", png: "png",
  gif: "gif", webp: "webp", bmp: "bmp",
};

function imageToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mime = MIME_MAP[ext] || "jpeg";
  const data = fs.readFileSync(filePath);
  return `data:image/${mime};base64,${data.toString("base64")}`;
}

function callVisionApi(payload) {
  const url = new URL(`${BASE_URL.replace(/\/?$/, "/")}chat/completions`);
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
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
  if (!API_KEY) {
    throw new Error("VISION_API_KEY or DASHSCOPE_API_KEY not configured");
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Image file not found: ${filePath}`);
  }
  const imageUrl = imageToDataUrl(filePath);
  const question = prompt || "请用中文详细描述这张图片的内容。";
  return callVisionApi({
    model: MODEL,
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
 * Returns null if no images need translation or translation is unavailable.
 * @param {Array<{path?: string, name?: string, isImage?: boolean}>} files
 * @returns {Promise<string|null>}
 */
async function translateImages(files) {
  if (!API_KEY) return null;
  const imageFiles = (files || []).filter((f) => f?.isImage && f?.path && fs.existsSync(f.path));
  if (imageFiles.length === 0) return null;

  const results = [];
  for (const f of imageFiles) {
    try {
      const desc = await translateImage(f.path,
        "请用中文详细描述这张图片的内容，包括界面布局、文字内容、按钮位置、颜色等细节。"
      );
      results.push(`[图片${f.name ? ` "${f.name}"` : ""}的内容：${desc}]`);
    } catch (err) {
      console.warn(`Vision translation failed for ${f.name || f.path}:`, err.message);
      results.push(`[图片: ${f.name || path.basename(f.path)}]`);
    }
  }
  return results.length > 0 ? results.join("\n\n") : null;
}

module.exports = { translateImage, translateImages };
