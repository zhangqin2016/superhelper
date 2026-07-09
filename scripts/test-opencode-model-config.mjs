#!/usr/bin/env node
/**
 * "用我们下发的模型": Lily's distributed LILY_* config must translate into an
 * OpenCode provider that speaks the SAME protocol as the distributed endpoint.
 * Lily may receive an Anthropic-compatible endpoint
 * (api.deepseek.com/anthropic), so we MUST auto-detect that and use the anthropic
 * provider — using openai-compatible there hits /chat/completions and 404s
 * (the bug that made the app unusable when OpenCode became default).
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  resolveOpencodeModelConfig,
  detectProtocol,
  anthropicUrl,
  openaiUrl,
  forceProModelId,
} = require("../src/main/runtime/opencode-model-config.js");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// --- protocol detection -----------------------------------------------------
assert(detectProtocol("https://api.deepseek.com/anthropic") === "anthropic", "/anthropic endpoint -> anthropic");
assert(detectProtocol("https://api.deepseek.com/anthropic/") === "anthropic", "/anthropic/ -> anthropic");
assert(detectProtocol("https://api.deepseek.com") === "openai", "plain endpoint -> openai");
assert(detectProtocol("https://api.deepseek.com", { LILY_OPENCODE_PROTOCOL: "anthropic" }) === "anthropic", "override forces anthropic");
assert(detectProtocol("https://lily.example.com/llm/deepseek", { LILY_OPENCODE_PROTOCOL: "anthropic" }) === "anthropic",
  "gateway endpoint uses explicit anthropic protocol");
assert(detectProtocol("https://proxy.example.com/anthropic", { LILY_OPENCODE_PROTOCOL: "openai" }) === "openai",
  "explicit protocol wins over legacy URL heuristics");
assert(anthropicUrl("https://x/anthropic") === "https://x/anthropic/v1", "anthropic url gets /v1");
assert(anthropicUrl("https://x/anthropic/v1") === "https://x/anthropic/v1", "anthropic url keeps existing /v1");
assert(openaiUrl("https://x/") === "https://x", "openai url verbatim (trimmed)");
assert(forceProModelId("deepseek-v4-flash") === "deepseek-v4-pro[1m]", "flash id is forced to pro");
assert(forceProModelId("deepseek-v4-flash", "openai") === "deepseek-v4-pro", "openai flash id is forced to valid pro id");
assert(forceProModelId("deepseek-v4-pro[1m]", "openai") === "deepseek-v4-pro", "openai strips Anthropic-only DeepSeek suffix");
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
  assert(p.options.headers.Authorization === "Bearer sk-deepseek", "also Bearer header for gateways that require it");
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
  assert(r.diagnostics.modelRoute.route === "gateway", "diagnostics prove gateway route");
  assert(r.diagnostics.modelRoute.provider === "deepseek", "diagnostics include gateway provider");
  assert(r.diagnostics.modelRoute.keyKind === "configured-secret", "non-lilygw gateway token stays redacted");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.provider.anthropic.options.baseURL === "https://lily.example.com/llm/deepseek/v1",
    "gateway base URL is normalized for Anthropic messages");
  assert(cfg.model === "anthropic/deepseek-v4-pro[1m]", "gateway model ref carried");
}

{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://lily.example.com/llm/iluvatar-vllm/v1",
    LILY_API_KEY: "gateway-token",
    LILY_GATEWAY_PROVIDER: "iluvatar-vllm",
    LILY_OPENCODE_PROTOCOL: "openai",
    LILY_MODEL: "/private/Qwen3-Next-80B-A3B-Instruct",
  });
  assert(r.ok && r.protocol === "openai", "OpenAI gateway provider keeps OpenAI protocol");
  assert(r.model.providerID === "lily", "OpenAI gateway model ref uses OpenAI-compatible provider");
  assert(r.model.contextWindowTokens === null, "missing context window stays unspecified instead of guessing by model name");
  assert(r.diagnostics.modelRoute.route === "gateway", "diagnostics still prove gateway route");
  assert(r.diagnostics.modelRoute.provider === "iluvatar-vllm", "diagnostics include OpenAI gateway provider");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.provider.lily.npm === "@ai-sdk/openai-compatible", "gateway OpenAI uses openai-compatible SDK");
  assert(cfg.provider.lily.options.baseURL === "https://lily.example.com/llm/iluvatar-vllm/v1",
    "OpenAI gateway baseURL is the /v1 base used before /chat/completions");
  assert(cfg.model === "lily//private/Qwen3-Next-80B-A3B-Instruct", "slash-prefixed model id is preserved");
}

{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://lily.example.com/llm/iluvatar-vllm/v1",
    LILY_API_KEY: "gateway-token",
    LILY_GATEWAY_PROVIDER: "iluvatar-vllm",
    LILY_OPENCODE_PROTOCOL: "openai",
    LILY_MODEL: "/private/Qwen3-Coder-Next",
    LILY_CONTEXT_WINDOW_TOKENS: "65536",
    LILY_MAX_OUTPUT_TOKENS: "8192",
  });
  assert(r.ok && r.protocol === "openai", "Qwen Coder vLLM still uses generic OpenAI protocol");
  assert(r.model.contextWindowTokens === 65_536, "context window is carried from service metadata");
  assert(r.model.maxOutputTokens === 8_192, "output cap is carried from service metadata");
  assert(r.model.modelID === "/private/Qwen3-Coder-Next", "model id is data, not a hard-coded branch");
}

{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://proxy.example.com/anthropic-looking/v1",
    LILY_API_KEY: "gateway-token",
    LILY_OPENCODE_PROTOCOL: "openai",
    LILY_OPENCODE_PROVIDER_ID: "iluvatar",
    LILY_OPENCODE_PROVIDER_NPM: "@ai-sdk/openai-compatible",
    LILY_MODEL: "qwen3-next",
  });
  assert(r.ok && r.protocol === "openai", "explicit OpenCode protocol is authoritative");
  assert(r.model.providerID === "iluvatar", "explicit OpenCode provider id is carried");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.provider.iluvatar.npm === "@ai-sdk/openai-compatible", "explicit OpenCode provider npm is carried");
  assert(cfg.provider.iluvatar.options.baseURL === "https://proxy.example.com/anthropic-looking/v1",
    "explicit OpenAI-compatible base is not rewritten by Anthropic-looking path text");
  assert(cfg.model === "iluvatar/qwen3-next", "model ref uses explicit provider id");
}

// --- OpenAI-compatible endpoint (e.g. a raw DeepSeek key on api.deepseek.com) -
{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://api.deepseek.com",
    LILY_API_KEY: "sk", LILY_MODEL: "deepseek-chat",
  });
  assert(r.ok && r.protocol === "openai", "plain endpoint -> openai protocol");
  assert(r.diagnostics.modelRoute.route === "direct", "diagnostics prove direct/custom route");
  assert(r.diagnostics.modelRoute.isGateway === false, "direct route is not gateway");
  assert(r.model.providerID === "lily", "openai provider id = lily");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.provider.lily.npm === "@ai-sdk/openai-compatible", "openai-compatible npm");
  assert(cfg.provider.lily.options.baseURL === "https://api.deepseek.com", "openai baseURL verbatim (no /v1 forced)");
  assert(cfg.provider.lily.options.includeUsage === false, "openai-compatible streaming usage chunks are disabled for self-hosted compatibility");
  assert(cfg.provider.lily.options.body === undefined, "OpenAI-compatible models do not get implicit request body options");
}

{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://inference.manassa.ae/models/c5917137-16e9-419e-b474-257bd14f18b3/proxy/v1",
    LILY_API_KEY: "sk",
    LILY_OPENCODE_PROTOCOL: "openai",
    LILY_MODEL: "Qwen/Qwen3.5-27B",
  });
  assert(r.ok && r.protocol === "openai", "Manassa Qwen endpoint uses OpenAI-compatible protocol");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.model === "lily/Qwen/Qwen3.5-27B", "Qwen slash model id is preserved");
  assert(cfg.provider.lily.options.baseURL === "https://inference.manassa.ae/models/c5917137-16e9-419e-b474-257bd14f18b3/proxy/v1",
    "Qwen OpenAI-compatible baseURL remains the /v1 base");
  assert(cfg.provider.lily.options.body === undefined,
    "model names must not trigger hidden behavior; request body options come from a profile");
}

{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://inference.manassa.ae/models/c5917137-16e9-419e-b474-257bd14f18b3/proxy/v1",
    LILY_API_KEY: "sk",
    LILY_OPENCODE_PROTOCOL: "openai",
    LILY_MODEL: "Qwen/Qwen3.5-27B",
    LILY_OPENCODE_BODY_OVERLAY_JSON: JSON.stringify({
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  assert(r.ok && r.protocol === "openai", "Manassa Qwen endpoint uses OpenAI-compatible protocol with an explicit profile");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.provider.lily.options.body === undefined,
    "request body overlay must not be placed in provider options because AI SDK ignores that field");
  assert(cfg.provider.lily.models["Qwen/Qwen3.5-27B"].options.chat_template_kwargs.enable_thinking === false,
    "profile body overlay is carried through model options so OpenCode forwards it as providerOptions");
}

{
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: "https://api.deepseek.com/v1",
    LILY_API_KEY: "sk",
    LILY_OPENCODE_PROTOCOL: "openai",
    LILY_MODEL: "deepseek-v4-pro[1m]",
  });
  assert(r.ok && r.protocol === "openai", "DeepSeek /v1 can use OpenAI protocol");
  assert(r.model.modelID === "deepseek-v4-pro", "OpenAI protocol uses the valid DeepSeek model id");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.model === "lily/deepseek-v4-pro", "OpenAI config model ref uses normalized id");
  assert("deepseek-v4-pro" in cfg.provider.lily.models, "OpenAI provider declares normalized model");
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
