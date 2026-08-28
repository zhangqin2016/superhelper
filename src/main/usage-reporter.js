"use strict";

const pending = new Map();
const activeModels = new Map();
const retryReports = new Map();
const flushing = new Map();
const { randomUUID } = require("node:crypto");
const { localDateKey } = require("./local-date-key");

function mergeLocalSessionRecord(record) {
  try {
    require("./usage-local-store").mergeSessionRecord(record);
  } catch {
    // Local usage history is best-effort. Reporting must not fail when Electron
    // app paths are unavailable in pure Node tests or early bootstrap.
  }
}

function today() {
  return localDateKey();
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

function modelRef(model) {
  return typeof model === "string" ? { modelID: model } : model;
}

function ensure(sessionId, model = null) {
  const session = String(sessionId || "global");
  const ref = modelRef(model) || activeModels.get(session) || { modelID: activeModel() };
  const providerID = ref.providerID || "unknown";
  const key = JSON.stringify([providerID, ref.modelID || "unknown", today(), licenseId()]);
  const records = pending.get(session) || new Map();
  pending.set(session, records);
  const existing = records.get(key);
  if (existing) return existing;
  const record = {
    reportId: randomUUID(),
    date: today(),
    providerID,
    model: ref.modelID || "unknown",
    licenseId: licenseId(),
    messageCount: 0,
    imageCount: 0,
    toolCallCount: 0,
    pluginCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  records.set(key, record);
  return record;
}

function recordUserSend(sessionId, files = [], model = null) {
  const key = String(sessionId || "global");
  activeModels.set(key, modelRef(model) || { modelID: activeModel() });
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

function usageTokens(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const inputTokens =
    numberValue(entry.inputTokens) +
    numberValue(entry.input_tokens) +
    numberValue(entry.prompt_tokens);
  const outputTokens =
    numberValue(entry.outputTokens) +
    numberValue(entry.output_tokens) +
    numberValue(entry.completion_tokens);
  return { inputTokens, outputTokens };
}

function isUsageEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return (
    "inputTokens" in entry ||
    "outputTokens" in entry ||
    "input_tokens" in entry ||
    "output_tokens" in entry ||
    "prompt_tokens" in entry ||
    "completion_tokens" in entry ||
    "cacheReadInputTokens" in entry ||
    "cache_read_input_tokens" in entry ||
    "cacheCreationInputTokens" in entry ||
    "cache_creation_input_tokens" in entry
  );
}

function extractUsageTotals(usage = {}) {
  if (!usage || typeof usage !== "object") return { inputTokens: 0, outputTokens: 0 };
  if (isUsageEntry(usage)) return usageTokens(usage);

  const totals = { inputTokens: 0, outputTokens: 0 };
  for (const modelUsage of Object.values(usage)) {
    if (!isUsageEntry(modelUsage)) continue;
    const item = usageTokens(modelUsage);
    totals.inputTokens += item.inputTokens;
    totals.outputTokens += item.outputTokens;
  }
  return totals;
}

function recordModelUsage(sessionId, usage = {}, model = null) {
  const totals = extractUsageTotals(usage);
  const entries = isUsageEntry(usage) ? [[model, totals]]
    : Object.entries(usage || {}).filter(([, value]) => isUsageEntry(value)).map(([id, value]) => [id, usageTokens(value)]);
  for (const [ref, delta] of entries) {
    const bound = modelRef(model) || activeModels.get(String(sessionId || "global"));
    const target = typeof ref === "string" && bound?.modelID === ref ? bound : ref;
    const record = ensure(sessionId, target);
    record.inputTokens += delta.inputTokens;
    record.outputTokens += delta.outputTokens;
  }
  return totals;
}

async function flushBatch(key) {
  const records = [...(pending.get(key)?.values() || [])];
  pending.delete(key);
  const reports = retryReports.get(key) || [];
  retryReports.delete(key);
  for (const record of records) {
    if (!record.messageCount && !record.toolCallCount && !record.inputTokens && !record.outputTokens && !record.imageCount) continue;
    mergeLocalSessionRecord(record);
    reports.push(record);
  }
  let result = { ok: true, skipped: reports.length === 0 };
  for (const record of reports) {
    let sent;
    try { sent = await require("./service-client").reportUsage(record); }
    catch { sent = { ok: false, error: "USAGE_REPORT_FAILED" }; }
    if (!sent?.ok && sent?.error !== "NO_SERVICE_URL") {
      const retry = retryReports.get(key) || [];
      retry.push(record);
      retryReports.set(key, retry);
      result = sent || { ok: false, error: "USAGE_REPORT_FAILED" };
    }
  }
  if (!pending.has(key)) activeModels.delete(key);
  return result;
}

function flush(sessionId) {
  const key = String(sessionId || "global");
  const next = (flushing.get(key) || Promise.resolve()).catch(() => {}).then(() => flushBatch(key));
  flushing.set(key, next);
  return next.finally(() => { if (flushing.get(key) === next) flushing.delete(key); });
}

function getPendingTodayTotals() {
  const date = today();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    messageCount: 0,
  };
  for (const record of [...pending.values()].flatMap(records => [...records.values()])) {
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
  extractUsageTotals,
  flush,
  getPendingTodayTotals,
};
