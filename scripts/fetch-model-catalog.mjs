#!/usr/bin/env node
/**
 * Generate the BYOK provider catalog from models.dev (the same authoritative,
 * continuously-updated source OpenCode uses). The runtime engine can't reach
 * models.dev (blocked/offline for many users), so we snapshot a curated subset
 * into resources/model-catalog.json and ship it with the app. Re-run to refresh:
 *
 *   node scripts/fetch-model-catalog.mjs
 *
 * Output entry shape (consumed by model-presets.getBundledProviderCatalog):
 *   { id, label, baseUrl, protocol: "anthropic"|"openai", models: [
 *       { id, name, reasoning, toolCall, attachment, contextLimit, outputLimit }
 *   ] }
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Written to BOTH the client bundle (offline fallback) and the server vendored
// snapshot (the server's fallback when its live models.dev fetch fails).
const OUTPUTS = [
  path.join(ROOT, "resources", "model-catalog.json"),
  path.join(ROOT, "server", "src", "data", "model-catalog.json"),
];
const SOURCE = "https://models.dev/api.json";

// Curated, well-known DIRECT providers users are likely to bring a key for.
// Keyed by models.dev provider id -> our catalog id + display label. Add more
// here as needed; missing providers are simply skipped.
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

// models.dev omits `api` for providers the AI SDK ships a built-in URL for. Our
// engine only speaks anthropic OR openai-compatible, so map each to its public
// endpoint in the right dialect (Gemini/xai/mistral/groq via their openai-compat
// base; Anthropic via its native base).
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

/** A chat/text model: emits text output and isn't an embedding/image-only model. */
function isChatModel(model) {
  const out = model?.modalities?.output;
  if (Array.isArray(out)) return out.includes("text");
  // No modality info → keep it (most chat models predate the field).
  return true;
}

async function main() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
  const data = await res.json();

  const catalog = [];
  for (const [srcId, id, label] of PROVIDERS) {
    const p = data[srcId];
    if (!p || !p.models) continue;
    const baseUrl = p.api || DEFAULT_BASE_URLS[srcId];
    if (!baseUrl) continue;
    const models = Object.values(p.models)
      .filter(isChatModel)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        reasoning: Boolean(m.reasoning),
        toolCall: Boolean(m.tool_call),
        attachment: Boolean(m.attachment),
        contextLimit: Number(m.limit?.context || 0) || 0,
        outputLimit: Number(m.limit?.output || 0) || 0,
        releaseDate: m.release_date || "",
      }))
      // Newest first when we have dates, else stable by id.
      .sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || "") || a.id.localeCompare(b.id));
    if (!models.length) continue;
    catalog.push({ id, label, baseUrl, protocol: protocolFor(p.npm), models });
  }

  if (!catalog.length) throw new Error("no providers matched — models.dev shape changed?");
  catalog.sort((a, b) => a.label.localeCompare(b.label));

  const payload = {
    source: SOURCE,
    generatedAt: new Date().toISOString(),
    providers: catalog,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  for (const out of OUTPUTS) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, serialized);
  }
  const totalModels = catalog.reduce((n, p) => n + p.models.length, 0);
  console.log(`model-catalog: ${catalog.length} providers, ${totalModels} models -> ${OUTPUTS.map((o) => path.relative(ROOT, o)).join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
