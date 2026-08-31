"use strict";

const { DEFAULT_PRICING_ID, PRICING, estimateCostRmb } = require("./usage-cost-estimate");
const { localDateKey } = require("./local-date-key");

/** Fixed estimate basis for user-facing cost display. */
const USAGE_PRICING_ID = DEFAULT_PRICING_ID;
const DEFAULT_HISTORY_DAYS = 30;
const COUNTERS = ["inputTokens", "outputTokens", "messageCount", "turnCount"];

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function addCounters(target, source) {
  for (const field of COUNTERS) target[field] = count(target[field]) + count(source?.[field]);
  return target;
}

function today() {
  return localDateKey();
}

function emptyDay() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    messageCount: 0,
    turnCount: 0,
  };
}

function daySummary(date, day) {
  const inputTokens = count(day.inputTokens);
  const outputTokens = count(day.outputTokens);
  const totalTokens = inputTokens + outputTokens;
  const price = PRICING[USAGE_PRICING_ID];
  return {
    date,
    inputTokens,
    outputTokens,
    totalTokens,
    messageCount: count(day.messageCount),
    turnCount: count(day.turnCount),
    costRmb: estimateCostRmb(inputTokens, outputTokens, USAGE_PRICING_ID),
    referenceCostRmb: (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000,
  };
}

const DATE_MONTHS = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

function dateKeyFromDisplayString(value) {
  const match = String(value).match(/^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{4}))?/);
  if (!match || !DATE_MONTHS[match[1]]) return "";
  let year = match[3] ? Number(match[3]) : new Date().getFullYear();
  const month = DATE_MONTHS[match[1]];
  const day = String(Number(match[2])).padStart(2, "0");
  if (!match[3]) {
    const candidate = new Date(`${year}-${month}-${day}T00:00:00`);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (candidate > tomorrow) year -= 1;
  }
  return `${year}-${month}-${day}`;
}

function dateKeyFromDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeUsageDateKey(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const direct = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (direct) return direct[1];
    const display = dateKeyFromDisplayString(value);
    if (display) return display;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return dateKeyFromDate(date);
  }
  return String(value).slice(0, 10);
}

function daysMapFromList(days = []) {
  const map = {};
  for (const row of Array.isArray(days) ? days : []) {
    if (!row?.date) continue;
    const date = normalizeUsageDateKey(row.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T12:00:00`).getTime())) continue;
    const existing = map[date] || emptyDay();
    map[date] = addCounters(existing, row);
  }
  return map;
}

function mergeModels(rows) {
  const models = new Map();
  for (const row of rows) {
    if (!row || !COUNTERS.some(field => count(row[field]))) continue;
    const providerID = typeof row.providerID === "string" && row.providerID ? row.providerID : "unknown";
    const model = typeof row.model === "string" && row.model ? row.model : "unknown";
    const key = JSON.stringify([providerID, model]);
    const value = models.get(key) || { providerID, model, ...emptyDay() };
    models.set(key, addCounters(value, row));
  }
  return [...models.values()];
}

function reconcileModels(day, rows) {
  let models = mergeModels(rows);
  let totals = models.reduce(addCounters, emptyDay());
  // Detail is optional evidence, never a reason to change authoritative totals.
  if (COUNTERS.some(field => totals[field] > count(day[field]))) {
    models = [];
    totals = emptyDay();
  }
  const residual = Object.fromEntries(COUNTERS.map(field => [field, count(day[field]) - totals[field]]));
  return mergeModels([...models, { providerID: "unknown", model: "unknown", ...residual }]);
}

function modelSummary(row, totalTokens) {
  const summary = daySummary(row.date, row);
  return { ...row, ...summary, share: totalTokens > 0 ? summary.totalTokens / totalTokens : 0 };
}

function buildUsageSummary({
  days = [],
  historyDays = DEFAULT_HISTORY_DAYS,
  pendingToday = null,
  byModel = [],
  pendingUsage = [],
} = {}) {
  const daysMap = daysMapFromList(days);
  const todayKey = today();
  historyDays = Math.min(90, Math.max(1, count(historyDays) || DEFAULT_HISTORY_DAYS));
  const start = new Date();
  start.setDate(start.getDate() - historyDays + 1);
  const startDate = localDateKey(start);
  const pending = Array.isArray(pendingUsage) ? [...pendingUsage] : [];
  if (pendingToday) pending.push({ ...pendingToday, date: todayKey });
  const pendingDays = daysMapFromList(pending);
  const detail = (Array.isArray(byModel) ? byModel : []).filter(row => row?.date);
  const dates = [...new Set([todayKey, ...Object.keys(daysMap), ...Object.keys(pendingDays)])]
    .filter(key => key >= startDate && key <= todayKey).sort((a, b) => b.localeCompare(a));
  const rawModels = [];
  const rangeDays = dates.map(date => {
    const persisted = daysMap[date] || emptyDay();
    const models = mergeModels([
      ...reconcileModels(persisted, detail.filter(row => normalizeUsageDateKey(row.date) === date)),
      ...pending.filter(row => normalizeUsageDateKey(row?.date) === date),
    ]);
    const day = daySummary(date, addCounters({ ...persisted }, pendingDays[date]));
    rawModels.push(...models.map(row => ({ date, ...row })));
    return { ...day, models: models.map(row => modelSummary({ date, ...row }, day.totalTokens)),
      hasUnattributed: models.some(row => row.model === "unknown") };
  });
  const rangeTotals = rangeDays.reduce(
    (acc, row) => {
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      acc.totalTokens += row.totalTokens;
      acc.messageCount += row.messageCount;
      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      messageCount: 0,
    },
  );
  Object.assign(rangeTotals, daySummary(undefined, rangeTotals));
  delete rangeTotals.date;
  const price = PRICING[USAGE_PRICING_ID];

  return {
    pricingId: USAGE_PRICING_ID,
    pricing: { kind: "reference", currency: "CNY", inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion },
    today: rangeDays[0],
    history: rangeDays.slice(1),
    rangeTotals,
    historyDays,
    startDate,
    byModel: rawModels,
    modelTotals: mergeModels(rawModels).map(row => modelSummary(row, rangeTotals.totalTokens))
      .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model) || a.providerID.localeCompare(b.providerID)),
  };
}

module.exports = {
  USAGE_PRICING_ID,
  DEFAULT_HISTORY_DAYS,
  buildUsageSummary,
  daySummary,
  daysMapFromList,
  normalizeUsageDateKey,
};
