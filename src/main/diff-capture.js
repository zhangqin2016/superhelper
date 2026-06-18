"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Diff = require("diff");
const { isTextFile } = require("./file-kinds");

const MAX_LINES = 5000;

/** @type {Map<string, Map<string, {filePath: string, originalContent: string|null}>>} */
const pendingSnapshots = new Map();

/** @type {Map<string, Map<string, Map<string, object>>>} sessionId -> turnId -> filePath -> entry */
const capturedDiffs = new Map();

function isFileWriteTool(toolName) {
  return ["Write", "Edit", "MultiEdit"].includes(toolName);
}

function extractFilePath(toolName, input) {
  if (!input || typeof input !== "object") return null;
  return input.file_path || input.path || input.target_file || null;
}

function ensureTurnMap(sessionId, turnId) {
  if (!capturedDiffs.has(sessionId)) {
    capturedDiffs.set(sessionId, new Map());
  }
  const sessionTurns = capturedDiffs.get(sessionId);
  if (!sessionTurns.has(turnId)) {
    sessionTurns.set(turnId, new Map());
  }
  return sessionTurns.get(turnId);
}

function captureBeforeSnapshot(sessionId, toolId, toolName, input) {
  if (!isFileWriteTool(toolName)) return;
  const filePath = extractFilePath(toolName, input);
  if (!filePath) return;

  if (!isTextFile(filePath)) return;

  let originalContent = null;
  try {
    if (fs.existsSync(filePath)) {
      originalContent = fs.readFileSync(filePath, "utf-8");
    }
  } catch {
    // 读取失败，视为新文件
  }

  if (!pendingSnapshots.has(sessionId)) {
    pendingSnapshots.set(sessionId, new Map());
  }
  pendingSnapshots.get(sessionId).set(toolId, { filePath, originalContent });
}

function emitDiffForTool(sessionId, toolId, ctx, turnId = null) {
  const sessionSnapshots = pendingSnapshots.get(sessionId);
  if (!sessionSnapshots) return;
  const snapshot = sessionSnapshots.get(toolId);
  if (!snapshot) return;
  sessionSnapshots.delete(toolId);

  const { filePath, originalContent } = snapshot;
  if (!filePath) return;

  let newContent = null;
  try {
    if (fs.existsSync(filePath)) {
      newContent = fs.readFileSync(filePath, "utf-8");
    }
  } catch {
    return;
  }
  if (newContent == null && originalContent == null) return;
  if (newContent === originalContent) return;

  const fileName = path.basename(filePath);
  const status = originalContent == null ? "added" : "modified";

  const oldLines = (originalContent || "").split("\n");
  const newLines = (newContent || "").split("\n");
  let diff;
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) {
    diff = [{ type: "ctx", content: `[File modified, ${newLines.length} lines total]` }];
  } else {
    diff = computeLineDiff(oldLines, newLines);
  }

  const adds = diff.filter((h) => h.type === "add").length;
  const dels = diff.filter((h) => h.type === "del").length;

  const resolvedTurnId = turnId ? String(turnId) : "_orphan";
  // Several edits to one file in a turn must keep the FIRST before-state so
  // revert restores the turn checkpoint, not a mid-turn snapshot. The diff
  // itself still shows the latest change.
  const turnMap = ensureTurnMap(sessionId, resolvedTurnId);
  const existing = turnMap.get(filePath);
  const checkpointContent = existing ? existing.originalContent : originalContent;
  const diffEntry = {
    turnId: resolvedTurnId,
    toolId,
    filePath,
    fileName,
    status: existing?.status === "added" ? "added" : status,
    diff,
    originalContent: checkpointContent,
    stats: { adds, dels },
  };

  turnMap.set(filePath, diffEntry);

  const { sendToRenderer } = require("./ipc-utils");
  sendToRenderer(ctx.mainWindow, "assistant:file-diff", { sessionId, ...diffEntry });
}

function getDiffsForTurn(sessionId, turnId) {
  if (!sessionId || !turnId) return [];
  const turnMap = capturedDiffs.get(sessionId)?.get(String(turnId));
  if (!turnMap) return [];
  return [...turnMap.values()];
}

