#!/usr/bin/env node
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const { buildUsageSummary, USAGE_PRICING_ID } = require(path.join(
  __dirname,
  "../src/main/usage-summary.js",
));
const { estimateCostRmb } = require(path.join(__dirname, "../src/main/usage-cost-estimate.js"));

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

const today = new Date().toISOString().slice(0, 10);
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

console.log("test-usage-summary: ok");
