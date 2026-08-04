#!/usr/bin/env node
/**
 * Vision config resolution (mock Electron, no network).
 */
import module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..");

const emptyResources = fs.mkdtempSync(path.join(os.tmpdir(), "lily-vision-empty-res-"));
process.resourcesPath = emptyResources;

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-vision-test-"));
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath(name) {
        if (name === "userData") return mockUserData;
        if (name === "home") return os.homedir();
        return os.tmpdir();
      },
    },
  },
};

const prevDash = process.env.DASHSCOPE_API_KEY;
const prevVision = process.env.VISION_API_KEY;
const prevVisionModel = process.env.VISION_MODEL;
delete process.env.DASHSCOPE_API_KEY;
delete process.env.VISION_API_KEY;
delete process.env.VISION_MODEL;

const { agentConfigDir } = require("../src/main/config.js");
const agentDir = agentConfigDir();
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  JSON.stringify({
    env: {
      DASHSCOPE_API_KEY: "user-dash-key",
      VISION_MODEL: "qwen-vl-max",
      DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
  }),
  "utf8",
);

const {
  buildVisionPrompt,
  getVisionConfig,
  getVisionImageLimits,
  hasVisionApiKey,
  imageToDataUrl,
  inferVisionMode,
  isVisionInputFile,
  normalizeVisionContent,
  translateImages,
} = require("../src/main/vision-translator.js");

