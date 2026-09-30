#!/usr/bin/env node
// The usage page's estimated credits price each model exactly as the gateway
// does (2026-09-30): the server hands out rates chosen by the same rule
// precedence the gateway charges with, and the client prices every input token
// as uncached, so an estimate is never below what the gateway would charge.
// There is no money (¥) estimate and no client price table.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyCreditEstimates, normalizeCreditRates, estimateCredits } = require("../src/main/usage-credits.js");
const { usageCreditRates, creditRateFor, creditsForUsage, FALLBACK_RATE } = await import("../server/src/services/credit-pricing.js");
const { choosePricingRule } = await import("../server/src/services/billing.js");

const rule = (spec_key, input, output, inputCached, extra = {}) => ({ feature: "chat_model", enabled: true, provider: "", model: "", spec_key,
  metadata: { creditsPerMillion: { input, output, inputCached } }, ...extra });
const rules = [
  rule("deepseek-v4-flash", 2900, 11500, 60),
  rule("deepseek-v4-pro", 13000, 39000, 450),
  rule("default", 13000, 39000, 450),
  rule("gpt-x", 1, 1, 1, { provider: "openai" }), // provider-specific: needs the gateway's provider id
  rule("off", 1, 1, 1, { enabled: false }),
];

// 1. The server's rates are the gateway's rule choice, model by model.
const rates = usageCreditRates(rules);
for (const model of ["deepseek-v4-flash", "deepseek-v4-pro", "unpriced-model", "gpt-x", "off"]) {
  const gateway = creditRateFor(choosePricingRule(rules, { feature: "chat_model", provider: "", model, specKey: model }));
  const served = rates.models[model] ?? rates.default;
  assert.deepEqual([served.input, served.output], [gateway.input, gateway.output], `${model}: same rate as the gateway`);
}
assert.deepEqual(Object.keys(rates.models).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
assert.deepEqual(usageCreditRates([]).default, { ...FALLBACK_RATE }, "no rules: the most expensive rate, as the gateway");

// 2. An estimate is never below the gateway's charge for the same usage.
const usage = { inputTokens: 1_234_567, outputTokens: 89_012 };
for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
  const rate = creditRateFor(choosePricingRule(rules, { feature: "chat_model", model, specKey: model }));
  const estimate = estimateCredits(usage, normalizeCreditRates(rates).models[model]);
  assert.equal(estimate, creditsForUsage(usage, rate), `${model}: all-uncached estimate equals the gateway's uncached charge`);
  for (const cached of [0, 500_000, 1_234_567]) {
    assert.ok(estimate >= creditsForUsage({ cachedInputTokens: cached, inputTokens: usage.inputTokens - cached, outputTokens: usage.outputTokens }, rate));
  }
}

// 3. Row states and totals.
const row = (providerID, model, billedInCredits, inputTokens, outputTokens) => ({ providerID, model, billedInCredits, inputTokens, outputTokens });
const summary = {
  today: { models: [row("gw", "deepseek-v4-flash", true, 1_000_000, 0), row("own", "x", false, 9e9, 9e9), row("unknown", "unknown", null, 5, 5)] },
  history: [], rangeTotals: {},
  modelTotals: [row("gw", "deepseek-v4-flash", true, 1_000_000, 0), row("gw", "brand-new", true, 1, 0)],
};
const out = applyCreditEstimates(summary, rates);
assert.deepEqual(out.today.models.map(r => [r.creditState, r.estimatedCredits]), [["estimated", 2900], ["notCharged", null], ["unknown", null]]);
assert.equal(out.today.estimatedCredits, 2900);
assert.equal(out.modelTotals[1].estimatedCredits, 1, "an unpriced model uses the default rate, rounded up like the gateway");
assert.equal(out.rangeTotals.estimatedCredits, 2901);
const none = applyCreditEstimates(summary, { default: { input: "x" } });
assert.equal(none.credits.available, false);
assert.equal(none.today.estimatedCredits, null, "unusable rates: no number at all");
assert.equal(normalizeCreditRates(null), null);

// 4. The money estimate is gone, not hidden.
assert.ok(!fs.existsSync(new URL("../src/main/usage-cost-estimate.js", import.meta.url)), "no client price table");
const locales = ["zh-CN", "en", "ar"].map(l => JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${l}.json`, import.meta.url), "utf8")));
for (const strings of locales) {
  for (const key of ["settings.usage.pricingNote", "settings.usage.costToday", "settings.usage.colCost", "turn.footer.cost"]) assert.ok(!(key in strings), `${key} removed`);
  for (const key of Object.keys(strings).filter(k => k.startsWith("settings.usage."))) assert.doesNotMatch(strings[key], /[¥￥$]\{|¥/, `${key}: no money`);
  for (const key of ["settings.usage.creditsToday", "settings.usage.colCredits", "settings.usage.creditsNotCharged", "settings.usage.creditsNote", "settings.usage.rangeSummaryTokens"]) assert.ok(strings[key], `${key} present`);
}
console.log("usage credits: ok");
