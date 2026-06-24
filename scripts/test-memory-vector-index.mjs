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

console.log("memory-vector-index: ok");
