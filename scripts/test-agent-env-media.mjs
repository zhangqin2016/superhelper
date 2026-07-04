#!/usr/bin/env node
import assert from "node:assert/strict";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const { normalizeToLilyEnv, toEngineEnv } = require(path.join(__dirname, "../src/main/agent-env.js"));

const remoteMediaEnv = normalizeToLilyEnv({
  LILY_IMAGE_PROVIDER: "volcengine",
  LILY_VIDEO_PROVIDER: "dashscope",
  DASHSCOPE_API_KEY: "dashscope-gateway-token",
  DASHSCOPE_IMAGE_BASE_URL: "https://lily.example.com/llm/dashscope-media",
  DASHSCOPE_TTS_BASE_URL: "https://lily.example.com/llm/dashscope-media",
  VOLCENGINE_API_KEY: "volcengine-gateway-token",
  VOLCENGINE_BASE_URL: "https://lily.example.com/llm/media/volcengine",
  KLING_API_KEY: "kling-gateway-token",
  KLING_BASE_URL: "https://lily.example.com/llm/media/kling",
  MINIMAX_API_KEY: "minimax-gateway-token",
  MINIMAX_BASE_URL: "https://lily.example.com/llm/media/minimax",
  ZHIPU_API_KEY: "zhipu-gateway-token",
  ZHIPU_BASE_URL: "https://lily.example.com/llm/media/zhipu",
});

const engineEnv = toEngineEnv(remoteMediaEnv);

assert.equal(engineEnv.LILY_IMAGE_PROVIDER, "volcengine");
assert.equal(engineEnv.LILY_VIDEO_PROVIDER, "dashscope");
assert.equal(engineEnv.DASHSCOPE_IMAGE_BASE_URL, "https://lily.example.com/llm/dashscope-media");
assert.equal(engineEnv.DASHSCOPE_TTS_BASE_URL, "https://lily.example.com/llm/dashscope-media");
assert.equal(engineEnv.VOLCENGINE_BASE_URL, "https://lily.example.com/llm/media/volcengine");
assert.equal(engineEnv.KLING_BASE_URL, "https://lily.example.com/llm/media/kling");
assert.equal(engineEnv.MINIMAX_BASE_URL, "https://lily.example.com/llm/media/minimax");
assert.equal(engineEnv.ZHIPU_BASE_URL, "https://lily.example.com/llm/media/zhipu");

console.log("agent-env-media: ok");
