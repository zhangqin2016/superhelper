"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");
const { DEFAULT_PRICING_ID } = require("./usage-cost-estimate");
const { buildUsageSummary, DEFAULT_HISTORY_DAYS } = require("./usage-summary");
const { localDateKey } = require("./local-date-key");

const SCHEMA_VERSION = 1;
const MAX_DAYS = 90;

/** @type {{ schemaVersion: number, pricingId: string, days: Record<string, DayRecord> } | null} */
let cached = null;

function today() {
  return localDateKey();
}

function storePath() {
  return userDataPath("usage-daily-local.json");
}

function emptyDay() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    messageCount: 0,
    turnCount: 0,
  };
}

function readStore() {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.days && typeof parsed.days === "object") {
      cached = {
        schemaVersion: SCHEMA_VERSION,
        pricingId: parsed.pricingId || DEFAULT_PRICING_ID,
        days: parsed.days,
      };
      return cached;
    }
  } catch {
    // fall through
  }
  cached = { schemaVersion: SCHEMA_VERSION, pricingId: DEFAULT_PRICING_ID, days: {} };
  return cached;
}

function writeStore() {
  const store = readStore();
  pruneOldDays(store);
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
}

function pruneOldDays(store) {
  const keys = Object.keys(store.days || {}).sort();
  while (keys.length > MAX_DAYS) {
    const oldest = keys.shift();
    if (oldest) delete store.days[oldest];
  }
}

function ensureDay(store, date) {
  if (!store.days[date]) store.days[date] = emptyDay();
  return store.days[date];
}

function addUsageDelta(delta = {}) {
  const date = String(delta.date || today());
  const store = readStore();
  const day = ensureDay(store, date);
  day.inputTokens += Math.max(0, Math.round(Number(delta.inputTokens) || 0));
  day.outputTokens += Math.max(0, Math.round(Number(delta.outputTokens) || 0));
  day.messageCount += Math.max(0, Math.round(Number(delta.messageCount) || 0));
  day.turnCount += Math.max(0, Math.round(Number(delta.turnCount) || 0));
  writeStore();
}

function mergeSessionRecord(record = {}) {
  if (!record || typeof record !== "object") return;
  addUsageDelta({
    date: record.date,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    messageCount: record.messageCount,
    turnCount: record.inputTokens || record.outputTokens || record.messageCount ? 1 : 0,
  });
}

function getUsageSummary({ historyDays = DEFAULT_HISTORY_DAYS, pendingToday = null } = {}) {
  const store = readStore();
  const todayKey = today();
  const days = [];
  for (const [date, day] of Object.entries(store.days || {})) {
    days.push({
      date,
      inputTokens: day.inputTokens || 0,
      outputTokens: day.outputTokens || 0,
      messageCount: day.messageCount || 0,
      turnCount: day.turnCount || 0,
    });
  }
  return buildUsageSummary({ days, historyDays, pendingToday });
}

function setPricingId(_pricingId) {
  return DEFAULT_PRICING_ID;
}

module.exports = {
  addUsageDelta,
  mergeSessionRecord,
  getUsageSummary,
  setPricingId,
  storePath,
};
