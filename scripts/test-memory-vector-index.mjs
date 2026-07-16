#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  cosineSimilarity,
  embedText,
  rankWithDurableVectorIndex,
  rankByVectorSimilarity,
} = require("../src/main/memory-vector-index.js");

const left = embedText("语义向量检索和上下文记忆");
const right = embedText("semantic vector retrieval for memory context");
const unrelated = embedText("LibreOffice document rendering pipeline");

assert.equal(left.length, 128, "default vector size is stable");
assert.equal(cosineSimilarity(left, left) > 0.99, true, "identical vectors score near one");
assert.equal(
  cosineSimilarity(left, right) > cosineSimilarity(left, unrelated),
  true,
  "concept aliases improve cross-language semantic recall",
);

const ranked = rankByVectorSimilarity([
  { id: "evidence", text: "证据图回放和来源引用" },
  { id: "runtime", text: "运行时下载 LibreOffice" },
], "evidence replay graph");
assert.equal(
  ranked.find((item) => item.id === "evidence").semanticRelevance >
    ranked.find((item) => item.id === "runtime").semanticRelevance,
  true,
  "semantic relevance ranks related memory higher",
);

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-memory-vector-index-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));

const durable = rankWithDurableVectorIndex([
  { id: "m1", kind: "project_memory", sourceVersion: "v1", text: "semantic retrieval memory" },
  { id: "m2", kind: "project_memory", sourceVersion: "v1", text: "document rendering runtime" },
], "semantic memory", { projectKey: "project-a" });
assert.equal(durable.diagnostics.semanticIndex, "durable", "userData enables durable semantic index");
assert.equal(durable.diagnostics.entries, 2);
assert.equal(durable.diagnostics.rebuilt, 2);

const reused = rankWithDurableVectorIndex([
  { id: "m1", kind: "project_memory", sourceVersion: "v1", text: "semantic retrieval memory" },
  { id: "m2", kind: "project_memory", sourceVersion: "v1", text: "document rendering runtime" },
], "semantic memory", { projectKey: "project-a" });
assert.equal(reused.diagnostics.semanticIndex, "durable");
assert.equal(reused.diagnostics.rebuilt, 0, "unchanged sourceVersion/text reuses persisted vectors");

// ---------------------------------------------------------------------------
// REAL semantic embeddings (opt-in). Fake caller buckets text into concept axes,
// so paraphrases in the same concept recall each other with zero shared tokens.
const {
  makeEmbeddingCaller,
  resolveEmbeddingConfig,
  resolveEmbeddingCaller,
  semanticRelevanceMap,
} = require("../src/main/memory-vector-index.js");
const { buildContextMemory, buildContextMemoryAsync } = require("../src/main/memory-registry.js");

const CONCEPTS = [
  ["postgres", "database", "db", "connection", "sql", "socket"],
  ["markdown", "render", "html", "css", "duplicate"],
  ["token", "budget", "window", "context"],
];
function fakeEmbed(text) {
  const t = String(text || "").toLowerCase();
  const vec = CONCEPTS.map((group) => (group.some((w) => t.includes(w)) ? 1 : 0));
  return vec.some(Boolean) ? vec : [0, 0, 0, 1];
}
let embeddedTexts = 0;
function makeFakeCaller() {
  return async (texts) => { embeddedTexts += texts.length; return texts.map(fakeEmbed); };
}

// endpoint validation — opt-in, never fires accidentally
assert.equal(makeEmbeddingCaller({}), null, "no baseUrl/model → null");
assert.equal(makeEmbeddingCaller({ baseUrl: "https://x/v1" }), null, "missing model → null");
assert.equal(typeof makeEmbeddingCaller({ baseUrl: "https://x/v1", model: "m" }), "function", "complete → caller");

