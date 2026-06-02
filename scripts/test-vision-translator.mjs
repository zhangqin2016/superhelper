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
delete process.env.DASHSCOPE_API_KEY;
delete process.env.VISION_API_KEY;

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
  translateImages,
} = require("../src/main/vision-translator.js");

const config = getVisionConfig();
if (config.apiKey !== "user-dash-key") {
  throw new Error(`expected user dash key, got ${config.apiKey}`);
}
if (config.model !== "qwen-vl-max") {
  throw new Error(`expected qwen-vl-max, got ${config.model}`);
}
if (!hasVisionApiKey()) {
  throw new Error("hasVisionApiKey should be true");
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

const prompt = buildVisionPrompt({
  userText: "这个截图为什么不能发送消息？",
  mode: "bug_screenshot",
});
for (const expected of ["用户问题：这个截图为什么不能发送消息？", "可见文字/OCR", "关键错误/异常", "可用于代码搜索的关键词", "不确定点"]) {
  if (!prompt.includes(expected)) {
    throw new Error(`expected prompt to include ${expected}`);
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
  if (!vision.hasVisionApiKey()) {
    const noKeyResult = await vision.translateImages([
      { isImage: true, path: fileURLToPath(import.meta.url), name: "x.png" },
    ]);
    if (!noKeyResult || noKeyResult.ok !== false || noKeyResult.reason !== "NO_KEY") {
      throw new Error(`expected NO_KEY result, got ${JSON.stringify(noKeyResult)}`);
    }
  }
})()
  .then(() => {
    if (prevDash) process.env.DASHSCOPE_API_KEY = prevDash;
    if (prevVision) process.env.VISION_API_KEY = prevVision;
    fs.rmSync(mockUserData, { recursive: true, force: true });
    fs.rmSync(emptyResources, { recursive: true, force: true });
    console.log("test-vision-translator: ok");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
