/**
 * BYOK provider catalog, server-side. The server (which can reach the network)
 * fetches models.dev — the authoritative, continuously-updated source OpenCode
 * uses — curates a common-provider subset, and CACHES it. The catalog is then
 * delivered to clients inside the effective config (models.catalog), so clients
 * get a rich, current "add a model" list without reaching models.dev themselves
 * (it's often blocked client-side) and without an app rebuild.
 *
 * Robustness: a vendored snapshot (src/data/model-catalog.json, refreshed by
 * scripts/fetch-model-catalog.mjs) is the fallback, so the catalog ships even if
 * the live fetch fails. refreshModelCatalog() updates the in-memory cache;
 * getModelCatalog() is a sync read used by buildEnvManagedClientConfig.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = "https://models.dev/api.json";
const VENDORED = path.join(__dirname, "..", "data", "model-catalog.json");
const TTL_MS = 24 * 60 * 60 * 1000;

// models.dev id -> { id, label } for our catalog. Extend as needed.
const PROVIDERS = [
  ["deepseek", "deepseek", "DeepSeek"],
  ["zhipuai", "zhipuai", "智谱 GLM"],
  ["moonshotai", "moonshotai", "Kimi (Moonshot)"],
  ["alibaba", "qwen", "通义千问 Qwen"],
  ["alibaba-cn", "qwen-cn", "通义千问 Qwen（国内）"],
  ["minimax", "minimax", "MiniMax"],
  ["stepfun", "stepfun", "阶跃 StepFun"],
  ["anthropic", "anthropic", "Anthropic Claude"],
  ["openai", "openai", "OpenAI GPT"],
  ["google", "google", "Google Gemini"],
  ["xai", "xai", "xAI Grok"],
  ["mistral", "mistral", "Mistral"],
  ["groq", "groq", "Groq"],
];

// models.dev omits `api` for providers the AI SDK ships a built-in URL for.
const DEFAULT_BASE_URLS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
};

function protocolFor(npm) {
  return String(npm || "").includes("@ai-sdk/anthropic") ? "anthropic" : "openai";
}

function isChatModel(model) {
  const out = model?.modalities?.output;
  return Array.isArray(out) ? out.includes("text") : true;
}

/** models.dev api.json -> [{ id, label, baseUrl, protocol, models:[idString] }]. */
function curate(data) {
  const out = [];
  for (const [srcId, id, label] of PROVIDERS) {
    const p = data?.[srcId];
    if (!p || !p.models) continue;
    const baseUrl = p.api || DEFAULT_BASE_URLS[srcId];
    if (!baseUrl) continue;
    const models = Object.values(p.models)
      .filter(isChatModel)
      .map((m) => ({ id: String(m.id), release: m.release_date || "" }))
      .filter((m) => m.id)
      .sort((a, b) => (b.release || "").localeCompare(a.release || "") || a.id.localeCompare(b.id))
      .map((m) => m.id);
    if (!models.length) continue;
    out.push({ id, label, baseUrl, protocol: protocolFor(p.npm), models });
  }
  return out;
}

function loadVendored() {
  try {
    const data = JSON.parse(fs.readFileSync(VENDORED, "utf8"));
    // Vendored snapshot stores models as objects; flatten to id strings.
    return (Array.isArray(data?.providers) ? data.providers : []).map((p) => ({
      id: String(p.id),
      label: String(p.label || p.id),
      baseUrl: String(p.baseUrl),
      protocol: p.protocol === "anthropic" ? "anthropic" : "openai",
      models: (Array.isArray(p.models) ? p.models : [])
        .map((m) => (typeof m === "string" ? m : String(m?.id || "")))
        .filter(Boolean),
    }));
  } catch {
    return [];
  }
}

let cache = { providers: loadVendored(), fetchedAt: 0, source: "vendored" };

/** Sync read for buildEnvManagedClientConfig — cached live data, else vendored. */
export function getModelCatalog() {
  return cache.providers;
}

/** Best-effort live refresh from models.dev. Keeps the previous/vendored data on
 *  any failure (network blocked, shape change) — never throws. */
export async function refreshModelCatalog() {
  try {
    if (cache.source === "live" && Date.now() - cache.fetchedAt < TTL_MS) return cache.providers;
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`models.dev ${res.status}`);
    const providers = curate(await res.json());
    if (providers.length) cache = { providers, fetchedAt: Date.now(), source: "live" };
    return cache.providers;
  } catch {
    return cache.providers;
  }
}
