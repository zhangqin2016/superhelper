#!/usr/bin/env node
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const { estimateCostRmb, PRICING } = require(path.join(__dirname, "../src/main/usage-cost-estimate.js"));

// Qwen Plus: ¥0.8/M in, ¥2/M out
const qwenCost = estimateCostRmb(1_000_000, 500_000, "qwen_plus");
const qwenExpected = PRICING.qwen_plus.inputPerMillion + PRICING.qwen_plus.outputPerMillion * 0.5;
if (qwenCost !== qwenExpected) {
  throw new Error(`qwen_plus cost ${qwenCost}, want ${qwenExpected}`);
}

// DeepSeek standard reference: ¥2/M in, ¥8/M out
const dsCost = estimateCostRmb(100_000, 200_000, "deepseek_standard");
const dsExpected =
  (100_000 / 1_000_000) * PRICING.deepseek_standard.inputPerMillion +
  (200_000 / 1_000_000) * PRICING.deepseek_standard.outputPerMillion;
if (dsCost !== Math.round(dsExpected * 100) / 100) {
  throw new Error(`deepseek_standard cost ${dsCost}, want ${dsExpected}`);
}

if (PRICING.deepseek_standard.inputPerMillion !== 2 || PRICING.deepseek_standard.outputPerMillion !== 8) {
  throw new Error(`deepseek_standard should use normal list price, got ${JSON.stringify(PRICING.deepseek_standard)}`);
}

// Zero / invalid tokens should not produce negative costs
if (estimateCostRmb(-100, NaN, "qwen_plus") !== 0) {
  throw new Error("invalid tokens should estimate to 0");
}

console.log("test-usage-cost-estimate: ok");
