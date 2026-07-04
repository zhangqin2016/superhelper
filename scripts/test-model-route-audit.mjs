#!/usr/bin/env node
/**
 * Final model route observability: the app must be able to prove whether the
 * engine will call Lily's /llm gateway or a direct/custom provider endpoint.
 * The audit is intentionally read-only and redacted: it must not alter routing
 * or expose model keys.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { classifyModelRoute, keyKind, safeUrlSummary } = require("../src/main/model-route-audit.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

{
  const route = classifyModelRoute({
    LILY_API_BASE_URL: "https://lily.example.com/llm/deepseek",
    LILY_API_KEY: "lilygw.abc_def.123-XYZ",
    LILY_GATEWAY_PROVIDER: "deepseek",
    LILY_OPENCODE_PROTOCOL: "anthropic",
    LILY_MODEL: "deepseek-v4-pro[1m]",
  });
  assert(route.route === "gateway" && route.isGateway, "absolute /llm URL is a gateway route");
  assert(route.provider === "deepseek", "gateway provider comes from explicit marker");
  assert(route.baseUrl === "https://lily.example.com/llm/deepseek", "base URL is redacted to origin + path");
  assert(route.keyKind === "gateway-token", "lilygw token is classified");
  assert(route.model === "deepseek-v4-pro[1m]", "model is included for diagnostics");
}

{
  const route = classifyModelRoute({
    LILY_API_BASE_URL: "/llm/glm/v1/messages?secret=should-not-leak",
    LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
  });
  assert(route.route === "gateway", "relative /llm URL is still recognized as gateway");
  assert(route.provider === "glm", "provider is inferred from /llm/<provider>");
  assert(route.baseUrl === "/llm/glm/v1/messages", "query strings are stripped from diagnostics");
  assert(route.keyKind === "gateway-placeholder", "gateway placeholder is classified");
}

{
  const route = classifyModelRoute({
    LILY_API_BASE_URL: "https://api.deepseek.com/anthropic",
    LILY_API_KEY: "sk-direct-provider-key",
    LILY_MODEL: "deepseek-v4-pro",
  });
  assert(route.route === "direct" && !route.isGateway, "provider endpoint is direct");
  assert(route.provider === "", "direct route has no gateway provider");
  assert(route.keyKind === "provider-key", "provider-looking keys are classified without logging the key");
}

{
  const route = classifyModelRoute({
    LILY_API_BASE_URL: "https://lily.example.com/llm/deepseek",
    LILY_API_KEY: "sk-looks-like-provider-key",
  });
  assert(route.route === "gateway", "gateway path still wins over key shape");
  assert(route.warnings.includes("gateway-route-has-provider-key-shape"), "suspicious gateway key shape is warned");
}

{
  const redacted = safeUrlSummary("https://user:pass@api.example.com/v1/messages?api_key=secret#hash");
  assert(redacted.baseUrl === "https://api.example.com/v1/messages", "URL credentials/query/hash are never exposed");
}

assert(keyKind("") === "missing", "empty key classified");
assert(keyKind("lilygw.a.b") === "gateway-token", "gateway token classified");
assert(keyKind("sk-abc") === "provider-key", "provider key shape classified");

console.log("model-route-audit: ok");
