#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function emit(obj, code = 0) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exitCode = code;
}

function userDataDir() {
  const dir = process.env.LILY_USER_DATA_DIR;
  if (!dir) throw new Error("LILY_USER_DATA_DIR not set (run inside the Lily app)");
  return dir;
}

function readLatest() {
  const file = path.join(userDataDir(), "document-query-index", "latest.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function tokenize(value = "") {
  const words = String(value || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const tokens = new Set(words.filter((word) => word.length > 1));
  for (const word of words) {
    if (/[\u3400-\u9fff]/.test(word) && word.length > 1) {
      for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2));
    }
  }
  return [...tokens];
}

function normalize(record) {
  const index = record?.index || {};
  return {
    schemaVersion: Number(record?.schemaVersion || 1),
    sessionId: String(record?.sessionId || ""),
    turnId: String(record?.turnId || ""),
    createdAt: record?.createdAt || "",
    extractedPaths: Array.isArray(record?.extractedPaths) ? record.extractedPaths : [],
    documents: Array.isArray(index.documents) ? index.documents : [],
    chunks: Array.isArray(index.chunks) ? index.chunks : [],
  };
}

function buildResult(record, matches) {
  const normalized = normalize(record);
  const documentsById = new Map(normalized.documents.map((doc) => [doc.id, doc]));
  return {
    ok: true,
    sessionId: normalized.sessionId,
    turnId: normalized.turnId,
    createdAt: normalized.createdAt,
    matches: matches.map((chunk) => {
      const doc = documentsById.get(chunk.documentId) || {};
      return {
        documentId: chunk.documentId || "",
        documentLabel: chunk.label || doc.label || "",
        documentPath: doc.path || "",
        chunkId: chunk.chunkId || "",
        heading: chunk.heading || "",
        charStart: Number(chunk.charStart || 0),
        charEnd: Number(chunk.charEnd || 0),
        excerpt: chunk.excerpt || "",
        ...(chunk.score ? { score: chunk.score } : {}),
      };
    }),
  };
}

function parseLimit(args, fallback = 8) {
  const idx = args.indexOf("--limit");
  if (idx < 0) return fallback;
  return Math.max(1, Math.min(Number(args[idx + 1]) || fallback, 50));
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const record = readLatest();
  if (!record) return emit({ ok: false, error: "NO_INDEX", message: "No Lily document query index has been written yet." }, 1);
  const normalized = normalize(record);
  if (command === "list") {
    return emit({
      ok: true,
      sessionId: normalized.sessionId,
      turnId: normalized.turnId,
      createdAt: normalized.createdAt,
      documents: normalized.documents,
      chunks: normalized.chunks,
    });
  }
  if (command === "read") {
    const chunkId = args[0];
    if (!chunkId) return emit({ ok: false, error: "MISSING_CHUNK_ID" }, 1);
    return emit(buildResult(record, normalized.chunks.filter((chunk) => chunk.chunkId === chunkId)));
  }
  if (command === "search") {
    const queryParts = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--limit") {
        i += 1;
      } else {
        queryParts.push(args[i]);
      }
    }
    const terms = tokenize(queryParts.join(" "));
    if (!terms.length) return emit({ ok: false, error: "EMPTY_QUERY" }, 1);
    const scored = [];
    for (const chunk of normalized.chunks) {
      const haystack = `${chunk.label || ""} ${chunk.heading || ""} ${chunk.excerpt || ""}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += term.length > 3 ? 2 : 1;
      }
      if (score > 0) scored.push({ ...chunk, score });
    }
    scored.sort((a, b) => b.score - a.score || String(a.chunkId).localeCompare(String(b.chunkId)));
    return emit(buildResult(record, scored.slice(0, parseLimit(args))));
  }
  return emit({
    ok: false,
    error: "USAGE",
    usage: [
      "node query_document_index.cjs list",
      "node query_document_index.cjs search \"query\" --limit 8",
      "node query_document_index.cjs read <chunkId>",
    ],
  }, 1);
}

try {
  main();
} catch (err) {
  emit({ ok: false, error: `${err?.name || "Error"}: ${err?.message || err}` }, 1);
}