// Myers diff via jsdiff (O(nd)) — replaces a hand-rolled O(m·n) DP LCS whose
// dp matrix was ~25M cells at the 5000-line cap. Output shape is preserved:
// an ordered list of { type: "del" | "add" | "ctx", content } per line.
function computeLineDiff(oldLines, newLines) {
  const result = [];
  for (const part of Diff.diffArrays(oldLines, newLines)) {
    const type = part.added ? "add" : part.removed ? "del" : "ctx";
    for (const content of part.value) result.push({ type, content });
  }
  return result;
}

function clearDiffsForSession(sessionId) {
  pendingSnapshots.delete(sessionId);
  capturedDiffs.delete(sessionId);
}

/**
 * Authoritative lookup for a captured diff by session + file. IPC handlers use
 * this instead of trusting renderer-supplied originalContent/status — the
 * renderer's copy of a diff is display state, not authority.
 */
function findDiffEntry(sessionId, filePath) {
  const sessionTurns = capturedDiffs.get(sessionId);
  if (!sessionTurns) return null;
  let found = null;
  for (const turnMap of sessionTurns.values()) {
    if (turnMap.has(filePath)) found = turnMap.get(filePath); // latest turn wins
  }
  return found;
}

function removeAcceptedDiff(sessionId, filePath) {
  const sessionTurns = capturedDiffs.get(sessionId);
  if (!sessionTurns) return false;
  for (const turnMap of sessionTurns.values()) {
    if (turnMap.delete(filePath)) return true;
  }
  return false;
}

/** Pre-revert file contents per session+turn so a revert can be undone. */
const revertStash = new Map();

/**
 * Restore every file the turn touched to its checkpoint state (the content
 * captured before the turn's first write). Added files are deleted. Reports
 * per-file results instead of failing the whole revert on one error.
 * The pre-revert state is stashed so undoRevertTurn can restore it.
 */
function revertTurnChanges(sessionId, turnId, options = {}) {
  const entries = getDiffsForTurn(sessionId, turnId);
  const results = [];
  const stash = [];
  for (const entry of entries) {
    try {
      const targetPath = options.resolvePath ? options.resolvePath(entry.filePath) : entry.filePath;
      if (!targetPath) {
        results.push({ filePath: entry.filePath, ok: false, error: "PATH_OUTSIDE_PROJECT" });
        continue;
      }
      const current = fs.existsSync(targetPath)
        ? fs.readFileSync(targetPath, "utf-8")
        : null;
      if (entry.originalContent == null) {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      } else {
        fs.writeFileSync(targetPath, entry.originalContent, "utf-8");
      }
      stash.push({ filePath: entry.filePath, content: current });
      removeAcceptedDiff(sessionId, entry.filePath);
      results.push({ filePath: entry.filePath, ok: true });
    } catch (error) {
      results.push({ filePath: entry.filePath, ok: false, error: String(error?.message || error) });
    }
  }
  if (stash.length) {
    if (!revertStash.has(sessionId)) revertStash.set(sessionId, new Map());
    revertStash.get(sessionId).set(String(turnId), stash);
  }
  return results;
}

/** Undo a previous revertTurnChanges: write the stashed pre-revert contents
 * back (a stashed null means the file had been created by the turn — recreate
 * is the undo). One-shot: the stash entry is consumed. */
function undoRevertTurn(sessionId, turnId, options = {}) {
  const stash = revertStash.get(sessionId)?.get(String(turnId));
  if (!stash) return { ok: false, error: "NOTHING_TO_UNDO", results: [] };
  const results = [];
  for (const item of stash) {
    try {
      const targetPath = options.resolvePath ? options.resolvePath(item.filePath) : item.filePath;
      if (!targetPath) {
        results.push({ filePath: item.filePath, ok: false, error: "PATH_OUTSIDE_PROJECT" });
        continue;
      }
      if (item.content == null) {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      } else {
        fs.writeFileSync(targetPath, item.content, "utf-8");
      }
      results.push({ filePath: item.filePath, ok: true });
    } catch (error) {
      results.push({ filePath: item.filePath, ok: false, error: String(error?.message || error) });
    }
  }
  revertStash.get(sessionId).delete(String(turnId));
  return { ok: results.every((item) => item.ok), results };
}

module.exports = {
  captureBeforeSnapshot,
  emitDiffForTool,
  clearDiffsForSession,
  findDiffEntry,
  removeAcceptedDiff,
  revertTurnChanges,
  undoRevertTurn,
  getDiffsForTurn,
  isFileWriteTool,
  extractFilePath,
};
