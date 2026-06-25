#!/usr/bin/env node
/**
 * "用我们下发的模型": Lily's distributed LILY_* config must translate into an
 * OpenCode provider that speaks the SAME protocol as the distributed endpoint.
 * Lily fed the Claude CLI via an Anthropic-compatible endpoint
 * (api.deepseek.com/anthropic), so we MUST auto-detect that and use the anthropic
 * provider — using openai-compatible there hits /chat/completions and 404s
 * (the bug that made the app unusable when OpenCode became default).
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveOpencodeModelConfig, detectProtocol, anthropicUrl, openaiUrl, forceProModelId } = require("../src/main/runtime/opencode-model-config.js");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// --- protocol detection -----------------------------------------------------
assert(detectProtocol("https://api.deepseek.com/anthropic") === "anthropic", "/anthropic endpoint -> anthropic");
assert(detectProtocol("https://api.deepseek.com/anthropic/") === "anthropic", "/anthropic/ -> anthropic");
assert(detectProtocol("https://api.deepseek.com") === "openai", "plain endpoint -> openai");
assert(detectProtocol("https://api.deepseek.com", { LILY_OPENCODE_PROTOCOL: "anthropic" }) === "anthropic", "override forces anthropic");
assert(detectProtocol("https://lily.example.com/llm/deepseek", { LILY_OPENCODE_PROTOCOL: "anthropic" }) === "anthropic",
  "gateway endpoint uses explicit anthropic protocol");
assert(anthropicUrl("https://x/anthropic") === "https://x/anthropic/v1", "anthropic url gets /v1");
assert(anthropicUrl("https://x/anthropic/v1") === "https://x/anthropic/v1", "anthropic url keeps existing /v1");
assert(openaiUrl("https://x/") === "https://x", "openai url verbatim (trimmed)");
assert(forceProModelId("deepseek-v4-flash") === "deepseek-v4-pro[1m]", "flash id is forced to pro");
assert(forceProModelId("deepseek-v4-pro") === "deepseek-v4-pro", "pro id is unchanged");

// --- THE PRODUCTION CASE: DeepSeek Anthropic endpoint -----------------------
{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://api.deepseek.com/anthropic",
    LILY_API_KEY: "sk-deepseek",
    LILY_MODEL: "deepseek-v4-pro",
  });
  assert(r.ok && r.protocol === "anthropic", "deepseek /anthropic -> anthropic protocol");
  assert(r.model.providerID === "anthropic" && r.model.modelID === "deepseek-v4-pro", "model Ref anthropic/deepseek-v4-pro");
  const cfg = JSON.parse(r.configContent);
  const p = cfg.provider.anthropic;
  assert(p.npm === "@ai-sdk/anthropic", "uses @ai-sdk/anthropic");
  assert(p.options.baseURL === "https://api.deepseek.com/anthropic/v1", "anthropic baseURL with /v1");
  assert(p.options.apiKey === "sk-deepseek", "apiKey -> x-api-key");
  assert(p.options.headers.Authorization === "Bearer sk-deepseek", "also Bearer header (Claude CLI used AUTH_TOKEN)");
  assert("deepseek-v4-pro" in p.models, "custom model declared");
  assert(cfg.model === "anthropic/deepseek-v4-pro", "default model ref");
  assert(r.tiers.haiku === "deepseek-v4-pro", "missing haiku tier falls back to main model");
  assert(r.tiers.subagent === "deepseek-v4-pro", "missing subagent tier falls back to main model");
  assert(r.diagnostics.subagentUsesMainModel === true, "subagent main-model fallback is diagnosed");
  assert(r.diagnostics.subagentModelSource === "LILY_MODEL_FORCED_MAIN", "diagnostic records forced main source");
}

// --- Lily gateway endpoint: protocol is explicit, not guessed from URL -------
{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://lily.example.com/llm/deepseek",
    LILY_API_KEY: "gateway-token",
    LILY_OPENCODE_PROTOCOL: "anthropic",
    LILY_MODEL: "deepseek-v4-pro[1m]",
  });
  assert(r.ok && r.protocol === "anthropic", "gateway /llm endpoint -> anthropic by explicit protocol");
  assert(r.model.providerID === "anthropic", "gateway model ref uses anthropic provider");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.provider.anthropic.options.baseURL === "https://lily.example.com/llm/deepseek/v1",
    "gateway base URL is normalized for Anthropic messages");
  assert(cfg.model === "anthropic/deepseek-v4-pro[1m]", "gateway model ref carried");
}

// --- OpenAI-compatible endpoint (e.g. a raw DeepSeek key on api.deepseek.com) -
{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://api.deepseek.com",
    LILY_API_KEY: "sk", LILY_MODEL: "deepseek-chat",
  });
  assert(r.ok && r.protocol === "openai", "plain endpoint -> openai protocol");
  assert(r.model.providerID === "lily", "openai provider id = lily");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.provider.lily.npm === "@ai-sdk/openai-compatible", "openai-compatible npm");
  assert(cfg.provider.lily.options.baseURL === "https://api.deepseek.com", "openai baseURL verbatim (no /v1 forced)");
}

// --- model tiers: OpenCode runtime is forced onto the selected Pro model -----
{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://api.deepseek.com/anthropic", LILY_API_KEY: "sk", LILY_MODEL: "deepseek-v4-pro",
    LILY_MODEL_HAIKU: "deepseek-v4-flash", LILY_SUBAGENT_MODEL: "deepseek-v4-flash",
  });
  assert(r.tiers.haiku === "deepseek-v4-pro", "haiku tier forced to main");
  assert(r.tiers.subagent === "deepseek-v4-pro", "subagent tier forced to main");
  assert(r.diagnostics.subagentModel === "deepseek-v4-pro", "diagnostic records effective subagent model");
  assert(r.diagnostics.subagentModelSource === "LILY_MODEL_FORCED_MAIN", "forced main source wins");
  assert(r.diagnostics.subagentUsesMainModel === true, "subagents use main model intentionally");
  assert(r.diagnostics.ignoredTierModels.haiku === "deepseek-v4-flash", "ignored fast tier is diagnosed");
  const models = JSON.parse(r.configContent).provider.anthropic.models;
  assert("deepseek-v4-pro" in models && !("deepseek-v4-flash" in models) && Object.keys(models).length === 1, "only effective pro model is declared");
}

// --- flash main model is upgraded to pro ------------------------------------
{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://api.deepseek.com/anthropic", LILY_API_KEY: "sk", LILY_MODEL: "deepseek-v4-flash",
  });
  assert(r.model.modelID === "deepseek-v4-pro[1m]", "flash main model forced to pro runtime model");
  assert(r.diagnostics.forcedModel === "deepseek-v4-pro[1m]", "forced model is diagnosed");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.model === "anthropic/deepseek-v4-pro[1m]", "default model ref uses forced pro");
}

// --- failures: missing model, relative path ---------------------------------
{
  const r1 = resolveOpencodeModelConfig({ LILY_API_BASE_URL: "https://x/anthropic", LILY_API_KEY: "t" });
  assert(r1.ok === false && /LILY_MODEL/.test(r1.reason), "missing model -> reason");
  const r2 = resolveOpencodeModelConfig({ LILY_API_BASE_URL: "/llm/deepseek", LILY_API_KEY: "t", LILY_MODEL: "m" });
  assert(r2.ok === false && /relative/.test(r2.reason), "relative path flagged");
}

console.log("opencode-model-config: ok");
