"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_LINES = 5000;

/** @type {Map<string, Map<string, {filePath: string, originalContent: string|null}>>} */
const pendingSnapshots = new Map();

/** @type {Map<string, Map<string, object>>} */
const capturedDiffs = new Map();

function isFileWriteTool(toolName) {
  return ["Write", "Edit", "MultiEdit"].includes(toolName);
}

function extractFilePath(toolName, input) {
  if (!input || typeof input !== "object") return null;
  return input.file_path || input.path || input.target_file || null;
}

function captureBeforeSnapshot(sessionId, toolId, toolName, input) {
  if (!isFileWriteTool(toolName)) return;
  const filePath = extractFilePath(toolName, input);
  if (!filePath) return;

  const { isTextFile } = require("./ipc-filetree");
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

function emitDiffForTool(sessionId, toolId, ctx) {
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
    diff = [{ type: "ctx", content: `[文件已修改，共 ${newLines.length} 行]` }];
  } else {
    diff = computeLineDiff(oldLines, newLines);
  }

  const adds = diff.filter((h) => h.type === "add").length;
  const dels = diff.filter((h) => h.type === "del").length;

  const diffEntry = { filePath, fileName, status, diff, originalContent, stats: { adds, dels } };

  if (!capturedDiffs.has(sessionId)) {
    capturedDiffs.set(sessionId, new Map());
  }
  capturedDiffs.get(sessionId).set(filePath, diffEntry);

  const { sendToRenderer } = require("./ipc-utils");
  sendToRenderer(ctx.mainWindow, "assistant:file-diff", { sessionId, ...diffEntry });
}

function computeLineDiff(oldLines, newLines) {
  const lcs = longestCommonSubsequence(oldLines, newLines);
  const result = [];
  let oi = 0;
  let ni = 0;

  for (const common of lcs) {
    while (oi < oldLines.length && oldLines[oi] !== common) {
      result.push({ type: "del", content: oldLines[oi] });
      oi++;
    }
    while (ni < newLines.length && newLines[ni] !== common) {
      result.push({ type: "add", content: newLines[ni] });
      ni++;
    }
    result.push({ type: "ctx", content: oldLines[oi] });
    oi++;
    ni++;
  }
  while (oi < oldLines.length) {
    result.push({ type: "del", content: oldLines[oi] });
    oi++;
  }
  while (ni < newLines.length) {
    result.push({ type: "add", content: newLines[ni] });
    ni++;
  }
  return result;
}

function longestCommonSubsequence(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

function clearDiffsForSession(sessionId) {
  pendingSnapshots.delete(sessionId);
  capturedDiffs.delete(sessionId);
}

function removeAcceptedDiff(sessionId, filePath) {
  const diffs = capturedDiffs.get(sessionId);
  if (!diffs) return false;
  return diffs.delete(filePath);
}

module.exports = {
  captureBeforeSnapshot,
  emitDiffForTool,
  clearDiffsForSession,
  removeAcceptedDiff,
  isFileWriteTool,
  extractFilePath,
};
