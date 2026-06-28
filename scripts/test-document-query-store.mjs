#!/usr/bin/env node

import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";

const require = module.createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-document-query-store-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));

const { buildDocumentQueryIndex } = require(path.join(ROOT, "src/main/document-query-index.js"));
const {
  persistDocumentQueryIndex,
  queryDocumentQueryIndex,
  readDocumentQueryIndex,
  readLatestDocumentQueryIndex,
} = require(path.join(ROOT, "src/main/document-query-store.js"));

const index = buildDocumentQueryIndex([
  {
    label: "contract.md",
    path: "/tmp/contract.md",
    text: "# Payment Terms\nBuyer pays within 30 days after invoice receipt.\n\n# Termination\nEither party may terminate for uncured material breach.",
  },
]);

const record = persistDocumentQueryIndex({
  sessionId: "session/alpha",
  turnId: "turn:one",
  index,
  extractedPaths: ["/tmp/contract.md"],
  createdAt: "2026-06-28T00:00:00.000Z",
});

if (record.sessionId !== "session/alpha" || record.turnId !== "turn:one") {
  throw new Error(`persisted record should preserve logical ids: ${JSON.stringify(record)}`);
}
if (!fs.existsSync(path.join(tempUserData, "document-query-index", "latest.json"))) {
  throw new Error("persisting a document index must update latest.json for agent skill scripts");
}
if (!fs.existsSync(path.join(tempUserData, "document-query-index", "sessions", "session_alpha", "turn_one.json"))) {
  throw new Error("persisting a document index must write a sanitized per-turn copy");
}

const latest = readLatestDocumentQueryIndex();
if (latest.sessionId !== "session/alpha" || latest.index.chunks.length !== 2) {
  throw new Error(`latest record should round-trip structured chunks: ${JSON.stringify(latest)}`);
}
const exact = readDocumentQueryIndex({ sessionId: "session/alpha", turnId: "turn:one" });
if (exact?.index?.documents?.[0]?.label !== "contract.md") {
  throw new Error(`per-turn record should be readable by logical ids: ${JSON.stringify(exact)}`);
}
const sessionLatest = readDocumentQueryIndex({ sessionId: "session/alpha" });
if (sessionLatest?.turnId !== "turn:one") {
  throw new Error(`per-session latest record should be readable without a turn id: ${JSON.stringify(sessionLatest)}`);
}

const search = queryDocumentQueryIndex(latest, { query: "payment buyer invoice", limit: 3 });
if (!search.ok || search.matches[0]?.chunkId !== "doc1-chunk1") {
  throw new Error(`query should rank the payment chunk first: ${JSON.stringify(search)}`);
}
if (!search.matches[0].excerpt.includes("Buyer pays")) {
  throw new Error(`query results must return the stored excerpt as evidence: ${JSON.stringify(search.matches[0])}`);
}

const chunk = queryDocumentQueryIndex(latest, { chunkId: "doc1-chunk2" });
if (!chunk.ok || chunk.matches[0]?.heading !== "Termination") {
  throw new Error(`chunkId lookup should return the exact stored chunk: ${JSON.stringify(chunk)}`);
}

const miss = queryDocumentQueryIndex(latest, { query: "unrelated warranty exhibit", limit: 3 });
if (!miss.ok || miss.matches.length !== 0) {
  throw new Error(`unmatched queries should fail soft with an empty match list: ${JSON.stringify(miss)}`);
}

console.log("document-query-store: ok");
