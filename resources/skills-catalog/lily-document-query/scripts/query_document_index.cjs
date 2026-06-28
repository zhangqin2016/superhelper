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

function safeSegment(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160) || "unknown";
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sessionsRoot() {
  return path.join(userDataDir(), "document-query-index", "sessions");
}

function readSessionLatest(sessionId) {
  return readRecord(path.join(sessionsRoot(), safeSegment(sessionId), "latest.json"));
}

function readSessionTurn(sessionId, turnId) {
  return readRecord(path.join(sessionsRoot(), safeSegment(sessionId), `${safeSegment(turnId)}.json`));
}

function listSessionRecords() {
  let names = [];
  try {
    names = fs.readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .map((name) => readRecord(path.join(sessionsRoot(), name, "latest.json")))
    .filter(Boolean)
    .map((record) => {
      const normalized = normalize(record);
      return {
        sessionId: normalized.sessionId,
        turnId: normalized.turnId,
        createdAt: normalized.createdAt,
        documentCount: normalized.documents.length,
        chunkCount: normalized.chunks.length,
        documents: normalized.documents.map((doc) => ({ id: doc.id, label: doc.label })),
      };
    });
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

function optionValue(args, name) {
  const idx = args.indexOf(name);
  if (idx < 0) return "";
  return String(args[idx + 1] || "");
}

function withoutOptions(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--limit" || args[i] === "--session" || args[i] === "--turn") {
      i += 1;
    } else if (args[i] !== "--latest") {
      out.push(args[i]);
    }
  }
  return out;
}

function resolveRecord(args) {
  const sessionId = optionValue(args, "--session") || process.env.LILY_SESSION_ID || "";
  const turnId = optionValue(args, "--turn");
  if (sessionId && turnId) return { record: readSessionTurn(sessionId, turnId) };
  if (sessionId) return { record: readSessionLatest(sessionId) };
  if (args.includes("--latest")) return { record: readLatest() };
  const sessions = listSessionRecords();
  if (sessions.length > 1) {
    return { error: "AMBIGUOUS_SESSION", sessions };
  }
  if (sessions.length === 1) return { record: readSessionLatest(sessions[0].sessionId) };
  return { record: readLatest() };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const resolved = resolveRecord(args);
  if (resolved.error) {
    return emit({
      ok: false,
      error: resolved.error,
      message: "More than one Lily session has indexed documents. Rerun with --session <sessionId>.",
      sessions: resolved.sessions || [],
    }, 1);
  }
  const record = resolved.record;
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
    const terms = tokenize(withoutOptions(args).join(" "));
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
      "node query_document_index.cjs search \"query\" --session <sessionId>",
    ],
  }, 1);
}

try {
  main();
} catch (err) {
  emit({ ok: false, error: `${err?.name || "Error"}: ${err?.message || err}` }, 1);
}
