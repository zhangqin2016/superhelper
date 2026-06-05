"use strict";

const pending = new Map();

function mergeLocalSessionRecord(record) {
  try {
    require("./usage-local-store").mergeSessionRecord(record);
  } catch {
    // Local usage history is best-effort. Reporting must not fail when Electron
    // app paths are unavailable in pure Node tests or early bootstrap.
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function activeModel() {
  try {
    const { getActivePresetEnv, getUserApiEnv } = require("./model-presets");
    const { normalizeToLilyEnv, pickModelId } = require("./agent-env");
    return pickModelId(normalizeToLilyEnv({ ...getActivePresetEnv(), ...getUserApiEnv() })) || "unknown";
  } catch {
    return "unknown";
  }
}

function licenseId() {
  try {
    const status = require("./license-manager").getLicenseStatus();
    return status?.license?.licenseId || null;
  } catch {
    return null;
  }
}

function ensure(sessionId) {
  const key = String(sessionId || "global");
  const existing = pending.get(key);
  if (existing) return existing;
  const record = {
    date: today(),
    model: activeModel(),
    licenseId: licenseId(),
    messageCount: 0,
    imageCount: 0,
    toolCallCount: 0,
    pluginCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  pending.set(key, record);
  return record;
}

function recordUserSend(sessionId, files = []) {
  const record = ensure(sessionId);
  record.messageCount += 1;
  record.imageCount += (files || []).filter((file) => file?.isImage).length;
}

function recordToolCall(sessionId, tool = {}) {
  const record = ensure(sessionId);
  record.toolCallCount += 1;
  if (String(tool.name || "").toLowerCase().includes("skill")) {
    record.pluginCallCount += 1;
  }
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function recordModelUsage(sessionId, usage = {}) {
  const record = ensure(sessionId);
  const models = usage && typeof usage === "object" ? Object.values(usage) : [];
  for (const modelUsage of models) {
    if (!modelUsage || typeof modelUsage !== "object") continue;
    record.inputTokens += numberValue(modelUsage.inputTokens);
    record.outputTokens += numberValue(modelUsage.outputTokens);
  }
}

async function flush(sessionId) {
  const key = String(sessionId || "global");
  const record = pending.get(key);
  if (!record) return { ok: true, skipped: true };
  pending.delete(key);
  if (
    record.messageCount === 0 &&
    record.imageCount === 0 &&
    record.toolCallCount === 0 &&
    record.pluginCallCount === 0 &&
    record.inputTokens === 0 &&
    record.outputTokens === 0
  ) {
    return { ok: true, skipped: true };
  }
  mergeLocalSessionRecord(record);
  const result = await require("./service-client").reportUsage(record);
  if (!result.ok && result.error !== "NO_SERVICE_URL") {
    pending.set(key, record);
  }
  return result;
}

function getPendingTodayTotals() {
  const date = today();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    messageCount: 0,
  };
  for (const record of pending.values()) {
    if (record.date !== date) continue;
    totals.inputTokens += record.inputTokens;
    totals.outputTokens += record.outputTokens;
    totals.messageCount += record.messageCount;
  }
  return totals;
}

module.exports = {
  recordUserSend,
  recordToolCall,
  recordModelUsage,
  flush,
  getPendingTodayTotals,
};
