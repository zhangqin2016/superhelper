"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sessionSummariesDir } = require("./config");

const MAX_TEXT = 900;
const MAX_ITEMS = 10;

function safeFileName(sessionId) {
  return `${String(sessionId || "").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function summaryPath(sessionId) {
  try {
    return path.join(sessionSummariesDir(), safeFileName(sessionId));
  } catch {
    return null;
  }
}

function trimText(value, limit = MAX_TEXT) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function readSessionSummary(sessionId) {
  const filePath = summaryPath(sessionId);
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeSessionSummary(sessionId, summary) {
  const filePath = summaryPath(sessionId);
  if (!filePath) return false;
  fs.mkdirSync(sessionSummariesDir(), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), "utf8");
  return true;
}

function clearSessionSummary(sessionId) {
  const filePath = summaryPath(sessionId);
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // ignore
  }
}

function uniqueAppend(list, value, limit = MAX_ITEMS) {
  const text = trimText(value, MAX_TEXT);
  if (!text) return Array.isArray(list) ? list : [];
  const next = (Array.isArray(list) ? list : []).filter((item) => item !== text);
  next.push(text);
  return next.slice(-limit);
}

function formatSessionSummary(summary) {
  if (!summary || typeof summary !== "object") return "";
  const parts = [];
  if (summary.lastUserIntent) parts.push(`- Most recent user intent: ${trimText(summary.lastUserIntent)}`);
  if (summary.lastAssistantResult) parts.push(`- Most recent assistant result: ${trimText(summary.lastAssistantResult)}`);
  if (summary.pendingTask) parts.push(`- Incomplete/pending: ${trimText(summary.pendingTask)}`);
  if (Array.isArray(summary.recentUserIntents) && summary.recentUserIntents.length) {
    parts.push("- Recent user goals:");
    for (const item of summary.recentUserIntents.slice(-5)) parts.push(`  - ${trimText(item, 260)}`);
  }
  if (Array.isArray(summary.recentFiles) && summary.recentFiles.length) {
    parts.push(`- Recent files: ${summary.recentFiles.slice(-8).join(", ")}`);
  }
  return parts.join("\n");
}

function updateSessionSummaryFromRecord(sessionId, record) {
  if (!sessionId || !record) return null;
  const previous = readSessionSummary(sessionId) || {
    schemaVersion: 1,
    sessionId,
    turnCount: 0,
    recentUserIntents: [],
    recentFiles: [],
  };
  const userText = trimText(record.user?.text || "");
  const assistantText = trimText(record.assistantText || "");
  const fileNames = (record.fileChanges || [])
    .map((entry) => entry.fileName || entry.filePath)
    .filter(Boolean)
    .slice(-8);

  const next = {
    ...previous,
    schemaVersion: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    turnCount: Number(previous.turnCount || 0) + 1,
    lastUserIntent: userText || previous.lastUserIntent || "",
    lastAssistantResult: assistantText || previous.lastAssistantResult || "",
    recentUserIntents: uniqueAppend(previous.recentUserIntents, userText, MAX_ITEMS),
    recentFiles: [...new Set([...(previous.recentFiles || []), ...fileNames])].slice(-MAX_ITEMS),
    pendingTask: ["turn.failed", "turn.stalled", "turn.interrupted"].includes(record.terminal)
      ? userText || previous.pendingTask || ""
      : "",
  };
  writeSessionSummary(sessionId, next);
  return next;
}

module.exports = {
  clearSessionSummary,
  formatSessionSummary,
  readSessionSummary,
  updateSessionSummaryFromRecord,
};
