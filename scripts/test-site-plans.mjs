#!/usr/bin/env node
// Subscription plans (Lily Pro / Lily Max) on the site, the account page and
// the console (2026-09-30).
//
// Intent, not surface:
// - Plan products are grouped by tier and period from the server's own
//   fields (metadata.plan / metadata.period, as planTierOf reads them); a
//   product the page cannot place is left out, never guessed into a slot.
// - A buy button exists only for a real plan product while a payment method is
//   live. Without one the card shows the quote sheet as a labelled reference
//   price and "opening soon" + contact — rendered for real here, for every way
//   the catalog can be missing.
// - The weekly allowance is read from the product (unitAmount), never
//   hardcoded; without a product no allowance number is shown.
// - Yearly is ten months on the quote sheet; the enterprise tiers are exactly
//   the published seat prices, minimum two seats.
// - The credit unit has one home (CREDIT_UNIT); no per-model multiplier is
//   printed; no invoice content.
// - The console saves a plan as kind "subscription" + resource "plan" with
//   metadata { plan, period }, and the BYOK switch asks before it submits.
// Run: node scripts/test-site-plans.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  CREDIT_UNIT,
  QUOTE_SHEET,
  accountPlanProducts,
  copyFor,
  currentPlanView,
  enterpriseMinimumCents,
  enterpriseTiers,
  groupPlanProducts,
  planPeriodOf,
  planTierOf,
  plansState,
  pricingCopy,
  yearMonthsEquivalent,
} from "../web/lib/site-copy-pricing.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const DAY = 86400;
const plan = (id, tier, period, priceCents, unitAmount, extra = {}) => ({
  id, name: id, kind: "subscription", resourceType: "plan", priceCents, currency: "CNY", unitAmount,
  durationSeconds: (period === "year" ? 365 : 30) * DAY, metadata: { plan: tier, period }, ...extra,
});
const PRO_M = plan("pro_m", "pro", "month", 4900, 0);
const PRO_Y = plan("pro_y", "pro", "year", 49000, 0);
const MAX_M = plan("max_m", "max", "month", 9900, 10_000_000);
const MAX_Y = plan("max_y", "max", "year", 99000, 10_000_000);
const PAY = { paymentProviders: [{ id: "alipay", label: "支付宝" }], fakePaymentsEnabled: false };

// --- grouping -------------------------------------------------------------------
await check("plan products are grouped by tier and period, and nothing is guessed", () => {
  const slots = groupPlanProducts([
    { id: "tok", name: "tokens", priceCents: 100, resourceType: "token", unitAmount: 5, metadata: { plan: "max", period: "month" } },
    plan("max_m_dup", "max", "month", 1, 1),
    MAX_Y,
    { ...plan("max_y_no_period", "max", "year", 1, 1), metadata: { plan: "max" } },
    plan("enterprise_x", "team", "month", 1, 1),
    { ...plan("odd_len", "pro", "month", 1, 1), metadata: { plan: "pro" }, durationSeconds: 90 * DAY },
    { ...plan("broken", "pro", "month", -1, 0) },
  ]);
  assert.equal(slots.max.month.id, "max_m_dup");
  assert.equal(slots.max.year.id, "max_y", "an explicit period wins over a later one inferred from length");
  assert.equal(slots.pro.month, null, "a 90-day plan without a period is not forced into month or year; a negative price is dropped");
  assert.equal(slots.pro.year, null);
  assert.ok(!("team" in slots), "an unknown tier has no slot");
  assert.equal(groupPlanProducts([MAX_M, plan("max_m_2", "max", "month", 1, 1)]).max.month.id, "max_m", "server order: the first product per slot wins");
  assert.equal(planTierOf({ metadata: { plan: " MAX " } }), "max", "tier read as the server reads it (trimmed, lower-cased)");
  assert.equal(planPeriodOf({ durationSeconds: 365 * DAY, metadata: {} }), "year");
  assert.equal(planPeriodOf({ durationSeconds: 30 * DAY, metadata: {} }), "month");
  assert.equal(planPeriodOf({ durationSeconds: 7 * DAY, metadata: {} }), "");
});

