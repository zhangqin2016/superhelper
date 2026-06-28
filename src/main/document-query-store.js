"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

const SCHEMA_VERSION = 1;
const STORE_DIR = "document-query-index";

function storeRoot() {
  return userDataPath(STORE_DIR);
}

function safeSegment(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160) || "unknown";
}

function latestPath() {
  return path.join(storeRoot(), "latest.json");
}

function sessionLatestPath(sessionId) {
  return path.join(storeRoot(), "sessions", safeSegment(sessionId), "latest.json");
}

function sessionRecordPath(sessionId, turnId) {
  return path.join(storeRoot(), "sessions", safeSegment(sessionId), `${safeSegment(turnId)}.json`);
}

function normalizeIndex(index = {}) {
  return {
    schemaVersion: Number(index.schemaVersion || 1),
    documents: Array.isArray(index.documents) ? index.documents : [],
    chunks: Array.isArray(index.chunks) ? index.chunks : [],
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function persistDocumentQueryIndex({
  sessionId,
  turnId,
  index,
  extractedPaths = [],
  createdAt = new Date().toISOString(),
} = {}) {
  const normalized = normalizeIndex(index);
  if (!normalized.documents.length || !normalized.chunks.length) {
    return null;
  }
  const record = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: String(sessionId || ""),
    turnId: String(turnId || ""),
    createdAt,
    extractedPaths: Array.isArray(extractedPaths) ? extractedPaths.filter(Boolean) : [],
    index: normalized,
  };
  writeJson(sessionRecordPath(record.sessionId, record.turnId), record);
  writeJson(sessionLatestPath(record.sessionId), record);
  writeJson(latestPath(), record);
  return record;
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return null;
  const index = normalizeIndex(record.index || record);
  if (!index.documents.length && !index.chunks.length) return null;
  return {
    schemaVersion: Number(record.schemaVersion || SCHEMA_VERSION),
    sessionId: String(record.sessionId || ""),
    turnId: String(record.turnId || ""),
    createdAt: record.createdAt || "",
    extractedPaths: Array.isArray(record.extractedPaths) ? record.extractedPaths : [],
    index,
  };
}

function readLatestDocumentQueryIndex() {
  return normalizeRecord(readJson(latestPath()));
}

function readDocumentQueryIndex({ sessionId, turnId } = {}) {
  if (!sessionId) return null;
  if (!turnId) return normalizeRecord(readJson(sessionLatestPath(sessionId)));
  return normalizeRecord(readJson(sessionRecordPath(sessionId, turnId)));
}

function tokenize(value = "") {
  const text = String(value || "").toLowerCase();
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  const tokens = new Set(words.filter((word) => word.length > 1));
  for (const word of words) {
    if (/[\u3400-\u9fff]/.test(word) && word.length > 1) {
      for (let i = 0; i < word.length - 1; i += 1) {
        tokens.add(word.slice(i, i + 2));
      }
    }
  }
  return [...tokens];
}

function chunkHaystack(chunk = {}) {
  return `${chunk.label || ""} ${chunk.heading || ""} ${chunk.excerpt || ""}`.toLowerCase();
}

function withDocument(chunk, documentsById) {
  const document = documentsById.get(chunk.documentId) || null;
  return {
    documentId: chunk.documentId || "",
    documentLabel: chunk.label || document?.label || "",
    documentPath: document?.path || "",
    chunkId: chunk.chunkId || "",
    heading: chunk.heading || "",
    charStart: Number(chunk.charStart || 0),
    charEnd: Number(chunk.charEnd || 0),
    excerpt: chunk.excerpt || "",
  };
}

function queryDocumentQueryIndex(recordOrIndex, { query = "", documentId = "", chunkId = "", limit = 8 } = {}) {
  const record = normalizeRecord(recordOrIndex);
  if (!record) return { ok: false, error: "NO_INDEX", matches: [] };
  const index = record.index;
  const documentsById = new Map(index.documents.map((doc) => [doc.id, doc]));
  let chunks = index.chunks;
  if (documentId) chunks = chunks.filter((chunk) => chunk.documentId === documentId);
  if (chunkId) {
    return {
      ok: true,
      record: { sessionId: record.sessionId, turnId: record.turnId, createdAt: record.createdAt },
      matches: chunks.filter((chunk) => chunk.chunkId === chunkId).map((chunk) => withDocument(chunk, documentsById)),
    };
  }
  const terms = tokenize(query);
  if (!terms.length) {
    return { ok: false, error: "EMPTY_QUERY", matches: [] };
  }
  const max = Math.max(1, Math.min(Number(limit) || 8, 50));
  const scored = [];
  for (const chunk of chunks) {
    const haystack = chunkHaystack(chunk);
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += term.length > 3 ? 2 : 1;
    }
    if (score > 0) scored.push({ score, chunk });
  }
  scored.sort((a, b) => b.score - a.score || String(a.chunk.chunkId).localeCompare(String(b.chunk.chunkId)));
  return {
    ok: true,
    record: { sessionId: record.sessionId, turnId: record.turnId, createdAt: record.createdAt },
    matches: scored.slice(0, max).map(({ score, chunk }) => ({
      ...withDocument(chunk, documentsById),
      score,
    })),
  };
}

module.exports = {
  persistDocumentQueryIndex,
  queryDocumentQueryIndex,
  readDocumentQueryIndex,
  readLatestDocumentQueryIndex,
  safeSegment,
};
