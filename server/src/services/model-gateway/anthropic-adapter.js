import { DEFAULT_ANTHROPIC_VERSION } from "./utils.js";

// Generous connect/first-response budget. Guards ONLY until the upstream sends
// response headers — once that resolves, the body (incl. a long SSE stream) is
// freed to flow without being cut. A dead/stalled upstream therefore fails loud
// within this window instead of hanging the turn at "正在启动…" forever.
const CONNECT_TIMEOUT_MS = Number(process.env.MODEL_GATEWAY_UPSTREAM_TIMEOUT_MS || 60_000);

// Send BOTH auth schemes upstream. Native Anthropic uses `x-api-key`; many
// Anthropic-compatible proxies (e.g. GLM / z.ai) require `Authorization: Bearer`.
// Providers read whichever they expect and ignore the other — this mirrors what
// the client already sends to the gateway, so no provider is left unauthenticated.
function anthropicHeaders(provider, request, extra = {}) {
  return {
    "x-api-key": provider.apiKey,
    Authorization: `Bearer ${provider.apiKey}`,
    "anthropic-version": String(request?.headers?.["anthropic-version"] || DEFAULT_ANTHROPIC_VERSION),
    ...extra,
    ...provider.headers,
  };
}

// fetch whose abort timer is cleared the moment response headers arrive, so it
// bounds connection + time-to-first-byte without truncating a streaming body.
async function fetchWithConnectTimeout(target, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    return await fetch(target, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function forwardAnthropic(provider, body, request) {
  const target = `${provider.baseUrl}/v1/messages`;
  return fetchWithConnectTimeout(target, {
    method: "POST",
    headers: anthropicHeaders(provider, request, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

export async function forwardAnthropicCountTokens(provider, body, request) {
  const target = `${provider.baseUrl}/v1/messages/count_tokens`;
  return fetchWithConnectTimeout(target, {
    method: "POST",
    headers: anthropicHeaders(provider, request, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

export async function forwardAnthropicModels(provider, request) {
  const target = `${provider.baseUrl}/v1/models`;
  return fetchWithConnectTimeout(target, {
    method: "GET",
    headers: anthropicHeaders(provider, request),
  });
}
