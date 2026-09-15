"use strict";

/**
 * Cheap model readiness ping.
 *
 * One minimal chat completion (max_tokens 1, no tools, no stream) against the
 * session's active model route, with a short hard timeout. Used by the model
 * recovery watch to learn WHEN a silent upstream is back so the interrupted
 * task can be continued — the full compatibility probe is far too heavy to
 * poll with. Fail-open: any error is "not ready", never a throw.
 */

const DEFAULT_TIMEOUT_MS = 12_000;

function routeFromEnv(env = {}) {
  const baseURL = String(env.LILY_OPENCODE_BASE_URL || env.LILY_API_BASE_URL || "").trim().replace(/\/$/, "");
  const apiKey = String(env.LILY_OPENCODE_API_KEY || env.LILY_API_KEY || "").trim();
  const model = String(env.LILY_OPENCODE_MODEL || env.LILY_MODEL || "").trim();
  if (!baseURL || !model) return null;
  const protocol = String(env.LILY_OPENCODE_PROTOCOL || "").toLowerCase();
  return { baseURL, apiKey, model, protocol: protocol === "anthropic" ? "anthropic" : "openai" };
}

function defaultFetch() {
  try { return require("./proxy-aware-fetch"); } catch { return globalThis.fetch; }
}

/**
 * @param {{ sessionId?: string, env?: object, fetch?: Function, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, reason?: string, status?: number, latencyMs: number, model?: string }>}
 */
async function pingModel(options = {}) {
  const started = Date.now();
  const latency = () => Date.now() - started;
  let env = options.env || null;
  if (!env) {
    try {
      const route = require("./model-selection-catalog").resolveTurnModel({ sessionId: options.sessionId || "" });
      env = route?.execution?.env || null;
    } catch {
      env = null;
    }
  }
  if (!env) {
    try { env = require("./spawn-env").resolveLilyEnv(); } catch { env = null; }
  }
  const route = routeFromEnv(env || {});
  if (!route) return { ok: false, reason: "NO_MODEL_ROUTE", latencyMs: latency() };
  const fetchImpl = options.fetch || defaultFetch();
  if (typeof fetchImpl !== "function") return { ok: false, reason: "FETCH_UNAVAILABLE", latencyMs: latency() };
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const anthropic = route.protocol === "anthropic";
    const url = anthropic ? `${route.baseURL}/messages` : `${route.baseURL}/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (route.apiKey) {
      if (anthropic) { headers["x-api-key"] = route.apiKey; headers["anthropic-version"] = "2023-06-01"; }
      else headers.Authorization = `Bearer ${route.apiKey}`;
    }
    const body = anthropic
      ? { model: route.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }
      : { model: route.model, max_tokens: 1, stream: false, messages: [{ role: "user", content: "ping" }] };
    const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller?.signal });
    const status = Number(response?.status) || 0;
    let text = "";
    try { text = await response.text(); } catch { text = ""; }
    if (status < 200 || status >= 300) return { ok: false, reason: `HTTP_${status}`, status, latencyMs: latency(), model: route.model };
    const trimmed = String(text || "").trim();
    // A 200 whose body is not JSON (an HTML error page) is exactly the
    // "zero-chunk" failure the watchdog protects against — not ready.
    if (!trimmed.startsWith("{")) return { ok: false, reason: "NON_JSON_BODY", status, latencyMs: latency(), model: route.model };
    return { ok: true, status, latencyMs: latency(), model: route.model };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "TIMEOUT" : "REQUEST_FAILED", latencyMs: latency(), model: route.model };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { pingModel, routeFromEnv, DEFAULT_TIMEOUT_MS };
