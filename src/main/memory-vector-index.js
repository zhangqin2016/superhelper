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

module.exports = {
  DEFAULT_DIMENSIONS,
  cosineSimilarity,
  embedText,
  rankWithDurableVectorIndex,
  rankByVectorSimilarity,
};
