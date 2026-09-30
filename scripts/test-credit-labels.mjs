/**
 * Wallet amounts are credits (积分 / credits / نقاط), model token COUNTS stay "Token".
 *
 * Since 2026-09-30 the balance the server still stores under resource_type
 * "token" (tokenBalance, grants, enterprise pools, member weekly budgets,
 * per-request caps, plan allowances) is denominated in credits: 1 yuan = 1,000
 * credits, each model spends them at its own rate. Calling that number "Token"
 * tells people they hold tokens they do not have. But usage statistics
 * (billable/input/output tokens, "今日 Token") really are token counts and must
 * keep saying so.
 *
 * This is an explicit allow/deny list of the labels that were relabelled: each
 * CREDIT key must carry the credit unit and never the word token; each TOKEN
 * key must still say token. A regression in either direction fails here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { CREDIT_UNIT } = await load("web/lib/site-copy-pricing.mjs");
const { dictionaries } = await load("web/lib/i18n.mjs");
const { ENTERPRISE_CONSOLE_DICTIONARIES, formatCredits, formatCreditBudget } = await load("web/lib/enterprise-console-i18n.mjs");
const { enterpriseCopy } = await load("web/lib/site-copy-enterprise.mjs");
const billingFormat = await load("web/lib/billing-format.mjs");

// The credit unit per locale, as CREDIT_UNIT spells it (ar also accepts the singular نقطة).
const CREDIT = {
  zh: new RegExp(CREDIT_UNIT.zh),
  en: new RegExp(CREDIT_UNIT.en.replace(/s$/, ""), "i"),
  ar: new RegExp(`${CREDIT_UNIT.ar}|نقطة`),
};
const TOKEN = { zh: /token/i, en: /token/i, ar: /رمز|رموز|token/i };
const WEB_LOCALES = ["zh", "en", "ar"];
const DESKTOP_LOCALES = { "zh-CN": "zh", en: "en", ar: "ar" };

const get = (obj, key) => key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), obj);
const text = (value) => (Array.isArray(value) ? value.join(" | ") : String(value ?? ""));

function credit(where, locale, key, value) {
  assert.ok(value !== undefined && value !== "", `${where} ${locale}: ${key} exists`);
  assert.match(text(value), CREDIT[locale], `${where} ${locale}: ${key} is a wallet amount and says ${CREDIT_UNIT[locale]} — got "${text(value)}"`);
  assert.doesNotMatch(text(value), TOKEN[locale], `${where} ${locale}: ${key} must not call credits tokens — got "${text(value)}"`);
}
function token(where, locale, key, value) {
  assert.ok(value !== undefined && value !== "", `${where} ${locale}: ${key} exists`);
  assert.match(text(value), TOKEN[locale], `${where} ${locale}: ${key} is a token COUNT and must keep saying token — got "${text(value)}"`);
}

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

check("admin console: pool, grants, budgets and balances are credits; usage token columns stay Token", () => {
  const CREDIT_KEYS = [
    "enterprise.resource.token",
    "enterprise.unitCount.token",
    "enterprise.list.cols.usage30d",
    "enterprise.detail.budgetHelp",
    "enterprise.grant.unitsHelp.token",
    "enterprise.usage.totalsUnits",
    "enterprise.usage.cols.units",
  ];
  const TOKEN_KEYS = ["enterprise.usage.cols.tokens", "usageView.tokens", "charts.tokensToday", "usageAnalytics.total"];
  for (const locale of WEB_LOCALES) {
    const admin = dictionaries[locale].admin;
    for (const key of CREDIT_KEYS) credit("admin", locale, key, get(admin, key));
    for (const key of TOKEN_KEYS) if (get(admin, key) !== undefined) token("admin", locale, key, get(admin, key));
  }
  // The users views (ar shares en's) — the balance column and metric.
  for (const locale of ["zh", "en"]) {
    const users = dictionaries[locale].admin.usersView;
    credit("admin", locale, "usersView.credits", users.credits);
    credit("admin", locale, "usersView.metrics[0]", users.metrics[0]);
  }
});

check("admin pages: no hard-coded Token label on a balance, grant or pack", () => {
  const users = read("web/app/admin/users/page.js");
  assert.doesNotMatch(users, /<div>Token \{fmt\(user\.tokenRemaining/, "the users list labels the balance with c.credits");
  assert.match(users, /\{c\.credits\} \{fmt\(user\.tokenRemaining/);
  const user = read("web/app/admin/users/[id]/page.js");
  assert.match(user, /grant\.resource_type === "token" \? c\.credits/, "a token grant reads as credits");
  assert.match(user, /row\.resource_type === "token" \? `\$\{fmt\(row\.billable_units, locale\)\} \$\{c\.credits\}`/, "the deducted column shows the credits charged");
  const panels = read("web/components/billing-admin-panels.js");
  assert.doesNotMatch(panels, />Token<|Token 包|K Token/, "billing admin forms call the resource 积分");
  const org = read("web/app/admin/enterprise/[id]/page.js");
  assert.match(org, /budgetCurrent, \{ value: hasBudget \? formatAmount\(e, "token", budget, locale\)/, "the default weekly budget is said with its unit");
});

check("enterprise console: pool, budgets, caps and charges are credits; the token column stays Token", () => {
  const CREDIT_KEYS = [
    "common.units",
    "resource.token",
    "overview.used",
    "overview.budget",
    "overview.perRequestCap",
    "overview.poolRemaining",
    "members.usedOf",
    "members.usedUnlimited",
    "members.budgetLabel",
    "members.capLabel",
    "usage.units",
    "settings.budgetLabel",
    "grants.remaining",
  ];
  for (const locale of WEB_LOCALES) {
    const dict = ENTERPRISE_CONSOLE_DICTIONARIES[locale];
    for (const key of CREDIT_KEYS) credit("enterprise console", locale, key, get(dict, key));
    token("enterprise console", locale, "usage.tokens", get(dict, "usage.tokens"));
    assert.equal(formatCredits(12000, locale).includes(CREDIT_UNIT[locale]), true, `${locale}: formatCredits carries the unit`);
    assert.match(formatCredits(1234567, locale), /1[,٬]?234[,٬]?567|١٬٢٣٤٬٥٦٧/, `${locale}: credits keep thousands separators, never 万/M compaction`);
    assert.equal(formatCreditBudget(null, locale), dict.common.unlimited, `${locale}: an unlimited budget has no unit`);
  }
  assert.equal(formatCredits(12000, "zh"), "12,000 积分");
  assert.equal(formatCredits(12000, "en"), "12,000 credits");
  for (const rel of ["web/app/account/enterprise/[id]/members/page.js", "web/app/account/enterprise/[id]/history/page.js"]) {
    assert.match(read(rel), /formatCreditBudget\(/, `${rel} says budgets with their credit unit`);
  }
});

check("site mocks: the enterprise pool and weekly budgets are credits, never '万 Token' or 'M' tokens", () => {
  for (const locale of WEB_LOCALES) {
    const mocks = enterpriseCopy[locale].mocks;
    credit("site enterprise mock", locale, "org.poolUnit", mocks.org.poolUnit);
    credit("site enterprise mock", locale, "org.weekLabel", mocks.org.weekLabel);
    credit("site enterprise mock", locale, "org.defaultNote", mocks.org.defaultNote);
    credit("site enterprise mock", locale, "identity.week", mocks.identity.week);
    const grantRow = mocks.history.rows.find((row) => /500,000/.test(row[1]));
    assert.ok(grantRow, `${locale}: the platform grant row exists`);
    credit("site enterprise mock", locale, "history grant row", grantRow[1]);
    const all = JSON.stringify(mocks);
    assert.doesNotMatch(all, /Token|tokens|رموز/, `${locale}: no mock still says token`);
    assert.doesNotMatch(all, /\d(?:\.\d)?M\b|万 Token/, `${locale}: no token-style 1.2M / 4,820 万 amounts`);
    assert.equal(mocks.org.poolValue, "482,000");
    for (const [, , usage, percent] of mocks.org.members.filter((row) => row[3] > 0)) {
      const [used, budget] = usage.split("/").map((part) => Number(part.replace(/[^\d]/g, "")));
      assert.equal(Math.round((used / budget) * 100), percent, `${locale}: the meter matches ${usage}`);
    }
  }
});

check("account site pages: the balance card and pack names say 积分", () => {
  assert.match(read("web/app/account/entitlements/page.js"), /"积分余额"/);
  assert.doesNotMatch(read("web/app/account/entitlements/page.js"), /Token 余额/);
  assert.doesNotMatch(read("web/app/account/orders/page.js"), /Token 包/);
  assert.equal(billingFormat.unitLabel({ resourceType: "token", unitAmount: 100000 }), "100,000 积分");
  assert.equal(billingFormat.resourceUnits("token", -2500), "2,500 积分");
  assert.equal(billingFormat.unitLabel({ resourceType: "image_generation", unitAmount: 20 }), "20 次图片生成", "other resources keep their own unit");
});

check("desktop locales: balance, weekly budget and plan allowance are credits; usage stays Token", () => {
  const CREDIT_KEYS = [
    "settings.accountTokens",
    "settings.accountDesc",
    "settings.accountPlanWeekRemaining",
    "orgIdentity.weekly",
    "orgIdentity.weeklyNoReset",
    "orgIdentity.weeklyLimited",
    "orgIdentity.weeklyLimitedNoReset",
  ];
  const TOKEN_KEYS = ["settings.usage.tokensToday", "settings.usage.colTokens", "settings.usage.noTokens", "turn.footer.tokens"];
  for (const [file, locale] of Object.entries(DESKTOP_LOCALES)) {
    const messages = JSON.parse(read(`src/renderer/i18n/locales/${file}.json`));
    for (const key of CREDIT_KEYS) credit(`desktop ${file}`, locale, key, messages[key]);
    for (const key of TOKEN_KEYS) token(`desktop ${file}`, locale, key, messages[key]);
    assert.match(messages["orgIdentity.weekly"], /\{used\}.*\{budget\}.*\{time\}/, `${file}: weekly line keeps its placeholders`);
    assert.match(messages["settings.accountPlanWeekRemaining"], /\{remaining\}/);
  }
  assert.equal(JSON.parse(read("src/renderer/i18n/locales/zh-CN.json"))["settings.accountTokens"], "积分余额");
  assert.equal(JSON.parse(read("src/renderer/i18n/locales/zh-CN.json"))["settings.connectors.secret"], "应用专用密码 / Token", "an auth token is not a wallet amount");
});

check("desktop ORG_* failures: pool and weekly-allowance messages speak of credits", () => {
  const require = createRequire(import.meta.url);
  const { ORG_FAILURE_COPY } = require(path.join(ROOT, "src/main/organization-identity.js"));
  const locales = { "zh-CN": "zh", en: "en", ar: "ar" };
  for (const [key, locale] of Object.entries(locales)) {
    const copy = ORG_FAILURE_COPY[key];
    assert.ok(copy, `ORG_FAILURE_COPY has ${key}`);
    for (const code of ["ORG_POOL_INSUFFICIENT", "ORG_MEMBER_WEEKLY_LIMIT", "ORG_MEMBER_WEEKLY_LIMIT_NO_TIME", "ORG_SUSPENDED", "ORG_DISABLED"]) {
      credit("ORG_FAILURE_COPY", locale, `${key}.${code}`, copy[code]);
    }
  }
});

console.log(`${checks} checks passed (credit labels)`);