// --- price math -----------------------------------------------------------------
await check("yearly is ten months on the quote sheet, and the math says so", () => {
  for (const [tier, price] of [...Object.entries(QUOTE_SHEET.personal), ...Object.entries(QUOTE_SHEET.enterprise)]) {
    assert.equal(price.year, price.month * 10, `${tier}: yearly = monthly × 10`);
    assert.equal(yearMonthsEquivalent(price.month, price.year), 10);
  }
  assert.deepEqual(QUOTE_SHEET.personal, { pro: { month: 4900, year: 49000 }, max: { month: 9900, year: 99000 } }, "Pro ¥49 / ¥490, Max ¥99 / ¥990");
  assert.equal(yearMonthsEquivalent(9900, 118800), 0, "twelve months is no saving: no hint");
  assert.equal(yearMonthsEquivalent(0, 99000), 0);
  assert.equal(yearMonthsEquivalent(9900, 0), 0);
  assert.equal(yearMonthsEquivalent(3000, 25000), 8.3, "a real ratio, rounded to one decimal");
});

await check("the enterprise tiers are the published seat prices, from two seats", () => {
  assert.equal(QUOTE_SHEET.enterpriseMinSeats, 2);
  assert.deepEqual(enterpriseTiers("zh"), [
    { tier: "standard", month: "¥59", year: "¥590", minimum: "¥118", minSeats: 2 },
    { tier: "premium", month: "¥129", year: "¥1,290", minimum: "¥258", minSeats: 2 },
  ]);
  assert.equal(enterpriseMinimumCents("standard"), 11800);
  assert.equal(enterpriseMinimumCents("premium"), 25800);
  assert.equal(enterpriseMinimumCents("nope"), 0);
  const zh = copyFor("zh").enterprisePlans;
  assert.equal(zh.tiers.standard.name, "企业标准版");
  assert.equal(zh.tiers.premium.name, "企业高级版");
  assert.match(zh.privateNote, /私有化部署与定制服务按项目单独评估报价/);
  assert.match(zh.legalNote, /本页为对外报价说明，具体条款以正式合同为准/);
});

// --- state ----------------------------------------------------------------------
await check("live products: server prices and allowance; buyable only with a live payment method", () => {
  const live = plansState({ ok: true, status: 200, data: { products: [PRO_M, MAX_M, MAX_Y], ...PAY } }, "zh");
  assert.equal(live.status, "live");
  assert.equal(live.purchasable, true);
  const [pro, max] = live.tiers;
  assert.equal(max.featured, true, "Max is the highlighted plan");
  assert.equal(pro.featured, false);
  assert.equal(max.month.price, "¥99");
  assert.equal(max.month.weekly, "每周 10,000,000 积分", "the weekly allowance is the product's unitAmount, in the credit unit");
  assert.equal(max.month.buyable, true);
  assert.equal(pro.month.weekly, copyFor("zh").plans.weeklyNone, "a plan with no allowance says so instead of printing 0");
  assert.equal(pro.year.source, "quote", "a missing slot falls back to the quote sheet");
  assert.equal(pro.year.buyable, false, "and is never buyable");
  assert.equal(pro.year.weekly, "", "and invents no allowance");
  assert.equal(pro.year.price, "¥490");
  const other = plansState({ ok: true, status: 200, data: { products: [{ ...MAX_M, unitAmount: 2200 }], ...PAY } }, "en");
  assert.equal(other.tiers[1].month.weekly, "2,200 credits every week", "a different allowance on the server is what the page says");

  const noPay = plansState({ ok: true, status: 200, data: { products: [MAX_M], paymentProviders: [], fakePaymentsEnabled: false } }, "zh");
  assert.equal(noPay.purchasable, false);
  assert.ok(noPay.tiers.every((t) => !t.month.buyable && !t.year.buyable), "no payment method, nothing buyable");
  const fake = plansState({ ok: true, status: 200, data: { products: [MAX_M], paymentProviders: [], fakePaymentsEnabled: true } }, "zh");
  assert.equal(fake.tiers[1].month.buyable, true, "fake payments count only when the server enables them");
});