// ordering: embeddings API may return `data` OUT OF ORDER (each with `index`);
// the caller must realign so vector[i] matches input[i] (else recall is poisoned).
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { index: 2, embedding: [2, 2] },
        { index: 0, embedding: [0, 0] },
        { index: 1, embedding: [1, 1] },
      ],
    }),
  });
  try {
    const caller = makeEmbeddingCaller({ baseUrl: "https://x/v1", model: "m" });
    const vecs = await caller(["zero", "one", "two"]);
    assert.deepEqual(vecs, [[0, 0], [1, 1], [2, 2]], "out-of-order embeddings realigned to input order by index");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// kill switch: explicit "0" disables even with a key present (no egress)
assert.equal(resolveEmbeddingConfig({ LILY_MEMORY_EMBEDDING: "0", LILY_EMBEDDING_BASE_URL: "https://x/v1", LILY_EMBEDDING_API_KEY: "sk-t" }), null, "explicit 0 → null (kill switch)");
assert.equal(resolveEmbeddingCaller({ LILY_MEMORY_EMBEDDING: "0", LILY_EMBEDDING_API_KEY: "sk-t" }), null, "kill switch → no caller (lexical-only)");
// enabled but no resolvable key → null (never fires a doomed 401; keyless stays lexical)
assert.equal(resolveEmbeddingConfig({ LILY_MEMORY_EMBEDDING: "1", LILY_EMBEDDING_BASE_URL: "https://x/v1" }), null, "enabled without key → null");
// enabled + key, no endpoint spelled out → DashScope defaults
const dashCfg = resolveEmbeddingConfig({ LILY_MEMORY_EMBEDDING: "1", LILY_EMBEDDING_API_KEY: "sk-t" });
assert.ok(dashCfg && /dashscope/i.test(dashCfg.baseUrl), "enabled+key → defaults to DashScope base url");
assert.equal(dashCfg.model, "text-embedding-v3", "default model is text-embedding-v3");
// explicit env overrides win
const overrideCfg = resolveEmbeddingConfig({ LILY_MEMORY_EMBEDDING: "on", LILY_EMBEDDING_API_KEY: "sk-t", LILY_EMBEDDING_BASE_URL: "https://x/v1", LILY_EMBEDDING_MODEL: "m" });
assert.equal(overrideCfg.baseUrl, "https://x/v1", "explicit base url overrides");
assert.equal(overrideCfg.model, "m", "explicit model overrides");
assert.equal(typeof resolveEmbeddingCaller({ LILY_MEMORY_EMBEDDING: "1", LILY_EMBEDDING_API_KEY: "sk-t", LILY_EMBEDDING_BASE_URL: "https://x/v1", LILY_EMBEDDING_MODEL: "m" }), "function", "enabled + endpoint + key → caller");

// paraphrase recall — query shares NO token with the db item's text
const embItems = [
  { id: "db", kind: "reference", text: "postgres server refused the socket", priority: 50 },
  { id: "md", kind: "reference", text: "markdown rendered a duplicate block", priority: 50 },
  { id: "tok", kind: "reference", text: "context window token budget exceeded", priority: 50 },
];
const embQuery = "why does my database keep failing to connect";
const semMap = await semanticRelevanceMap(embItems, embQuery, { caller: makeFakeCaller(), projectKey: "emb-a", model: "fake" });
assert.ok(semMap instanceof Map, "returns a Map");
const dbScore = semMap.get([...semMap.keys()].find((k) => k.startsWith("db:"))) ?? 0;
const mdScore = semMap.get([...semMap.keys()].find((k) => k.startsWith("md:"))) ?? 0;
assert.ok(dbScore > mdScore && dbScore > 0.9, `db paraphrase (${dbScore}) outranks markdown (${mdScore})`);

// durable cache — second recall re-embeds only the new query, reuses item vectors
const before = embeddedTexts;
await semanticRelevanceMap(embItems, "cannot open a sql connection", { caller: makeFakeCaller(), projectKey: "emb-a", model: "fake" });
assert.equal(embeddedTexts - before, 1, "cached items reused; only the new query is embedded");

// fail-open — any failure → null, so callers drop to the lexical rank
assert.equal(await semanticRelevanceMap(embItems, embQuery, { caller: async () => { throw new Error("down"); }, projectKey: "emb-b", model: "fake" }), null, "caller error → null");
assert.equal(await semanticRelevanceMap(embItems, embQuery, { caller: async (t) => t.slice(1).map(fakeEmbed), projectKey: "emb-c", model: "fake" }), null, "length mismatch → null");
assert.equal(await semanticRelevanceMap(embItems, embQuery, { projectKey: "emb-a" }), null, "no caller → null");

// buildContextMemoryAsync — unconfigured/failed == sync lexical baseline (zero regression)
const memInput = {
  userText: "database connection keeps dropping",
  project: { name: "lily", path: "/repo/lily" },
  turnPolicy: { rigor: "grounded" },
  projectMemory: {
    filePath: "/repo/lily/memory/MEMORY.md",
    mtimeMs: 100,
    bytes: 200,
    text: "- [DB pool](db.md) — postgres socket refused under load\n- [Markdown](md.md) — duplicate render on reopen",
    truncated: false,
  },
  workspaceDigest: "Directory structure:\n- src/ (12)",
  learnedConventions: "- 用户偏好中文结果",
};
const syncMem = buildContextMemory(memInput);
const asyncNoCaller = await buildContextMemoryAsync(memInput);
assert.equal(asyncNoCaller.fingerprint, syncMem.fingerprint, "unconfigured async === sync");
const asyncThrows = await buildContextMemoryAsync({ ...memInput, embeddingCaller: async () => { throw new Error("down"); } });
assert.equal(asyncThrows.fingerprint, syncMem.fingerprint, "embed failure → lexical baseline (fail-open)");
const asyncSemantic = await buildContextMemoryAsync({ ...memInput, embeddingCaller: makeFakeCaller() });
assert.equal(asyncSemantic.diagnostics.semanticIndex, "embedding", "configured caller → embedding-ranked");

console.log("memory-vector-index: ok");
