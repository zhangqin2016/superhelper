#!/usr/bin/env node
// Model auto-discovery: parsing + the Rule-13 degrade guarantee (any failure /
// unknown provider / missing key → [] so the caller keeps the configured list).
import assert from "node:assert/strict";
import {
  fetchProviderModelCatalog,
  fetchProviderModels,
} from "../server/src/services/model-gateway/model-discovery.js";

function okJson(payload) {
  return async () => ({ ok: true, json: async () => payload });
}

// Parses data[].id and filters non-chat models.
const deepseek = { id: "deepseek", type: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-x" };
const parsed = await fetchProviderModels(
  deepseek,
  okJson({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }, { id: "text-embedding-3" }, { id: "whisper-1" }] }),
);
assert.deepEqual(parsed, ["deepseek-v4-pro", "deepseek-v4-flash"], "should parse chat models and drop embed/whisper");

const catalog = await fetchProviderModelCatalog(
  { id: "myopenai", type: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k" },
  okJson({ data: [{ id: "qwen-long", max_model_len: 196608 }, { id: "image-model", max_model_len: 4096 }] }),
);
assert.deepEqual(catalog.models, ["qwen-long"], "catalog should keep chat models only");
assert.equal(catalog.metadataByModel["qwen-long"].maxModelLen, 196608, "catalog should parse max_model_len");
assert.equal(catalog.metadataByModel["qwen-long"].contextWindowTokens, 196608, "catalog should expose context window");

// Supports { models: [...] } shape and name fallback.
const altShape = await fetchProviderModels(deepseek, okJson({ models: [{ name: "deepseek-reasoner" }] }));
assert.deepEqual(altShape, ["deepseek-reasoner"]);

// Degrade: non-2xx → [].
assert.deepEqual(await fetchProviderModels(deepseek, async () => ({ ok: false, json: async () => ({}) })), []);

// Degrade: fetch throws → [].
assert.deepEqual(await fetchProviderModels(deepseek, async () => { throw new Error("network down"); }), []);

// Degrade: missing key → [] (no request attempted).
assert.deepEqual(await fetchProviderModels({ id: "deepseek", type: "anthropic", baseUrl: "x", apiKey: "" }, okJson({ data: [{ id: "x" }] })), []);

// Degrade: unknown provider with no OpenAI surface → [] (no endpoint).
assert.deepEqual(await fetchProviderModels({ id: "mystery", type: "anthropic", baseUrl: "https://x", apiKey: "k" }, okJson({ data: [{ id: "x" }] })), []);

// Unknown OpenAI-type provider falls back to {baseUrl}/models.
let calledUrl = "";
const openaiish = { id: "myopenai", type: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k" };
await fetchProviderModels(openaiish, async (url) => { calledUrl = url; return { ok: true, json: async () => ({ data: [] }) }; });
assert.equal(calledUrl, "https://api.example.com/v1/models");

console.log("model-discovery: ok");