const MISSING = [
  ["no products", { ok: true, status: 200, data: { products: [], ...PAY } }],
  ["only packs", { ok: true, status: 200, data: { products: [{ id: "tok", name: "t", priceCents: 990, resourceType: "token", unitAmount: 1 }], ...PAY } }],
  ["regional 403", { ok: false, status: 403, code: "REGION_FEATURE_DISABLED", data: null }],
  ["timeout", { ok: false, status: 0, code: "CATALOG_TIMEOUT", data: null }],
  ["nothing at all", undefined],
];

await check("without plan products: quote-sheet prices only, nothing buyable, no allowance number", () => {
  for (const [label, result] of MISSING) {
    const state = plansState(result, "zh");
    assert.equal(state.status, "quote", label);
    assert.equal(state.purchasable, false, label);
    for (const tier of state.tiers) {
      for (const period of ["month", "year"]) {
        const cell = tier[period];
        assert.equal(cell.source, "quote", `${label}: ${tier.tier}/${period}`);
        assert.equal(cell.buyable, false, `${label}: ${tier.tier}/${period} is not buyable`);
        assert.equal(cell.id, "", `${label}: no product id to buy`);
        assert.equal(cell.weekly, "", `${label}: no invented allowance`);
        assert.equal(cell.priceCents, QUOTE_SHEET.personal[tier.tier][period]);
      }
    }
  }
});

