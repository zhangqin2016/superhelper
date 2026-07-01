"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  inspectPath,
} = require("./file-intelligence-core");
const {
  openStoreForIndex,
  openWorkspaceKnowledgeStore,
} = require("../workspace-knowledge-store");

const DEFAULT_CHUNK_LINE_COUNT = 80;
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_QUERY_LIMIT = 8;

function defaultStoreRoot() {
  try {
    return require("../config").userDataPath("file-intelligence-indexes");
  } catch {
    return path.join(os.tmpdir(), "lily-file-intelligence-indexes");
  }
}

function safeId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160) || "index";
}

function compactWhitespace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function excerpt(value = "", limit = 500) {
  const text = compactWhitespace(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function fail(error, detail = {}) {
  return { ok: false, error, coverage: "failed", confidence: "exact", ...detail };
}

function reportProgress(onProgress, event = {}) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress({
      ...event,
      ts: Date.now(),
    });
  } catch {
    // Observability is best-effort; never let UI progress reporting break indexing.
  }
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

function indexRecordPath(storeRoot, indexId) {
  return path.join(storeRoot || defaultStoreRoot(), `${safeId(indexId)}.json`);
}

function readTextFile(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) return null;
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function candidateFiles(rootPath, opts = {}) {
  const maxFiles = Math.max(1, Number(opts.maxFiles || DEFAULT_MAX_FILES));
  const out = [];
  const queue = [rootPath];
  while (queue.length && out.length < maxFiles) {
    const current = queue.shift();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(current).sort();
      } catch {
        entries = [];
      }
      for (const name of entries) {
        if (name === "node_modules" || name === ".git" || name === "dist" || name === "release") continue;
        queue.push(path.join(current, name));
      }
    } else if (stat.isFile()) {
      out.push(current);
    }
  }
  return out;
}

function chunksForText(filePath, text, linesPerChunk) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const chunks = [];
  for (let start = 1; start <= lines.length; start += linesPerChunk) {
    const end = Math.min(lines.length, start + linesPerChunk - 1);
    const raw = lines.slice(start - 1, end).join("\n").trim();
    if (!raw) continue;
    chunks.push({
      chunkId: "",
      sourcePath: filePath,
      sourceType: "text",
      rangeType: "lines",
      rangeStart: start,
      rangeEnd: end,
      coverage: "indexed",
      confidence: "exact",
      excerpt: excerpt(raw),
      text: raw,
      tokens: tokenize(`${path.basename(filePath)} ${raw}`),
    });
  }
  return chunks;
}

function isMetadataIndexable(info = {}) {
  return ["pdf", "spreadsheet", "document", "presentation", "image", "video", "audio"].includes(info.kind);
}

