"use strict";

const { estimateCostRmb } = require("./usage-cost-estimate");
const { localDateKey } = require("./local-date-key");

/** Fixed estimate basis for user-facing cost display. */
const USAGE_PRICING_ID = "deepseek_x5";
const DEFAULT_HISTORY_DAYS = 30;

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
  const inputTokens = day.inputTokens || 0;
  const outputTokens = day.outputTokens || 0;
  const totalTokens = inputTokens + outputTokens;
  return {
    date,
    inputTokens,
    outputTokens,
    totalTokens,
    messageCount: day.messageCount || 0,
    turnCount: day.turnCount || 0,
    costRmb: estimateCostRmb(inputTokens, outputTokens, USAGE_PRICING_ID),
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
  for (const row of days) {
    if (!row?.date) continue;
    const date = normalizeUsageDateKey(row.date);
    if (!date) continue;
    const existing = map[date] || emptyDay();
    map[date] = {
      inputTokens: existing.inputTokens + (row.inputTokens || 0),
      outputTokens: existing.outputTokens + (row.outputTokens || 0),
      messageCount: existing.messageCount + (row.messageCount || 0),
      turnCount: existing.turnCount + (row.turnCount || 0),
    };
  }
  return map;
}

function buildUsageSummary({
  days = [],
  historyDays = DEFAULT_HISTORY_DAYS,
  pendingToday = null,
} = {}) {
  const daysMap = daysMapFromList(days);
  const todayKey = today();

  const mergedToday = { ...emptyDay(), ...(daysMap[todayKey] || {}) };
  if (pendingToday) {
    mergedToday.inputTokens += pendingToday.inputTokens || 0;
    mergedToday.outputTokens += pendingToday.outputTokens || 0;
    mergedToday.messageCount += pendingToday.messageCount || 0;
  }

  const todaySummary = daySummary(todayKey, mergedToday);

  const dayKeys = Object.keys(daysMap)
    .filter((key) => key !== todayKey)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, Math.max(0, historyDays - 1));

  const history = dayKeys.map((key) => daySummary(key, daysMap[key]));

  const rangeDays = [todaySummary, ...history];
  const rangeTotals = rangeDays.reduce(
    (acc, row) => {
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      acc.totalTokens += row.totalTokens;
      acc.messageCount += row.messageCount;
      acc.costRmb += row.costRmb;
      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      messageCount: 0,
      costRmb: 0,
    },
  );
  rangeTotals.costRmb = Math.round(rangeTotals.costRmb * 100) / 100;

  return {
    pricingId: USAGE_PRICING_ID,
    today: todaySummary,
    history,
    rangeTotals,
    historyDays,
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
