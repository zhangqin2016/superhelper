"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DIMENSIONS = 128;
const CONCEPT_ALIASES = [
  ["semantic", "vector", "embedding", "语义", "向量", "检索", "召回"],
  ["memory", "context", "compaction", "summary", "记忆", "上下文", "压缩", "摘要"],
  ["subagent", "agent", "isolation", "handoff", "子代理", "隔离", "分工", "回传"],
  ["evidence", "replay", "graph", "proof", "证据", "回放", "引用", "来源"],
  ["session", "message", "idle", "broadcast", "会话", "串话", "消息", "广播"],
  ["markdown", "render", "duplicate", "collapse", "渲染", "重复", "折叠"],
  ["token", "tokenizer", "provider", "预算", "估算", "窗口"],
];

function hashInt(value) {
  return crypto.createHash("sha1").update(String(value)).digest().readUInt32BE(0);
}

function lexicalFeatures(value) {
  const text = String(value || "").toLowerCase();
  const features = [];
  for (const match of text.matchAll(/[a-z0-9_.:/-]{2,}/g)) {
    const token = match[0];
    features.push(token);
    if (token.length > 4) features.push(token.slice(0, 4));
  }
  const compact = text.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 1; i += 1) {
    const pair = compact.slice(i, i + 2);
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(pair)) features.push(pair);
  }
  for (let i = 0; i < compact.length - 2; i += 1) {
    const tri = compact.slice(i, i + 3);
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(tri)) features.push(tri);
  }
  for (const group of CONCEPT_ALIASES) {
    if (group.some((alias) => text.includes(alias.toLowerCase()))) {
      features.push(`concept:${group[0]}`);
      features.push(`concept:${group[1] || group[0]}`);
    }
  }
  return features.slice(0, 700);
}

