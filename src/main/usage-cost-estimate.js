"use strict";

/** Reference pricing for user-facing estimates only — not billing. */

const PRICING = {
  /** Alibaba DashScope qwen-plus tier (CNY per 1M tokens). */
  qwen_plus: {
    id: "qwen_plus",
    inputPerMillion: 0.8,
    outputPerMillion: 2,
  },
  /** DeepSeek standard reference price (CNY per 1M tokens). */
  deepseek_standard: {
    id: "deepseek_standard",
    inputPerMillion: 2,
    outputPerMillion: 8,
  },
};

const DEFAULT_PRICING_ID = "deepseek_standard";

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function estimateCostRmb(inputTokens, outputTokens, pricingId = DEFAULT_PRICING_ID) {
  const tier = PRICING[pricingId] || PRICING[DEFAULT_PRICING_ID];
  const input = numberValue(inputTokens);
  const output = numberValue(outputTokens);
  const cost =
    (input / 1_000_000) * tier.inputPerMillion +
    (output / 1_000_000) * tier.outputPerMillion;
  return Math.round(cost * 100) / 100;
}

function listPricingOptions() {
  return Object.values(PRICING).map((tier) => ({ id: tier.id }));
}

module.exports = {
  PRICING,
  DEFAULT_PRICING_ID,
  estimateCostRmb,
  listPricingOptions,
};