function chunksForMetadata(info = {}) {
  const requiredPacks = Array.isArray(info.requiredPacks) ? info.requiredPacks : [];
  const recommendedActions = Array.isArray(info.recommendedActions) ? info.recommendedActions : [];
  const image = info.image ? ` image=${JSON.stringify(info.image)}` : "";
  const detail = [
    `File: ${path.basename(info.sourcePath || "")}`,
    `Type: ${info.kind || "unknown"}`,
    `Size: ${info.byteSize || 0} bytes`,
    info.indexPolicy ? `Index policy: ${info.indexPolicy}` : "",
    requiredPacks.length ? `Dependency packs: ${requiredPacks.join(", ")}` : "",
    recommendedActions.length ? `Recommended actions: ${recommendedActions.join(", ")}` : "",
    image,
  ].filter(Boolean).join("\n");
  return [{
    chunkId: "",
    sourcePath: info.sourcePath || "",
    sourceType: info.kind || "unknown",
    rangeType: "metadata",
    rangeStart: 1,
    rangeEnd: 1,
    coverage: "metadata-indexed",
    confidence: "exact",
    excerpt: excerpt(detail),
    text: detail,
    indexPolicy: info.indexPolicy || "",
    requiredPacks,
    recommendedActions,
    tokens: tokenize(`${path.basename(info.sourcePath || "")} ${info.kind || ""} ${info.indexPolicy || ""} ${requiredPacks.join(" ")} ${recommendedActions.join(" ")}`),
  }];
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function indexPath(input = {}) {
  const root = path.resolve(String(input.path || ""));
  if (!root) return fail("PATH_REQUIRED");
  const legacyStoreRoot = input.storeRoot || defaultStoreRoot();
  const workspaceStoreRoot = input.storeRoot || "";
  let rootIsFile = false;
  try {
    rootIsFile = fs.statSync(root).isFile();
  } catch {
    rootIsFile = false;
  }
  const workspacePath = input.workspacePath
    ? path.resolve(String(input.workspacePath))
    : (rootIsFile ? path.dirname(root) : root);
  const linesPerChunk = Math.max(1, Math.min(Number(input.chunkLineCount || DEFAULT_CHUNK_LINE_COUNT), 500));
  const maxFileBytes = Math.max(1024, Number(input.maxFileBytes || DEFAULT_MAX_FILE_BYTES));
  const files = candidateFiles(root, input);
  const chunks = [];
  const skipped = [];
  const onProgress = input.onProgress;
  let processed = 0;
  reportProgress(onProgress, {
    phase: "started",
    sourcePath: root,
    total: files.length,
    processed,
  });
  for (const file of files) {
    const info = inspectPath({ path: file });
    if (!info.ok) {
      processed += 1;
      const item = { sourcePath: file, reason: info.error || `unsupported kind ${info.kind || "unknown"}` };
      skipped.push(item);
      reportProgress(onProgress, {
        phase: "file-skipped",
        sourcePath: file,
        reason: item.reason,
        total: files.length,
        processed,
      });
      continue;
    }
    if (isMetadataIndexable(info)) {
      const fileChunks = chunksForMetadata(info);
      chunks.push(...fileChunks);
      processed += 1;
      reportProgress(onProgress, {
        phase: "file-indexed",
        sourcePath: file,
        sourceType: info.kind,
        indexPolicy: info.indexPolicy || "",
        chunkCount: fileChunks.length,
        total: files.length,
        processed,
      });
      continue;
    }
    if (info.kind !== "text") {
      processed += 1;
      const item = { sourcePath: file, reason: info.error || `unsupported kind ${info.kind || "unknown"}` };
      skipped.push(item);
      reportProgress(onProgress, {
        phase: "file-skipped",
        sourcePath: file,
        reason: item.reason,
        total: files.length,
        processed,
      });
      continue;
    }
    const text = readTextFile(file, maxFileBytes);
    if (text == null) {
      processed += 1;
      const item = { sourcePath: file, reason: "too large or binary for Phase 2 text index" };
      skipped.push(item);
      reportProgress(onProgress, {
        phase: "file-skipped",
        sourcePath: file,
        reason: item.reason,
        total: files.length,
        processed,
      });
      continue;
    }
    const fileChunks = chunksForText(file, text, linesPerChunk);
    chunks.push(...fileChunks);
    processed += 1;
    reportProgress(onProgress, {
      phase: "file-indexed",
      sourcePath: file,
      sourceType: "text",
      chunkCount: fileChunks.length,
      total: files.length,
      processed,
    });
  }
  if (!chunks.length) {
    reportProgress(onProgress, {
      phase: "done",
      sourcePath: root,
      total: files.length,
      processed,
      filesIndexed: 0,
      filesSkipped: skipped.length,
      error: "NO_INDEXABLE_CONTENT",
    });
    return fail("NO_INDEXABLE_CONTENT", {
      sourcePath: root,
      filesSeen: files.length,
      filesSkipped: skipped.length,
      skipped: skipped.slice(0, 20),
    });
  }
  const hash = crypto.createHash("sha256");
  hash.update(root);
  hash.update(String(Date.now()));
  const indexId = safeId(`idx_${hash.digest("hex").slice(0, 16)}`);
  chunks.forEach((chunk, index) => { chunk.chunkId = `${indexId}-chunk${index + 1}`; });
  const record = {
    schemaVersion: 1,
    indexId,
    createdAt: new Date().toISOString(),
    sourcePath: root,
    coverage: "indexed",
    filesSeen: files.length,
    filesIndexed: new Set(chunks.map((chunk) => chunk.sourcePath)).size,
    filesSkipped: skipped.length,
    skipped,
    chunks,
  };
  let file = indexRecordPath(legacyStoreRoot, indexId);
  let workspaceResult = null;
  try {
    const store = openWorkspaceKnowledgeStore({ workspacePath, rootDir: workspaceStoreRoot });
    try {
      workspaceResult = store.writeIndex(record);
      file = store.dbPath;
    } finally {
      store.close();
    }
  } catch (err) {
    record.workspaceIndexError = err?.message || String(err);
    writeJson(file, record);
  }
  reportProgress(onProgress, {
    phase: "done",
    sourcePath: root,
    total: files.length,
    processed,
    filesIndexed: record.filesIndexed,
    filesSkipped: record.filesSkipped,
    chunkCount: chunks.length,
    indexId,
  });
  return {
    ok: true,
    coverage: "indexed",
    confidence: "exact",
    indexId,
    indexPath: file,
    workspaceKey: workspaceResult?.workspaceKey || "",
    workspaceDbPath: workspaceResult?.dbPath || "",
    sourcePath: root,
    filesSeen: record.filesSeen,
    filesIndexed: record.filesIndexed,
    filesSkipped: record.filesSkipped,
    chunkCount: chunks.length,
    skipped: skipped.slice(0, 20),
  };
}

function readIndex(input = {}) {
  const legacyStoreRoot = input.storeRoot || defaultStoreRoot();
  const workspaceStoreRoot = input.storeRoot || "";
  if (input.indexId) {
    let store = null;
    try {
      store = openStoreForIndex(input.indexId, workspaceStoreRoot);
      if (store) {
        try {
          return store.readIndex(input.indexId);
        } finally {
          store.close();
        }
      }
    } catch {
      if (store) {
        try { store.close(); } catch { /* noop */ }
      }
    }
  }
  const file = input.indexPath || indexRecordPath(legacyStoreRoot, input.indexId);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!record?.indexId || !Array.isArray(record.chunks)) return fail("INDEX_INVALID", { indexPath: file });
    return { ok: true, coverage: "indexed", confidence: "exact", indexPath: file, ...record };
  } catch (err) {
    return fail("INDEX_UNAVAILABLE", { indexPath: file, message: err?.message || String(err) });
  }
}

