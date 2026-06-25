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

function appendEvidenceGap(list, gap, limit = 5) {
  if (!gap?.reason) return Array.isArray(list) ? list : [];
  const next = Array.isArray(list) ? list.filter((item) => item?.reason !== gap.reason || item?.userIntent !== gap.userIntent) : [];
  next.push(gap);
  return next.slice(-limit);
}

function appendTurnPointer(list, pointer, limit = 8) {
  if (!pointer?.turnId) return Array.isArray(list) ? list : [];
  const next = Array.isArray(list) ? list.filter((item) => item?.turnId !== pointer.turnId) : [];
  next.push(pointer);
  return next.slice(-limit);
}

function evidenceGapFromRecord(record) {
  const gate = record?.meta?.evidenceGate;
  if (!gate || gate.ok !== false || !gate.reason) return null;
  return {
    reason: trimText(gate.reason, 180),
    turnId: trimText(record.turnId || "", 120),
    userIntent: trimText(record.user?.text || "", 360),
    assistantPreview: trimText(record.assistantText || "", 360),
    at: new Date().toISOString(),
  };
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
  if (Array.isArray(summary.recentEvidenceGaps) && summary.recentEvidenceGaps.length) {
    parts.push("- Recent evidence gaps:");
    for (const gap of summary.recentEvidenceGaps.slice(-3)) {
      parts.push(`  - ${trimText(gap.reason, 180)}${gap.userIntent ? ` for: ${trimText(gap.userIntent, 220)}` : ""}`);
    }
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
  const evidenceGap = evidenceGapFromRecord(record);
  const promptChars = Number(record.meta?.engine?.promptChars || 0);
  const promptTokens = Number(record.meta?.engine?.estimatedPromptTokens || 0);
  const usageInputTokens = Number(
    record.usage?.input_tokens ??
      record.usage?.inputTokens ??
      record.usage?.prompt_tokens ??
      0,
  );
  const bestPromptTokens = Number.isFinite(usageInputTokens) && usageInputTokens > 0
    ? usageInputTokens
    : promptTokens;
  const turnPointer = record.turnId
    ? {
        turnId: trimText(record.turnId || "", 120),
        engineMessageId: trimText(record.engineMessageId || "", 160),
        terminal: trimText(record.terminal || "", 60),
        at: new Date().toISOString(),
      }
    : null;

  const next = {
    ...previous,
    schemaVersion: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    turnCount: Number(previous.turnCount || 0) + 1,
    lastTurnId: turnPointer?.turnId || previous.lastTurnId || "",
    lastEngineMessageId: turnPointer?.engineMessageId || previous.lastEngineMessageId || "",
    recentTurnPointers: turnPointer
      ? appendTurnPointer(previous.recentTurnPointers, turnPointer, 8)
      : (previous.recentTurnPointers || []),
    lastUserIntent: userText || previous.lastUserIntent || "",
    lastAssistantResult: assistantText || previous.lastAssistantResult || "",
    recentUserIntents: uniqueAppend(previous.recentUserIntents, userText, MAX_ITEMS),
    recentFiles: [...new Set([...(previous.recentFiles || []), ...fileNames])].slice(-MAX_ITEMS),
    recentEvidenceGaps: evidenceGap
      ? appendEvidenceGap(previous.recentEvidenceGaps, evidenceGap, 5)
      : (previous.recentEvidenceGaps || []),
    lastEvidenceGap: evidenceGap || previous.lastEvidenceGap || null,
    lastEnginePromptChars: Number.isFinite(promptChars) && promptChars > 0
      ? promptChars
      : Number(previous.lastEnginePromptChars || 0),
    lastEnginePromptTokens: Number.isFinite(bestPromptTokens) && bestPromptTokens > 0
      ? bestPromptTokens
      : Number(previous.lastEnginePromptTokens || 0),
    lastEnginePromptTokenSource: Number.isFinite(usageInputTokens) && usageInputTokens > 0
      ? "runtime_usage"
      : (
          Number.isFinite(promptTokens) && promptTokens > 0
            ? (record.meta?.engine?.estimatedPromptTokenSource || "estimated_provider_fallback")
            : previous.lastEnginePromptTokenSource || ""
        ),
    maxEnginePromptTokens: Math.max(
      Number(previous.maxEnginePromptTokens || 0),
      Number.isFinite(bestPromptTokens) ? bestPromptTokens : 0,
    ),
    pendingTask: ["turn.failed", "turn.stalled", "turn.interrupted"].includes(record.terminal)
      ? userText || previous.pendingTask || ""
      : "",
  };
  writeSessionSummary(sessionId, next);
  return next;
}

function markSessionCompacted(sessionId, details = {}) {
  if (!sessionId) return null;
  const previous = readSessionSummary(sessionId) || {
    schemaVersion: 1,
    sessionId,
    turnCount: 0,
    recentUserIntents: [],
    recentFiles: [],
  };
  const at = details.at || new Date().toISOString();
  const next = {
    ...previous,
    schemaVersion: 1,
    sessionId,
    updatedAt: at,
    lastCompactedAt: at,
    compactionCount: Number(previous.compactionCount || 0) + 1,
    contextEpoch: Number(previous.contextEpoch || 0) + 1,
    lastContextMemoryFingerprint: "",
    lastContextMemoryInjection: null,
    lastCompaction: {
      runtime: details.runtime || "unknown",
      mode: details.mode || "native",
      reason: details.reason || "",
      engineSessionId: trimText(details.engineSessionId || "", 160),
      summaryMessageId: trimText(details.summaryMessageId || "", 160),
      at,
    },
    lastCompactionFailedAt: "",
    lastCompactionFailure: null,
  };
  writeSessionSummary(sessionId, next);
  return next;
}

function markSessionCompactionFailed(sessionId, details = {}) {
  if (!sessionId) return null;
  const previous = readSessionSummary(sessionId) || {
    schemaVersion: 1,
    sessionId,
    turnCount: 0,
    recentUserIntents: [],
    recentFiles: [],
  };
  const at = details.at || new Date().toISOString();
  const errorMessage = trimText(details.error || details.message || "", 360);
  const next = {
    ...previous,
    schemaVersion: 1,
    sessionId,
    updatedAt: at,
    lastCompactionFailedAt: at,
    compactionFailureCount: Number(previous.compactionFailureCount || 0) + 1,
    lastCompactionFailure: {
      runtime: details.runtime || "unknown",
      mode: details.mode || "native",
      reason: details.reason || "",
      providerID: trimText(details.providerID || "", 120),
      modelID: trimText(details.modelID || "", 160),
      code: trimText(details.code || "", 80),
      error: errorMessage,
      at,
    },
  };
  writeSessionSummary(sessionId, next);
  return next;
}

function markContextMemoryInjected(sessionId, details = {}) {
  if (!sessionId || !details.fingerprint) return readSessionSummary(sessionId);
  const previous = readSessionSummary(sessionId) || {
    schemaVersion: 1,
    sessionId,
    turnCount: 0,
    recentUserIntents: [],
    recentFiles: [],
  };
  const at = details.at || new Date().toISOString();
  const next = {
    ...previous,
    schemaVersion: 1,
    sessionId,
    updatedAt: at,
    lastContextMemoryFingerprint: trimText(details.fingerprint, 128),
    lastContextMemoryInjection: {
      fingerprint: trimText(details.fingerprint, 128),
      itemCount: Number(details.itemCount || 0),
      totalChars: Number(details.totalChars || 0),
      contextEpoch: Number(previous.contextEpoch || 0),
      explanation: details.explanation || null,
      at,
    },
  };
  writeSessionSummary(sessionId, next);
  return next;
}

module.exports = {
  clearSessionSummary,
  evidenceGapFromRecord,
  formatSessionSummary,
  markContextMemoryInjected,
  markSessionCompactionFailed,
  markSessionCompacted,
  readSessionSummary,
  updateSessionSummaryFromRecord,
};
