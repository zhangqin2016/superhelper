import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildUsageSummary } = require("../src/main/usage-summary.js");
const { localDateKey } = require("../src/main/local-date-key.js");
function dayAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateKey(date);
}
const date = dayAgo(0);
const row = (providerID, model, inputTokens, outputTokens = 0, dateKey = date) =>
  ({ date: dateKey, providerID, model, inputTokens, outputTokens });
const total = (inputTokens, outputTokens = 0, dateKey = date) => ({ date: dateKey, inputTokens, outputTokens });
function assertBalanced(summary) {
  for (const day of [summary.today, ...summary.history]) {
    for (const field of ["inputTokens", "outputTokens", "messageCount"]) {
      assert.equal(day.models.reduce((n, model) => n + model[field], 0), day[field], `${day.date}/${field}`);
    }
  }
  assert.equal(summary.modelTotals.reduce((n, model) => n + model.totalTokens, 0), summary.rangeTotals.totalTokens);
}

test("daily detail and model totals preserve exact connections and merge pending once", () => {
  const summary = buildUsageSummary({
    days: [total(300, 30), total(50, 5, dayAgo(1))],
    byModel: [row("a", "same", 100, 10), row("b", "same", 200, 20), row("a", "same", 50, 5, dayAgo(1))],
    pendingUsage: [row("b", "same", 20, 2), row("c", "another", 10, 1)],
  });
  assert.equal(summary.today.totalTokens, 363);
  assert.equal(summary.modelTotals.length, 3);
  assert.equal(summary.modelTotals.find(r => r.providerID === "a").inputTokens, 150);
  assertBalanced(summary);
});

test("legacy totals become explicit unknown residuals without guessing a model", () => {
  const summary = buildUsageSummary({ days: [total(100, 20)], byModel: [row("a", "known", 40, 5)] });
  assert.equal(summary.today.models.find(r => r.model === "unknown").inputTokens, 60);
  assert.equal(summary.today.hasUnattributed, true);
  assertBalanced(summary);
  const inconsistent = buildUsageSummary({ days: [total(100)], byModel: [row("a", "known", 200)] });
  assert.equal(inconsistent.today.models.length, 1);
  assert.equal(inconsistent.today.models[0].model, "unknown");
  assertBalanced(inconsistent);
});

test("natural-day window excludes old/future rows and preserves pending dates at midnight", () => {
  const summary = buildUsageSummary({ historyDays: 30,
    days: [total(10, 0, dayAgo(29)), total(500, 0, dayAgo(30)), total(500, 0, dayAgo(-1))],
    pendingUsage: [row("a", "yesterday", 5, 0, dayAgo(1)), row("b", "today", 3)],
  });
  assert.equal(summary.rangeTotals.inputTokens, 18);
  assert.equal(summary.today.inputTokens, 3);
  assert.equal(summary.history.find(r => r.date === dayAgo(1)).models[0].model, "yesterday");
  assertBalanced(summary);
});

test("reference estimates retain sub-cent amounts and sum before rounding", () => {
  const summary = buildUsageSummary({ days: Array.from({ length: 30 }, (_, i) => total(1000, 0, dayAgo(i))) });
  assert.equal(summary.today.referenceCostRmb, 0.002);
  assert.equal(summary.rangeTotals.costRmb, 0.06);
  assert.equal(summary.pricing.kind, "reference");
  assertBalanced(summary);
});

test("malformed counts, prototype-like identities and duplicate detail cannot corrupt totals", () => {
  const summary = buildUsageSummary({
    days: [total("40", "4"), total(-10, Infinity), total(100, 0, "not-a-date")],
    byModel: [row("__proto__", "<img onerror=bad>", 20, 2), row("__proto__", "<img onerror=bad>", 20, 2)],
  });
  assert.equal(summary.today.totalTokens, 44);
  assert.equal(summary.modelTotals.length, 1);
  assertBalanced(summary);
});