function scoreChunk(chunk, terms) {
  const haystack = new Set(Array.isArray(chunk.tokens) ? chunk.tokens : tokenize(`${chunk.sourcePath} ${chunk.text || chunk.excerpt || ""}`));
  let score = 0;
  for (const term of terms) {
    if (haystack.has(term)) score += term.length > 3 ? 2 : 1;
    else if (String(chunk.excerpt || "").toLowerCase().includes(term)) score += 1;
  }
  return score;
}

function queryIndex(input = {}) {
  const workspaceStoreRoot = input.storeRoot || "";
  if (input.indexId) {
    let store = null;
    try {
      store = openStoreForIndex(input.indexId, workspaceStoreRoot);
      if (store) {
        try {
          return store.queryIndex(input);
        } finally {
          store.close();
        }
      }
    } catch {
      if (store) {
        try { store.close(); } catch { /* noop */ }
      }
    }
  }
  const record = readIndex(input);
  if (!record.ok) return record;
  const terms = tokenize(input.query || "");
  if (!terms.length) return fail("EMPTY_QUERY", { indexId: record.indexId });
  const limit = Math.max(1, Math.min(Number(input.limit || DEFAULT_QUERY_LIMIT), 50));
  const scored = [];
  for (const chunk of record.chunks) {
    const score = scoreChunk(chunk, terms);
    if (score > 0) scored.push({ score, chunk });
  }
  scored.sort((a, b) => b.score - a.score || String(a.chunk.chunkId).localeCompare(String(b.chunk.chunkId)));
  return {
    ok: true,
    coverage: "indexed",
    confidence: "exact",
    indexId: record.indexId,
    sourcePath: record.sourcePath,
    matches: scored.slice(0, limit).map(({ score, chunk }) => ({
      score,
      chunkId: chunk.chunkId,
      sourcePath: chunk.sourcePath,
      sourceType: chunk.sourceType,
      rangeType: chunk.rangeType,
      rangeStart: chunk.rangeStart,
      rangeEnd: chunk.rangeEnd,
      coverage: chunk.coverage,
      confidence: chunk.confidence,
      excerpt: chunk.excerpt,
    })),
  };
}

module.exports = {
  indexPath,
  queryIndex,
  readIndex,
};
