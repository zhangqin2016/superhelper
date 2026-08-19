"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { openDatabase } = require("../store/sqlite-db");

const MAX_QUERY_CHARS = 240;
const MAX_TOP_K = 20;
const databases = new Map();

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenize(value) {
  const text = compact(value).toLowerCase();
  const words = text.match(/[\p{L}\p{N}_-]+/gu) || [];
  const tokens = new Set(words.filter((word) => word.length > 1));
  for (const word of words) {
    if (!/[\u3400-\u9fff]/.test(word) || word.length < 2) continue;
    for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2));
  }
  return [...tokens].slice(0, 64);
}

function ftsQuery(query) {
  return tokenize(query).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function readManifest(packPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packPath, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function searchableText(item) {
  return tokenize([
    item.title,
    item.article,
    item.text,
    item.category,
    item.authority,
  ].filter(Boolean).join(" ")).join(" ");
}

async function buildSearchDatabase(packPath, onProgress) {
  const dbPath = path.join(packPath, "legal.sqlite");
  const db = openDatabase(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      article TEXT NOT NULL,
      text TEXT NOT NULL,
      source_path TEXT NOT NULL,
      category TEXT NOT NULL,
      verified TEXT NOT NULL,
      verified_note TEXT NOT NULL,
      authority TEXT NOT NULL,
      promulgated_at TEXT NOT NULL,
      effective_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
      article_id UNINDEXED,
      search_text
    );
    CREATE TABLE IF NOT EXISTS legal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const built = db.get("SELECT value FROM legal_meta WHERE key = 'built'")?.value === "1";
  if (!built) {
    db.exec("DELETE FROM articles_fts; DELETE FROM articles;");
    const file = path.join(packPath, "articles.jsonl");
    if (!fs.existsSync(file)) throw new Error("LEGAL_KB_ARTICLES_MISSING");
    const totalBytes = fs.statSync(file).size;
    const input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let readBytes = 0;
    let batch = [];
    const insertBatch = (items) => {
      const insert = db.transaction(() => {
        for (const item of items) {
        db.run(
          `INSERT INTO articles (id, title, article, text, source_path, category, verified, verified_note, authority, promulgated_at, effective_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          String(item.id || ""), String(item.title || ""), String(item.article || ""), String(item.text || ""),
          String(item.sourcePath || ""), String(item.category || ""), String(item.verified || "UNVERIFIED"),
          String(item.verifiedNote || ""), String(item.authority || ""), String(item.promulgatedAt || ""), String(item.effectiveAt || ""),
        );
        db.run("INSERT INTO articles_fts (article_id, search_text) VALUES (?, ?)", String(item.id || ""), searchableText(item));
        }
      }
      );
      insert();
    };
    for await (const line of lines) {
      readBytes += Buffer.byteLength(`${line}\n`, "utf8");
      if (!line.trim()) continue;
      batch.push(JSON.parse(line));
      if (batch.length >= 500) {
        insertBatch(batch);
        batch = [];
        if (typeof onProgress === "function") onProgress({ phase: "indexing", writtenBytes: readBytes, totalBytes });
      }
    }
    if (batch.length) insertBatch(batch);
    db.run("INSERT OR REPLACE INTO legal_meta (key, value) VALUES ('built', '1')");
  }
  return db;
}

async function getDatabase(packPath, onProgress) {
  const key = path.resolve(packPath);
  if (!databases.has(key)) databases.set(key, buildSearchDatabase(key, onProgress));
  try {
    return await databases.get(key);
  } catch (error) {
    databases.delete(key);
    throw error;
  }
}

async function searchLegalKnowledge({ packPath, query, topK = 8, onProgress } = {}) {
  const text = compact(query);
  if (!text) return { ok: false, error: "LEGAL_KB_QUERY_REQUIRED", results: [] };
  if (text.length > MAX_QUERY_CHARS) return { ok: false, error: "LEGAL_KB_QUERY_TOO_LONG", results: [] };
  if (!packPath || !fs.existsSync(packPath)) return { ok: false, error: "LEGAL_KB_NOT_READY", results: [] };
  const manifest = readManifest(packPath);
  if (!manifest?.contentVersion) return { ok: false, error: "LEGAL_KB_MANIFEST_INVALID", results: [] };
  const db = await getDatabase(packPath, onProgress);
  const limit = Math.max(1, Math.min(MAX_TOP_K, Number(topK) || 8));
  const match = ftsQuery(text);
  if (!match) return { ok: false, error: "LEGAL_KB_QUERY_REQUIRED", results: [] };
  let rows = db.all(
    `SELECT a.*, bm25(articles_fts) AS score
     FROM articles_fts JOIN articles a ON a.id = articles_fts.article_id
     WHERE articles_fts MATCH ? ORDER BY score LIMIT ?`,
    match, Math.max(limit * 4, 20),
  );
  if (!rows.length) {
    rows = db.all(
      `SELECT *, 0 AS score FROM articles WHERE title LIKE ? OR article LIKE ? OR text LIKE ? LIMIT ?`,
      `%${text}%`, `%${text}%`, `%${text}%`, limit,
    );
  }
  const exact = rows.filter((row) => {
    const haystack = `${row.title || ""}${row.article || ""}${row.text || ""}`;
    return haystack.includes(text);
  });
  if (exact.length) rows = exact;
  rows = rows.slice(0, limit);
  return {
    ok: true,
    packVersion: String(manifest.contentVersion),
    results: rows.map((row) => ({
      id: row.id,
      title: row.title,
      article: row.article,
      excerpt: compact(row.text).slice(0, 800),
      sourcePath: row.source_path,
      category: row.category,
      verified: row.verified,
      verifiedNote: row.verified_note,
      authority: row.authority,
      promulgatedAt: row.promulgated_at,
      effectiveAt: row.effective_at,
      score: Number(row.score || 0),
    })),
  };
}

function closeLegalKnowledgeSearch(packPath = "") {
  const key = path.resolve(packPath);
  const dbPromise = databases.get(key);
  databases.delete(key);
  if (dbPromise) void dbPromise.then((db) => db.close()).catch(() => {});
}

async function prepareLegalKnowledgeSearch(packPath, onProgress) {
  await getDatabase(packPath, onProgress);
  return { ok: true, packPath };
}

module.exports = { searchLegalKnowledge, prepareLegalKnowledgeSearch, closeLegalKnowledgeSearch, tokenize };