function embedText(value, { dimensions = DEFAULT_DIMENSIONS } = {}) {
  const size = Math.max(16, Number(dimensions || DEFAULT_DIMENSIONS));
  const vector = new Array(size).fill(0);
  for (const feature of lexicalFeatures(value)) {
    const hash = hashInt(feature);
    const index = hash % size;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function cosineSimilarity(left = [], right = []) {
  const size = Math.min(left.length || 0, right.length || 0);
  if (!size) return 0;
  let dot = 0;
  for (let i = 0; i < size; i += 1) dot += Number(left[i] || 0) * Number(right[i] || 0);
  return Math.max(0, Math.min(1, dot));
}

function memoryItemText(item = {}) {
  return [
    item.id,
    item.kind,
    item.reason,
    item.text,
  ].filter(Boolean).join("\n");
}

function safeKey(value) {
  return crypto.createHash("sha256").update(String(value || "default")).digest("hex").slice(0, 32);
}

function textHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function semanticIndexPath(projectKey) {
  try {
    const { userDataPath } = require("./config");
    return userDataPath("memory-vector-index", `${safeKey(projectKey)}.json`);
  } catch {
    return null;
  }
}

function readIndex(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeIndex(filePath, index) {
  if (!filePath) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(index), "utf8");
    return true;
  } catch {
    return false;
  }
}

function entryKey(item = {}) {
  return [
    item.id || "",
    item.kind || "",
    item.sourceVersion || "",
    textHash(memoryItemText(item)).slice(0, 16),
  ].join(":");
}

function rankByVectorSimilarity(items = [], query = "", opts = {}) {
  const queryVector = embedText(query, opts);
  return (Array.isArray(items) ? items : []).map((item) => {
    const vector = embedText(memoryItemText(item), opts);
    return {
      ...item,
      semanticRelevance: cosineSimilarity(queryVector, vector),
    };
  });
}

function rankWithDurableVectorIndex(items = [], query = "", opts = {}) {
  const source = Array.isArray(items) ? items : [];
  const projectKey = opts.projectKey || "";
  const filePath = projectKey ? semanticIndexPath(projectKey) : null;
  if (!filePath) {
    return {
      items: rankByVectorSimilarity(source, query, opts),
      diagnostics: { semanticIndex: "local_fallback", reason: "index_path_unavailable" },
    };
  }

  const dimensions = Math.max(16, Number(opts.dimensions || DEFAULT_DIMENSIONS));
  const previous = readIndex(filePath);
  const previousEntries = new Map(
    previous?.schemaVersion === 1 && previous?.dimensions === dimensions
      ? (previous.entries || []).map((entry) => [entry.key, entry])
      : [],
  );
  let rebuilt = 0;
  const entries = [];
  for (const item of source) {
    const key = entryKey(item);
    const prior = previousEntries.get(key);
    if (prior?.vector?.length === dimensions) {
      entries.push(prior);
      continue;
    }
    rebuilt += 1;
    entries.push({
      key,
      id: item.id || "",
      kind: item.kind || "",
      sourceVersion: item.sourceVersion || "",
      vector: embedText(memoryItemText(item), { dimensions }),
    });
  }

  const next = {
    schemaVersion: 1,
    projectKey: safeKey(projectKey),
    dimensions,
    updatedAt: new Date().toISOString(),
    entries,
  };
  const writable = writeIndex(filePath, next);
  if (!writable) {
    return {
      items: rankByVectorSimilarity(source, query, opts),
      diagnostics: { semanticIndex: "local_fallback", reason: "index_write_failed" },
    };
  }

  const entryMap = new Map(entries.map((entry) => [entry.key, entry]));
  const queryVector = embedText(query, { dimensions });
  return {
    items: source.map((item) => ({
      ...item,
      semanticRelevance: cosineSimilarity(queryVector, entryMap.get(entryKey(item))?.vector || []),
    })),
    diagnostics: {
      semanticIndex: "durable",
      entries: entries.length,
      rebuilt,
    },
  };
}

// ---------------------------------------------------------------------------
// REAL semantic embeddings (opt-in). The lexical hash above is a keyword proxy;
// a real embedding model recalls paraphrases ("can't connect to postgres" ↔ "db
// connection failing"). OPT-IN via LILY_EMBEDDING_BASE_URL/KEY/MODEL — when
// unconfigured everything above is unchanged (zero regression, zero latency).
// FAIL OPEN: any error → null, and the caller falls back to the lexical rank.

// Build an OpenAI-compatible /embeddings caller (managed gateway OR custom BYOK).
// Returns null when the endpoint is incomplete so the caller degrades cleanly.
function makeEmbeddingCaller({ baseUrl = "", apiKey = "", model = "" } = {}) {
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!url || !String(model || "").trim()) return null;
  return async (texts) => {
    const input = Array.isArray(texts) ? texts : [texts];
    const response = await fetch(`${url}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, input }),
    });
    if (!response.ok) throw new Error(`embeddings http ${response.status}`);
    const data = await response.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    // The embeddings spec lets `data` come back in ANY order, each row carrying
    // its input `index`. Place each vector at its declared index so vector[i]
    // ALWAYS matches input[i] — a silent misalignment would poison recall.
    const out = new Array(input.length).fill(null);
    rows.forEach((r, i) => {
      const idx = Number.isInteger(r?.index) ? r.index : i;
      if (idx >= 0 && idx < out.length) out[idx] = Array.isArray(r?.embedding) ? r.embedding : [];
    });
    return out.map((v) => (Array.isArray(v) ? v : []));
  };
}

// DashScope compatible-mode already backs vision/voice and exposes an
// OpenAI-compatible /embeddings; text-embedding-v3 is its recall model. When
// embeddings are enabled but no endpoint is spelled out, default here and reuse
// the DASHSCOPE_API_KEY existing users already have.
const DASHSCOPE_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-v3";

// Read a value from agent settings (remote-config → user → bundled → process.env),
// falling back to the passed env. Lazy + fail-safe so this module stays testable
// without the settings layer present.
function settingsValue(env, ...keys) {
  try {
    const { resolveSettingsEnvValue } = require("./agent-settings");
    const fromSettings = resolveSettingsEnvValue(...keys);
    if (fromSettings) return fromSettings;
  } catch {
    /* settings layer unavailable (tests) — fall through to env */
  }
  for (const key of keys) {
    const value = String(env?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function embeddingEnabled(env = process.env) {
  // DEFAULT-ON in code (source-controlled; the bundled settings file is gitignored
  // and regenerated by the release pipeline, so it can't hold a durable default).
  // Only an explicit kill switch disables it. Safe because it stays KEY-GATED +
  // fail-open downstream: no key / endpoint error → lexical baseline, never worse.
  const flag = String(env.LILY_MEMORY_EMBEDDING ?? settingsValue(env, "LILY_MEMORY_EMBEDDING") ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off");
}

// Resolve embedding endpoint config. OPT-IN: null unless LILY_MEMORY_EMBEDDING is
// enabled. Once enabled, base/key/model fall back to DashScope + the shared key so
// turning it on is a single flag, not three env vars.
function resolveEmbeddingConfig(env = process.env) {
  if (!embeddingEnabled(env)) return null;
  const apiKey = env.LILY_EMBEDDING_API_KEY || settingsValue(env, "LILY_EMBEDDING_API_KEY", "EMBEDDING_API_KEY", "DASHSCOPE_API_KEY");
  // No resolvable key → return null so we never fire a doomed 401 on every memory
  // turn. This makes global enable safe: keyless users silently stay lexical.
  if (!apiKey) return null;
  return {
    baseUrl: env.LILY_EMBEDDING_BASE_URL || settingsValue(env, "LILY_EMBEDDING_BASE_URL", "DASHSCOPE_BASE_URL") || DASHSCOPE_EMBEDDING_BASE_URL,
    apiKey,
    model: env.LILY_EMBEDDING_MODEL || settingsValue(env, "LILY_EMBEDDING_MODEL") || DEFAULT_EMBEDDING_MODEL,
  };
}

// Resolve the configured embedding caller (opt-in). null when disabled/unresolvable.
function resolveEmbeddingCaller(env = process.env) {
  const config = resolveEmbeddingConfig(env);
  return config ? makeEmbeddingCaller(config) : null;
}

function semanticIndexPathTagged(projectKey, tag) {
  try {
    const { userDataPath } = require("./config");
    return userDataPath("memory-vector-index", `${safeKey(projectKey)}__${safeKey(tag)}.json`);
  } catch {
    return null;
  }
}

// Async: real-embedding cosine relevance per item. Embeds only NEW/changed items
// (durable cache keyed by provider+model), plus the query, each recall. Returns a
// Map(entryKey -> cosine) or null on ANY failure (→ caller uses the lexical rank).
async function semanticRelevanceMap(items = [], query = "", { caller, projectKey = "", model = "" } = {}) {
  try {
    if (typeof caller !== "function") return null;
    const source = Array.isArray(items) ? items : [];
    if (!source.length || !String(query || "").trim()) return null;
    const filePath = semanticIndexPathTagged(projectKey || "default", `emb:${model || "x"}`);
    const previous = readIndex(filePath);
    const cache = new Map(
      previous?.schemaVersion === 2 ? (previous.entries || []).map((e) => [e.key, e.vector]) : [],
    );
    const missing = [];
    for (const item of source) {
      const key = entryKey(item);
      if (!cache.has(key)) missing.push({ key, text: memoryItemText(item) });
    }
    if (missing.length) {
      const vectors = await caller(missing.map((m) => m.text));
      if (!Array.isArray(vectors) || vectors.length !== missing.length) return null;
      missing.forEach((m, i) => { if (Array.isArray(vectors[i]) && vectors[i].length) cache.set(m.key, vectors[i]); });
      if (filePath) {
        writeIndex(filePath, {
          schemaVersion: 2,
          entries: [...cache.entries()].map(([key, vector]) => ({ key, vector })),
        });
      }
    }
    const [queryVector] = await caller([query]);
    if (!Array.isArray(queryVector) || !queryVector.length) return null;
    const out = new Map();
    for (const item of source) {
      const vec = cache.get(entryKey(item));
      out.set(entryKey(item), vec ? cosineSimilarity(queryVector, vec) : 0);
    }
    return out;
  } catch {
    return null; // fail open — lexical ranking still applies
  }
}

module.exports = {
  DEFAULT_DIMENSIONS,
  cosineSimilarity,
  embedText,
  entryKey,
  rankWithDurableVectorIndex,
  rankByVectorSimilarity,
  makeEmbeddingCaller,
  resolveEmbeddingConfig,
  resolveEmbeddingCaller,
  semanticRelevanceMap,
};