const normalizedParts = normalizeVisionContent([
  { type: "text", text: "第一段" },
  { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
  { type: "text", text: "第二段" },
]);
if (normalizedParts !== "第一段\n第二段") {
  throw new Error(`vision content parts should normalize to text, got ${JSON.stringify(normalizedParts)}`);
}
if (normalizeVisionContent({ text: "  有内容  " }) !== "有内容") {
  throw new Error("object-shaped vision content should normalize to trimmed text");
}
if (normalizeVisionContent([{ type: "image_url" }]) !== "") {
  throw new Error("image-only response parts must not be treated as readable recognition text");
}

const config = getVisionConfig();
if (config.apiKey !== "user-dash-key") {
  throw new Error(`expected user dash key, got ${config.apiKey}`);
}
if (config.model !== "qwen-vl-max") {
  throw new Error(`expected qwen-vl-max, got ${config.model}`);
}
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  JSON.stringify({
    env: {
      DASHSCOPE_API_KEY: "user-dash-key",
      VISION_MODEL: "qwen3.7-plus",
      DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
  }),
  "utf8",
);
const legacyConfig = getVisionConfig();
if (legacyConfig.model !== "qwen-vl-max") {
  throw new Error(`expected legacy settings model to normalize to qwen-vl-max, got ${legacyConfig.model}`);
}
if (!hasVisionApiKey()) {
  throw new Error("hasVisionApiKey should be true");
}
if (!isVisionInputFile({ path: "/tmp/screen.png" })) {
  throw new Error("png files should be treated as vision input even without isImage marker");
}
if (isVisionInputFile({ path: "/tmp/report.pdf" })) {
  throw new Error("pdf files should not be treated as vision input");
}
if (isVisionInputFile({ path: "/tmp/chart.svg", isImage: true })) {
  throw new Error("svg files should stay file/vector artifacts, not raster vision input");
}

const bugMode = inferVisionMode("这个 bug 截图报错 Session ID already in use", [
  { name: "screen.png" },
]);
if (bugMode !== "bug_screenshot") {
  throw new Error(`expected bug_screenshot, got ${bugMode}`);
}

const designMode = inferVisionMode("帮我看下这个页面布局和间距", [
  { name: "ui.png" },
]);
if (designMode !== "design_review") {
  throw new Error(`expected design_review, got ${designMode}`);
}

const uiScreenshotMode = inferVisionMode("检查这个 UI 截图哪里不合理", [
  { name: "screenshot.png" },
]);
if (uiScreenshotMode !== "design_review") {
  throw new Error(`expected UI screenshot to use design_review JSON mode, got ${uiScreenshotMode}`);
}

const prompt = buildVisionPrompt({
  userText: "这个截图为什么不能发送消息？",
  mode: "bug_screenshot",
});
for (const expected of [
  "这个截图为什么不能发送消息？",
  "Visible text / OCR",
  "Key errors / exceptions",
  "Keywords useful for code search",
  "Uncertainties",
]) {
  if (!prompt.includes(expected)) {
    throw new Error(`expected prompt to include ${expected}`);
  }
}

const designPrompt = buildVisionPrompt({
  userText: "帮我检查这个 UI 页面布局并给修改建议",
  mode: "design_review",
});
for (const expected of [
  "Return JSON only",
  "\"mode\": \"ui_screenshot\"",
  "\"components\"",
  "\"issues\"",
  "\"keywords_for_code_search\"",
  "Do not write implementation code",
]) {
  if (!designPrompt.includes(expected)) {
    throw new Error(`expected design prompt to include ${expected}`);
  }
}

const limits = getVisionImageLimits();
if (limits.maxEdge !== 1800 || limits.maxBytes !== 4 * 1024 * 1024) {
  throw new Error(`unexpected default vision image limits: ${JSON.stringify(limits)}`);
}

const largeImage = path.join(mockUserData, "large-screenshot.png");
await sharp({
  create: {
    width: 2600,
    height: 1800,
    channels: 3,
    background: { r: 230, g: 240, b: 250 },
  },
})
  .png()
  .toFile(largeImage);
const largeDataUrl = await imageToDataUrl(largeImage);
if (!largeDataUrl.startsWith("data:image/jpeg;base64,")) {
  throw new Error("large image should be converted to jpeg data URL for vision");
}
const largePayloadBytes = Buffer.byteLength(largeDataUrl.split(",")[1] || "", "base64");
const largeMeta = await sharp(Buffer.from(largeDataUrl.split(",")[1] || "", "base64")).metadata();
if (Math.max(largeMeta.width || 0, largeMeta.height || 0) > limits.maxEdge) {
  throw new Error(`optimized image exceeds max edge: ${largeMeta.width}x${largeMeta.height}`);
}
if (largePayloadBytes >= fs.statSync(largeImage).size) {
  throw new Error("optimized image should be smaller than original large PNG");
}

(async () => {
  const noImages = await translateImages([]);
  if (noImages !== null) {
    throw new Error("expected null when no images");
  }

  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ env: {} }), "utf8");
  delete require.cache[require.resolve("../src/main/agent-settings.js")];
  delete require.cache[require.resolve("../src/main/vision-translator.js")];
  const vision = require("../src/main/vision-translator.js");
  const fallbackConfig = vision.getVisionConfig();
  if (fallbackConfig.model !== "qwen-vl-max") {
    throw new Error(`expected fallback vision model qwen-vl-max, got ${fallbackConfig.model}`);
  }
  if (vision.normalizeVisionModel("qwen3.7-plus") !== "qwen-vl-max") {
    throw new Error("legacy qwen3.7-plus should normalize to qwen-vl-max");
  }
  if (!vision.hasVisionApiKey()) {
    const noKeyResult = await vision.translateImages([
      { path: largeImage, name: "x.png" },
    ]);
    if (!noKeyResult || noKeyResult.ok !== false || noKeyResult.reason !== "NO_KEY") {
      throw new Error(`expected NO_KEY result, got ${JSON.stringify(noKeyResult)}`);
    }
  }
})()
  .then(() => {
    if (prevDash) process.env.DASHSCOPE_API_KEY = prevDash;
    if (prevVision) process.env.VISION_API_KEY = prevVision;
    if (prevVisionModel) process.env.VISION_MODEL = prevVisionModel;
    fs.rmSync(mockUserData, { recursive: true, force: true });
    fs.rmSync(emptyResources, { recursive: true, force: true });
    console.log("test-vision-translator: ok");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
