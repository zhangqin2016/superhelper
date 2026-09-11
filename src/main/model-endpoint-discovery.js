"use strict";

// Discover which models an endpoint actually serves, so a user can paste our
// (or any) base URL + key and pick from a list instead of typing a model id by
// hand. Standard OpenAI `GET /models` (and the Anthropic equivalent). Fail-open:
// any failure returns { ok:false, error } and the caller falls back to manual
// entry — discovery is a convenience, never a gate. Capabilities are still
// detected by the save-time probe; this only fills the model id.

function trimUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function authHeaders(protocol, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return {};
  if (protocol === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  return { authorization: `Bearer ${key}` };
}

// Pull model ids out of the several shapes compatible servers return:
// OpenAI { data:[{id}] }, Anthropic { data:[{id}] }, or a bare { models:[...] }.
function extractIds(json) {
  const rows = Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.models) ? json.models
    : Array.isArray(json) ? json : [];
  const ids = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : (row?.id || row?.name || row?.model);
    if (id && typeof id === "string") ids.push(id.trim());
  }
  return [...new Set(ids.filter(Boolean))];
}

async function discoverEndpointModels({ baseUrl, apiKey, protocol = "openai", timeoutMs = 15_000 } = {}) {
  const base = trimUrl(baseUrl);
  if (!base) return { ok: false, error: "BASE_URL_REQUIRED" };
  const url = `${base}/models`;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: authHeaders(protocol, apiKey),
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 15_000)),
    });
  } catch (error) {
    return { ok: false, error: "NETWORK", detail: String(error?.message || error).slice(0, 200) };
  }
  if (!res.ok) {
    // 401/403 = key/scope; 404 = no /models route. All fall back to manual entry.
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `HTTP_${res.status}`, detail: detail.slice(0, 200) };
  }
  let json;
  try { json = await res.json(); } catch { return { ok: false, error: "BAD_RESPONSE" }; }
  const models = extractIds(json).slice(0, 500);
  if (!models.length) return { ok: false, error: "NO_MODELS" };
  return { ok: true, models };
}

module.exports = { discoverEndpointModels };
