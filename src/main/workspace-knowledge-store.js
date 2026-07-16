"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("./store/sqlite-db");

const SCHEMA_VERSION = 1;

function knowledgeRoot(rootDir) {
  if (rootDir) return path.join(rootDir, "knowledge");
  try {
    return require("./config").userDataPath("knowledge");
  } catch {
    return path.join(os.tmpdir(), "lily-knowledge");
  }
}

function realpathOrResolve(value) {
  const resolved = path.resolve(String(value || ""));
  try {
    return fs.realpathSync.native?.(resolved) || fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function workspaceKeyForPath(workspacePath) {
  const real = realpathOrResolve(workspacePath);
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
  return `ws_${hash}`;
}

function workspaceStoreDir(workspacePath, rootDir) {
  return path.join(knowledgeRoot(rootDir), "workspaces", workspaceKeyForPath(workspacePath));
}

function workspaceDbPath(workspacePath, rootDir) {
  return path.join(workspaceStoreDir(workspacePath, rootDir), "content.sqlite");
}

function registryPath(rootDir) {
  return path.join(knowledgeRoot(rootDir), "index-registry.json");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readIndexRegistry(rootDir) {
  const registry = readJson(registryPath(rootDir), null);
  if (!registry || typeof registry !== "object") {
    return { schemaVersion: SCHEMA_VERSION, indexes: {} };
  }
  return {
    schemaVersion: Number(registry.schemaVersion || SCHEMA_VERSION),
    indexes: registry.indexes && typeof registry.indexes === "object" ? registry.indexes : {},
  };
}

function registerIndexLocation(rootDir, location = {}) {
  if (!location.indexId || !location.workspaceKey || !location.dbPath) return;
  const registry = readIndexRegistry(rootDir);
  registry.indexes[location.indexId] = {
    indexId: location.indexId,
    workspaceKey: location.workspaceKey,
    workspacePath: location.workspacePath || "",
    dbPath: location.dbPath,
    sourcePath: location.sourcePath || "",
    updatedAt: new Date().toISOString(),
  };
  writeJson(registryPath(rootDir), registry);
}

function lookupIndexLocation(indexId, rootDir) {
  const id = String(indexId || "");
  if (!id) return null;
  return readIndexRegistry(rootDir).indexes[id] || null;
}

function encodeArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function decodeArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compactWhitespace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenize(value = "") {
  const text = String(value || "").toLowerCase();
  const words = text.match(/[\p{L}\p{N}_-]+/gu) || [];
  const tokens = new Set(words.filter((word) => word.length > 1));
  for (const word of words) {
    if (/[\u3400-\u9fff]/.test(word) && word.length > 1) {
      for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2));
    }
  }
  return [...tokens];
}

function escapeFtsTerm(term) {
  return `"${String(term || "").replace(/"/g, '""')}"`;
}

function buildFtsQuery(query) {
  const terms = tokenize(query);
  if (!terms.length) return "";
  return terms.slice(0, 32).map(escapeFtsTerm).join(" OR ");
}

function hydrateChunk(row = {}) {
  return {
    chunkId: row.chunk_id || "",
    sourcePath: row.source_path || "",
    sourceType: row.source_type || "",
    rangeType: row.range_type || "",
    rangeStart: Number(row.range_start || 0),
    rangeEnd: Number(row.range_end || 0),
    coverage: row.coverage || "",
    confidence: row.confidence || "",
    excerpt: row.excerpt || "",
    text: row.text || "",
    tokens: decodeArray(row.tokens_json),
    indexPolicy: row.index_policy || "",
    requiredPacks: decodeArray(row.required_packs_json),
    recommendedActions: decodeArray(row.recommended_actions_json),
  };
}

class WorkspaceKnowledgeStore {
  constructor({ workspacePath, rootDir } = {}) {
    if (!workspacePath) throw new Error("workspacePath required");
    this.workspacePath = realpathOrResolve(workspacePath);
    this.rootDir = rootDir || "";
    this.workspaceKey = workspaceKeyForPath(this.workspacePath);
    this.dbPath = workspaceDbPath(this.workspacePath, this.rootDir);
    this.db = openDatabase(this.dbPath);
    this._migrate();
  }

  _migrate() {
    this.db.migrate([
      (db) => {
        db.exec(`
          CREATE TABLE indexes (
            index_id       TEXT PRIMARY KEY,
            workspace_key  TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            source_path    TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            coverage       TEXT NOT NULL DEFAULT 'indexed',
            files_seen     INTEGER NOT NULL DEFAULT 0,
            files_indexed  INTEGER NOT NULL DEFAULT 0,
            files_skipped  INTEGER NOT NULL DEFAULT 0,
            skipped_json   TEXT NOT NULL DEFAULT '[]'
          );

          CREATE TABLE chunks (
            id                       INTEGER PRIMARY KEY,
            index_id                 TEXT NOT NULL,
            chunk_id                 TEXT NOT NULL UNIQUE,
            source_path              TEXT NOT NULL,
            source_type              TEXT NOT NULL,
            range_type               TEXT NOT NULL,
            range_start              INTEGER NOT NULL DEFAULT 0,
            range_end                INTEGER NOT NULL DEFAULT 0,
            coverage                 TEXT NOT NULL DEFAULT '',
            confidence               TEXT NOT NULL DEFAULT '',
            excerpt                  TEXT NOT NULL DEFAULT '',
            text                     TEXT NOT NULL DEFAULT '',
            tokens_json              TEXT NOT NULL DEFAULT '[]',
            search_text              TEXT NOT NULL DEFAULT '',
            index_policy             TEXT NOT NULL DEFAULT '',
            required_packs_json      TEXT NOT NULL DEFAULT '[]',
            recommended_actions_json TEXT NOT NULL DEFAULT '[]'
          );
          CREATE INDEX idx_chunks_index ON chunks(index_id);
          CREATE INDEX idx_chunks_source ON chunks(source_path);

          CREATE VIRTUAL TABLE chunks_fts USING fts5(
            search_text,
            content='chunks',
            content_rowid='id'
          );

          CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, search_text) VALUES (new.id, new.search_text);
          END;
          CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, search_text)
              VALUES('delete', old.id, old.search_text);
          END;
          CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, search_text)
              VALUES('delete', old.id, old.search_text);
            INSERT INTO chunks_fts(rowid, search_text) VALUES (new.id, new.search_text);
          END;
        `);
      },
    ]);
  }

  writeIndex(record = {}) {
    const indexId = String(record.indexId || "");
    if (!indexId) throw new Error("indexId required");
    const chunks = Array.isArray(record.chunks) ? record.chunks : [];
    const createdAt = record.createdAt || new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM chunks WHERE index_id = ?", indexId);
      this.db.run("DELETE FROM indexes WHERE index_id = ?", indexId);
      this.db.run(
        `INSERT INTO indexes (
          index_id, workspace_key, workspace_path, source_path, created_at,
          coverage, files_seen, files_indexed, files_skipped, skipped_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        indexId,
        this.workspaceKey,
        this.workspacePath,
        String(record.sourcePath || ""),
        createdAt,
        String(record.coverage || "indexed"),
        Number(record.filesSeen || 0),
        Number(record.filesIndexed || 0),
        Number(record.filesSkipped || 0),
        JSON.stringify(Array.isArray(record.skipped) ? record.skipped : []),
      );
      for (const chunk of chunks) {
        const tokens = Array.isArray(chunk.tokens) && chunk.tokens.length
          ? chunk.tokens
          : tokenize(`${chunk.sourcePath || ""} ${chunk.text || chunk.excerpt || ""}`);
        const searchText = compactWhitespace([
          chunk.sourcePath,
          path.basename(String(chunk.sourcePath || "")),
          chunk.sourceType,
          chunk.rangeType,
          chunk.excerpt,
          chunk.text,
          tokens.join(" "),
          chunk.indexPolicy,
          ...(Array.isArray(chunk.requiredPacks) ? chunk.requiredPacks : []),
          ...(Array.isArray(chunk.recommendedActions) ? chunk.recommendedActions : []),
        ].filter(Boolean).join(" "));
        this.db.run(
          `INSERT INTO chunks (
            index_id, chunk_id, source_path, source_type, range_type, range_start,
            range_end, coverage, confidence, excerpt, text, tokens_json,
            search_text, index_policy, required_packs_json, recommended_actions_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          indexId,
          String(chunk.chunkId || `${indexId}-chunk`),
          String(chunk.sourcePath || ""),
          String(chunk.sourceType || ""),
          String(chunk.rangeType || ""),
          Number(chunk.rangeStart || 0),
          Number(chunk.rangeEnd || 0),
          String(chunk.coverage || ""),
          String(chunk.confidence || ""),
          String(chunk.excerpt || ""),
          String(chunk.text || ""),
          encodeArray(tokens),
          searchText,
          String(chunk.indexPolicy || ""),
          encodeArray(chunk.requiredPacks),
          encodeArray(chunk.recommendedActions),
        );
      }
    });
    tx();
    registerIndexLocation(this.rootDir, {
      indexId,
      workspaceKey: this.workspaceKey,
      workspacePath: this.workspacePath,
      dbPath: this.dbPath,
      sourcePath: record.sourcePath || "",
    });
    return {
      ok: true,
      indexId,
      workspaceKey: this.workspaceKey,
      workspacePath: this.workspacePath,
      dbPath: this.dbPath,
      chunkCount: chunks.length,
    };
  }

  readIndex(indexId) {
    const index = this.db.get("SELECT * FROM indexes WHERE index_id = ?", String(indexId || ""));
    if (!index) {
      return { ok: false, error: "INDEX_UNAVAILABLE", workspaceKey: this.workspaceKey, indexId: String(indexId || "") };
    }
    const rows = this.db.all("SELECT * FROM chunks WHERE index_id = ? ORDER BY id", index.index_id);
    return {
      ok: true,
      coverage: index.coverage || "indexed",
      confidence: "exact",
      indexId: index.index_id,
      indexPath: this.dbPath,
      workspaceKey: this.workspaceKey,
      workspacePath: this.workspacePath,
      sourcePath: index.source_path,
      createdAt: index.created_at,
      filesSeen: Number(index.files_seen || 0),
      filesIndexed: Number(index.files_indexed || 0),
      filesSkipped: Number(index.files_skipped || 0),
      skipped: readJsonValue(index.skipped_json, []),
      chunks: rows.map(hydrateChunk),
    };
  }

  queryIndex({ indexId, query = "", limit = 8 } = {}) {
    const record = this.readIndex(indexId);
    if (!record.ok) return record;
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      return { ok: false, error: "EMPTY_QUERY", indexId: record.indexId, workspaceKey: this.workspaceKey };
    }
    const max = Math.max(1, Math.min(Number(limit || 8), 50));
    let rows = [];
    try {
      rows = this.db.all(
        `SELECT c.*, bm25(chunks_fts) AS rank
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
          WHERE chunks_fts MATCH ?
            AND c.index_id = ?
          ORDER BY rank ASC, c.chunk_id ASC
          LIMIT ?`,
        ftsQuery,
        record.indexId,
        max,
      );
    } catch {
      const terms = tokenize(query);
      rows = this.db.all(
        "SELECT * FROM chunks WHERE index_id = ? ORDER BY id",
        record.indexId,
      ).filter((row) => {
        const haystack = String(row.search_text || "").toLowerCase();
        return terms.some((term) => haystack.includes(term));
      }).slice(0, max);
    }
    let matches = rows.map((row) => {
      const chunk = hydrateChunk(row);
      return {
        score: typeof row.rank === "number" ? -row.rank : 1,
        chunkId: chunk.chunkId,
        sourcePath: chunk.sourcePath,
        sourceType: chunk.sourceType,
        rangeType: chunk.rangeType,
        rangeStart: chunk.rangeStart,
        rangeEnd: chunk.rangeEnd,
        coverage: chunk.coverage,
        confidence: chunk.confidence,
        excerpt: chunk.excerpt,
      };
    });
    let evicted = 0;
    // Freshness guard: never cite a chunk whose local source file was deleted.
    // Stale hits are dropped from the result AND evicted from the store. Default
    // on (a safety guarantee); kill switch LILY_WORKSPACE_INDEX_VERIFY=0. Fail-open.
    if (process.env.LILY_WORKSPACE_INDEX_VERIFY !== "0") {
      try {
        const { partitionMatchesByFreshness } = require("./workspace-index-freshness");
        const { fresh, stalePaths } = partitionMatchesByFreshness(matches, { workspacePath: this.workspacePath });
        if (stalePaths.length) {
          matches = fresh;
          try { evicted = this.evictSources(stalePaths); } catch { /* eviction best-effort */ }
        }
      } catch {
        // freshness helper unavailable — keep raw matches (fail-open)
      }
    }
    return {
      ok: true,
      coverage: record.coverage,
      confidence: "exact",
      indexId: record.indexId,
      indexPath: this.dbPath,
      workspaceKey: this.workspaceKey,
      workspacePath: this.workspacePath,
      sourcePath: record.sourcePath,
      ...(evicted ? { evictedStale: evicted } : {}),
      matches,
    };
  }

  // Remove all chunks for the given source paths (e.g. deleted files). The
  // chunks_ad trigger keeps the FTS mirror in sync. Returns rows removed.
  evictSources(sourcePaths = []) {
    const paths = [...new Set((Array.isArray(sourcePaths) ? sourcePaths : []).map((p) => String(p || "")).filter(Boolean))];
    if (!paths.length) return 0;
    let removed = 0;
    const tx = this.db.transaction(() => {
      for (const sp of paths) {
        const res = this.db.run("DELETE FROM chunks WHERE source_path = ?", sp);
        removed += Number(res?.changes || 0);
      }
    });
    tx();
    return removed;
  }

  close() {
    this.db.close();
  }
}

function readJsonValue(value, fallback) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function openWorkspaceKnowledgeStore(options = {}) {
  return new WorkspaceKnowledgeStore(options);
}

function openStoreForIndex(indexId, rootDir) {
  const location = lookupIndexLocation(indexId, rootDir);
  if (!location?.workspacePath) return null;
  return openWorkspaceKnowledgeStore({ workspacePath: location.workspacePath, rootDir });
}

module.exports = {
  openStoreForIndex,
  openWorkspaceKnowledgeStore,
  readIndexRegistry,
  registerIndexLocation,
  registryPath,
  workspaceDbPath,
  workspaceKeyForPath,
  workspaceStoreDir,
};
