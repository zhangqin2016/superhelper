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

function daysMapFromList(days = []) {
  const map = {};
  for (const row of days) {
    if (!row?.date) continue;
    map[row.date] = {
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      messageCount: row.messageCount || 0,
      turnCount: row.turnCount || 0,
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
};
