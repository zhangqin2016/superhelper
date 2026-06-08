#!/usr/bin/env node
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const { buildUsageSummary, normalizeUsageDateKey, USAGE_PRICING_ID } = require(path.join(
  __dirname,
  "../src/main/usage-summary.js",
));
const { estimateCostRmb } = require(path.join(__dirname, "../src/main/usage-cost-estimate.js"));
const { localDateKey } = require(path.join(__dirname, "../src/main/local-date-key.js"));

if (USAGE_PRICING_ID !== "deepseek_x5") {
  throw new Error(`usage pricing must be deepseek_x5, got ${USAGE_PRICING_ID}`);
}

const summary = buildUsageSummary({
  days: [
    { date: "2026-06-04", inputTokens: 1_000_000, outputTokens: 500_000, messageCount: 3 },
    { date: "2026-06-03", inputTokens: 100_000, outputTokens: 50_000, messageCount: 1 },
  ],
  historyDays: 30,
  pendingToday: { inputTokens: 2000, outputTokens: 1000, messageCount: 1 },
});

const today = localDateKey();
if (summary.today.date !== today) {
  throw new Error(`today row date wrong: ${summary.today.date}`);
}
if (summary.today.inputTokens !== 2000 || summary.today.outputTokens !== 1000) {
  throw new Error(`pending today merge failed: ${JSON.stringify(summary.today)}`);
}

const expectedTodayCost = estimateCostRmb(2000, 1000, "deepseek_x5");
if (summary.today.costRmb !== expectedTodayCost) {
  throw new Error(`today cost ${summary.today.costRmb}, want ${expectedTodayCost}`);
}

if (summary.history.length !== 2) {
  throw new Error(`history length ${summary.history.length}, want 2`);
}

const dateSummary = buildUsageSummary({
  days: [
    { date: today, inputTokens: 100, outputTokens: 20, messageCount: 1 },
    { date: `${today}T00:00:00.000Z`, inputTokens: 30, outputTokens: 4, messageCount: 1 },
    { date: new Date(`${today}T00:00:00.000Z`), inputTokens: 5, outputTokens: 1, messageCount: 1 },
  ],
  pendingToday: { inputTokens: 2, outputTokens: 1, messageCount: 1 },
});

if (dateSummary.today.inputTokens !== 137 || dateSummary.today.outputTokens !== 26) {
  throw new Error(`today date normalization failed: ${JSON.stringify(dateSummary.today)}`);
}
if (dateSummary.history.some((row) => row.date === today)) {
  throw new Error(`today should not appear in history: ${JSON.stringify(dateSummary.history)}`);
}
if (normalizeUsageDateKey(`${today}T12:34:56.000Z`) !== today) {
  throw new Error("ISO usage date should normalize to YYYY-MM-DD");
}
const displayDate = new Date(`${today}T12:00:00`).toDateString().slice(0, 10);
if (normalizeUsageDateKey(displayDate) !== today) {
  throw new Error(`display usage date should normalize to today: ${displayDate}`);
}

console.log("test-usage-summary: ok");