// --- rendered: the fallback never shows a buy button -------------------------------
const requireWeb = createRequire(path.join(WEB, "package.json"));
const React = requireWeb("react");
const { prerenderToNodeStream } = requireWeb("react-dom/static");
const swc = requireWeb("next/dist/build/swc");
await swc.loadBindings();
const cache = new Map();
function load(from, id) {
  if (!id.startsWith(".")) return requireWeb(id);
  const base = path.resolve(path.dirname(from), id);
  const file = [base, `${base}.js`, `${base}.mjs`].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) throw new Error(`cannot resolve ${id}`);
  if (cache.has(file)) return cache.get(file);
  const { code } = swc.transformSync(fs.readFileSync(file, "utf8"), {
    filename: path.basename(file),
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const module = { exports: {} };
  cache.set(file, module.exports);
  vm.runInThisContext(`(function (module, exports, require) {${code}\n})`, { filename: file })(module, module.exports, (next) => load(file, next));
  cache.set(file, module.exports);
  return module.exports;
}
async function html(element) {
  const { prelude } = await prerenderToNodeStream(element);
  let out = "";
  for await (const chunk of prelude) out += chunk;
  return out;
}
const { PricingPlans } = load(path.join(WEB, "x.js"), "./components/site/pricing-plans.js");
const { PricingEnterprise } = load(path.join(WEB, "x.js"), "./components/site/pricing-plans-enterprise.js");
const { PricingCompare } = load(path.join(WEB, "x.js"), "./components/site/pricing-compare.js");
const BUY = /href="\/account\/billing"/g;

await check("rendered: every missing-catalog state shows prices but no buy button", async () => {
  for (const locale of ["zh", "en", "ar"]) {
    const copy = copyFor(locale);
    for (const [label, result] of MISSING) {
      const out = await html(React.createElement(PricingPlans, { copy, plans: plansState(result, locale) }));
      assert.equal((out.match(BUY) || []).length, 0, `${locale} ${label}: no buy link`);
      assert.ok(out.includes(copy.plans.buy) === false, `${locale} ${label}: no buy label`);
      assert.ok(out.includes(copy.plans.soon), `${locale} ${label}: says it opens soon`);
      assert.ok(out.includes(copy.plans.quoteLabel), `${locale} ${label}: the price is labelled as the list price`);
      assert.ok(out.includes('href="/contact"'), `${locale} ${label}: and offers a way to reach us`);
    }
  }
  const zh = await html(React.createElement(PricingPlans, { copy: copyFor("zh"), plans: plansState(undefined, "zh") }));
  for (const price of ["¥49", "¥490", "¥99", "¥990"]) assert.ok(zh.includes(price), `quote price ${price} is shown`);
  assert.ok(zh.includes("相当于 10 个月的价格"), "yearly says it is ten months' price");
  assert.ok(zh.includes('id="pr-period-month"') && zh.includes('id="pr-period-year"'), "the month / year switch is there");
  assert.match(zh, /<input[^>]*id="pr-period-month"[^>]*checked=""|<input[^>]*checked=""[^>]*id="pr-period-month"/, "monthly is chosen before any script runs");
});

await check("rendered: live products get one buy link each, and a product without payment gets none", async () => {
  const copy = copyFor("zh");
  const all = await html(React.createElement(PricingPlans, { copy, plans: plansState({ ok: true, status: 200, data: { products: [PRO_M, PRO_Y, MAX_M, MAX_Y], ...PAY } }, "zh") }));
  assert.equal((all.match(BUY) || []).length, 4, "four real products, four buy links");
  assert.ok(all.includes("每周 10,000,000 积分"));
  const partial = await html(React.createElement(PricingPlans, { copy, plans: plansState({ ok: true, status: 200, data: { products: [MAX_M], ...PAY } }, "zh") }));
  assert.equal((partial.match(BUY) || []).length, 1, "only the one real product can be bought");
  const noPay = await html(React.createElement(PricingPlans, { copy, plans: plansState({ ok: true, status: 200, data: { products: [MAX_M, MAX_Y], paymentProviders: [] } }, "zh") }));
  assert.equal((noPay.match(BUY) || []).length, 0, "no live payment method: no buy link");
  assert.ok(noPay.includes(copy.plans.paymentSoon), "and it says payment opens soon");
});

await check("rendered: enterprise tiers show both prices, two seats, the minimum, and contact sales", async () => {
  const copy = copyFor("zh");
  const out = await html(React.createElement(PricingEnterprise, { copy, tiers: enterpriseTiers("zh") }));
  for (const text of ["¥59", "年付 ¥590", "¥129", "年付 ¥1,290", "2 席起", "最低 ¥118/月", "最低 ¥258/月", "/席位/月"]) assert.ok(out.includes(text), `enterprise shows ${text}`);
  assert.equal((out.match(/href="\/contact\?topic=enterprise"/g) || []).length, 2, "each tier goes to contact sales");
  assert.equal((out.match(BUY) || []).length, 0, "enterprise is never bought on the page");
  const table = await html(React.createElement(PricingCompare, { copy, plans: plansState(undefined, "zh"), enterprise: enterpriseTiers("zh") }));
  for (const name of ["Lily Pro", "Lily Max", "企业标准版", "企业高级版"]) assert.ok(table.includes(name), `the comparison has a ${name} row`);
  assert.ok(table.includes("¥1,290/席位/年"));
});

// --- copy rules -----------------------------------------------------------------
function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
await check("one credit unit, no per-model multiplier, no invoice content", () => {
  assert.deepEqual(Object.keys(CREDIT_UNIT).sort(), ["ar", "en", "zh"]);
  for (const locale of ["zh", "en", "ar"]) {
    const rawText = strings(pricingCopy[locale]);
    assert.ok(!rawText.some((s) => s.includes(CREDIT_UNIT[locale])), `${locale}: copy names the unit only through {unit}`);
    const filled = strings(copyFor(locale));
    assert.ok(!filled.some((s) => s.includes("{unit}")), `${locale}: every {unit} is filled`);
    assert.ok(filled.some((s) => s.includes(CREDIT_UNIT[locale])), `${locale}: and the unit is actually used`);
    assert.ok(!filled.some((s) => /4\s*倍|×\s*4|x4\b|4x\b|4 times|أربعة أضعاف/i.test(s)), `${locale}: no per-model multiplier is printed`);
    assert.ok(!filled.some((s) => /发票|invoice|فاتورة ضريبية/i.test(s)), `${locale}: no invoice content`);
  }
  const faq = copyFor("zh").faq.items.map((item) => `${item.q} ${item.a}`).join("\n");
  assert.match(faq, /每 7 天算一周/, "the FAQ explains the weekly reset");
  assert.match(faq, /不同模型按各自价格消耗积分/, "and per-model consumption");
  assert.match(faq, /顺延/, "and that renewals extend");
  assert.match(faq, /由你在客户端选择的身份决定/, "and who pays by identity");
});

// --- account --------------------------------------------------------------------
await check("account: plans listed Pro before Max, month before year, with period and weekly allowance", () => {
  const list = accountPlanProducts([MAX_Y, { id: "tok", name: "t", priceCents: 1, resourceType: "token" }, MAX_M, PRO_Y, PRO_M], "zh");
  assert.deepEqual(list.map((p) => p.id), ["pro_m", "pro_y", "max_m", "max_y"]);
  assert.equal(list[2].weekly, "每周 10,000,000 积分");
  assert.equal(list[3].days, 365);
  assert.equal(currentPlanView(null, "zh"), null);
  const view = currentPlanView({ tier: "max", expiresAt: "2026-10-30T02:00:00Z", weeklyUnits: 2200, weekRemaining: 1500, weekResetsAt: "2026-10-07T02:00:00Z" }, "zh");
  assert.equal(view.name, "Lily Max");
  assert.equal(view.weekRemaining, "1,500 积分");
  assert.ok(view.expiresAt && view.weekResetsAt, "valid-until and reset time are shown");
  const pro = currentPlanView({ tier: "pro", expiresAt: "2026-10-30T02:00:00Z", weeklyUnits: 0 }, "en");
  assert.equal(pro.weekRemaining, "", "a plan without an allowance shows no weekly figures");

  const page = read("web/app/account/billing/page.js");
  assert.match(page, /userApiGetResult\("\/api\/account\/entitlements"\)/, "the current plan comes from the entitlements endpoint");
  assert.ok(page.indexOf("accountPlanProducts(") < page.indexOf("groups.map("), "plans are listed before the other products");
  assert.match(page, /<ProductPurchaseForm\s+productId=\{plan\.id\}/, "a plan is bought through the same order form");
  assert.match(page, /extendNote/, "and the page says buying again extends the period");
  const form = read("web/components/product-purchase-form.js");
  assert.match(form, /createBillingOrderAction/, "the order flow is unchanged");
});

// --- console --------------------------------------------------------------------
await check("console: a plan is saved as subscription + plan with its tier and period", () => {
  const actions = read("web/app/admin/billing/actions.js");
  assert.match(actions, /kind: "subscription", resourceType: "plan", unitAmount: weekly, durationSeconds: days \* 86400/, "weekly allowance and period length go where the server reads them");
  assert.match(actions, /metadata: \{ plan, period \}/);
  assert.match(actions, /yuanToCents\(text\(formData, "priceYuan"\)\)/, "prices are parsed on digits, not float math");
  assert.match(actions, /formatAdminMessage\(/, "answers are sentences from the admin catalog");
  assert.match(actions, /byokRequiresPlan: next/);
  assert.match(actions, /apiGet\("\/api\/admin\/settings"\)/, "the BYOK switch re-sends the current trial days, read fresh");
  const form = read("web/components/admin-billing-product-form.js");
  for (const name of ["planTier", "planPeriod", "planDays", "weeklyUnits"]) assert.ok(form.includes(`name="${name}"`), `the form has ${name}`);
  assert.match(read("web/app/admin/billing/products/new/page.js"), /<AdminBillingProductForm \/>/);
  const toggle = read("web/components/admin-billing-byok-toggle.js");
  assert.match(toggle, /<DangerForm action=\{formAction\} confirm=\{on \? copy\.confirmOff : copy\.confirmOn\}/, "the BYOK switch asks first, in both directions");
  assert.match(read("web/components/config-basics-panel.js"), /<ByokPolicyPanel settings=\{settings\} t=\{t\} \/>/, "and sits in the basics settings");
});

console.log(`\n${checks} checks passed (site plans)`);
