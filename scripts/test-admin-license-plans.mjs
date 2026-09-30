#!/usr/bin/env node
// Licence plans in the admin console (2026-09-30). The server prices a licence
// by plan (trial/pro/max/standard/premium/unlimited) with a weekly credit pool
// per seat; the console used to offer trial/pro/team/enterprise as raw English
// values. This proves:
//   1. the plan select offers exactly the server's LICENSE_PLANS, named in
//      zh / en / ar, each with its weekly credits per seat;
//   2. the "credits per seat per week" override is posted by both actions
//      (empty → null = plan default; disabled for unlimited → not sent);
//   3. the detail page's weekly pool card renders the limited and the
//      unlimited cases, and the previous plan when there is one.
// Run: node scripts/test-admin-license-plans.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const requireWeb = createRequire(path.join(WEB, "package.json"));
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const React = requireWeb("react");
const { prerenderToNodeStream } = requireWeb("react-dom/static");
const swc = requireWeb("next/dist/build/swc");
await swc.loadBindings();
const { dictionaries } = await import("../web/lib/i18n.mjs");
const plans = await import("../web/lib/license-plans.mjs");
const server = await import("../server/src/services/license-credits.js");

// ---------------------------------------------------------------- loader (as test-admin-pages-render)
let LOCALE = "zh";
let sample = null;
const stubFor = (file) => {
  const rel = path.relative(WEB, file).replace(/\\/g, "/");
  if (rel === "lib/api.js") return { loadAdmin: async (_path, fallback) => sample ?? fallback };
  if (rel === "lib/i18n.mjs") return { ...requireWebModule(file), getI18n: async () => ({ locale: LOCALE, dir: "ltr", t: dictionaries[LOCALE] }) };
  if (rel === "lib/use-i18n.js") return { useI18n: () => ({ locale: LOCALE, dir: "ltr", t: dictionaries[LOCALE] }) };
  if (rel === "lib/admin-load-ledger.js") return { adminLoadFailures: () => [], recordAdminLoadFailure: () => null };
  if (rel === "app/admin/actions.js") return new Proxy({}, { get: (_, key) => (key === "__esModule" ? true : async () => {}) });
  return null;
};
const bare = {
  "next/navigation": { useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => "/admin", useSearchParams: () => new URLSearchParams(), redirect() {}, notFound() {} },
  "next/headers": { cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }), headers: async () => new Headers() },
  "server-only": {},
};
const cache = new Map();
function resolveLocal(from, id) {
  const base = path.resolve(path.dirname(from), id);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${id} from ${path.relative(ROOT, from)}`);
}
function requireWebModule(file) {
  const { code } = swc.transformSync(fs.readFileSync(file, "utf8"), {
    filename: path.basename(file),
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const module = { exports: {} };
  vm.runInThisContext(`(function (module, exports, require, process) {${code}\n})`, { filename: file })(module, module.exports, (id) => load(file, id), process);
  return module.exports;
}
function load(from, id) {
  if (id in bare) return bare[id];
  if (!id.startsWith(".")) return requireWeb(id);
  const file = resolveLocal(from, id);
  if (cache.has(file)) return cache.get(file);
  const exports = stubFor(file) || requireWebModule(file);
  cache.set(file, exports);
  return exports;
}
const loadWeb = (rel) => load(path.join(WEB, "x.js"), `./${rel}`);
async function render(element) {
  const errors = [];
  const { prelude } = await prerenderToNodeStream(element, { onError: (error) => { errors.push(error); } });
  let html = "";
  for await (const chunk of prelude) html += chunk;
  if (errors.length) throw errors[0];
  return html.replace(/<!-- -->/g, "");
}
const unescape = (html) => html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

// ---------------------------------------------------------------- 1. plans = server plans, named in 3 locales
await check("the console's plans and weekly credits are exactly the server's", () => {
  assert.deepEqual([...plans.LICENSE_PLANS], [...server.LICENSE_PLANS]);
  assert.deepEqual({ ...plans.LICENSE_PLAN_WEEKLY_CREDITS }, { ...server.LICENSE_PLAN_WEEKLY_CREDITS });
  assert.equal(plans.UNLIMITED_LICENSE_PLAN, server.UNLIMITED_PLAN);
  assert.equal(plans.normalizeLicensePlan("team"), "standard", "legacy labels map as the server maps them");
  assert.equal(plans.normalizeLicensePlan("enterprise"), "premium");
  assert.equal(plans.normalizeLicensePlan("nonsense"), "premium", "unknown is priced as premium by the server");
});

const EXPECTED_NAMES = {
  zh: { trial: "试用", pro: "Pro", max: "Max", standard: "企业标准版", premium: "企业高级版", unlimited: "不限量" },
  en: { trial: "Trial", pro: "Pro", max: "Max", standard: "Enterprise Standard", premium: "Enterprise Premium", unlimited: "Unlimited" },
};
await check("every plan is named in zh / en / ar, with its weekly credits per seat", () => {
  for (const locale of ["zh", "en", "ar"]) {
    const copy = dictionaries[locale].admin.licensePlans;
    assert.ok(copy, `${locale} has admin.licensePlans`);
    for (const plan of server.LICENSE_PLANS) assert.ok(copy.names[plan], `${locale} names ${plan}`);
    if (EXPECTED_NAMES[locale]) assert.deepEqual(copy.names, EXPECTED_NAMES[locale]);
    const options = plans.licensePlanOptions(copy);
    assert.deepEqual(options.map((o) => o.value), [...server.LICENSE_PLANS]);
    for (const [plan, credits] of Object.entries(server.LICENSE_PLAN_WEEKLY_CREDITS)) {
      const label = options.find((o) => o.value === plan).label;
      assert.ok(label.includes(credits.toLocaleString("en-US")), `${locale}/${plan}: "${label}" shows ${credits} with separators`);
    }
    assert.ok(options.find((o) => o.value === "unlimited").label.includes(copy.unlimitedHint));
  }
  assert.ok(dictionaries.ar.admin.licensePlans.names.standard !== dictionaries.en.admin.licensePlans.names.standard, "ar is translated, not the en fallback");
});

// ---------------------------------------------------------------- 2. the form fields and the actions
await check("the plan select renders the six plans and the override field", async () => {
  for (const locale of ["zh", "en", "ar"]) {
    LOCALE = locale;
    const { LicensePlanFields } = loadWeb("components/license-plan-fields.js");
    const copy = dictionaries[locale].admin.licensePlans;
    const html = unescape(await render(React.createElement(LicensePlanFields, { defaultPlan: "max" })));
    for (const plan of server.LICENSE_PLANS) assert.ok(html.includes(`value="${plan}"`), `${locale}: option ${plan}`);
    assert.ok(!/value="(team|enterprise)"/.test(html), "the old raw values are gone");
    assert.ok(html.includes('name="plan"') && html.includes('name="weeklyCreditsPerSeat"'));
    assert.ok(html.includes(copy.override));
    assert.ok(html.includes(plans.licensePlanHint(copy, "max")), `${locale}: the selected plan's hint`);
    assert.match(html, /name="weeklyCreditsPerSeat"(?![^>]*disabled)/, "enabled for a limited plan");
    const unlimited = unescape(await render(React.createElement(LicensePlanFields, { defaultPlan: "unlimited", defaultWeeklyCredits: 5000 })));
    assert.match(unlimited, /<input[^>]*disabled=""[^>]*name="weeklyCreditsPerSeat"|<input[^>]*name="weeklyCreditsPerSeat"[^>]*disabled=""/, `${locale}: disabled for unlimited`);
    assert.ok(unlimited.includes(copy.overrideUnlimited));
    const legacy = await render(React.createElement(LicensePlanFields, { defaultPlan: "enterprise", defaultWeeklyCredits: 9000 }));
    assert.match(legacy, /<option selected="" value="premium"|<option value="premium" selected=""/, "a legacy plan opens on the plan it maps to");
    assert.ok(legacy.includes('value="9000"'), "a stored override is shown");
  }
  LOCALE = "zh";
  cache.clear();
});

await check("both forms use the plan fields; both actions post the override", () => {
  for (const rel of ["web/components/license-create-form.js", "web/components/license-edit-form.js"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(src.includes("<LicensePlanFields"), `${rel} renders LicensePlanFields`);
    assert.ok(!/"team", "enterprise"/.test(src), `${rel} no longer offers team/enterprise`);
  }
  assert.ok(fs.readFileSync(path.join(ROOT, "web/components/license-edit-form.js"), "utf8").includes("defaultWeeklyCredits={license.weekly_credits_per_seat"), "edit opens with the stored override");
  const actions = fs.readFileSync(path.join(WEB, "app/admin/actions.js"), "utf8");
  for (const name of ["createLicenseAction", "updateLicenseAction"]) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`)).split(/\nexport /)[0];
    assert.match(body, /formData\.has\("weeklyCreditsPerSeat"\) \? \{ weeklyCreditsPerSeat: weeklyCreditsFromForm\(text\(formData, "weeklyCreditsPerSeat"\)\) \}/, `${name} posts weeklyCreditsPerSeat`);
  }
  assert.equal(plans.weeklyCreditsFromForm(""), null, "empty = plan default");
  assert.equal(plans.weeklyCreditsFromForm("  "), null);
  assert.equal(plans.weeklyCreditsFromForm("15000"), 15000);
  assert.equal(plans.weeklyCreditsFromForm("0"), 0, "0 is a real value, not the default");
});

// ---------------------------------------------------------------- 3. the weekly pool card
const license = { id: "lic_1", customer_name: "星河", plan: "standard", seats: 10, status: "active", expires_at: "2027-01-01T00:00:00Z", features: [], legacy_plan: "team" };
const resetsAt = "2026-10-05T04:00:00.000Z";
await check("detail page: a limited licence shows seats in use / cap, total, used, remaining, reset", async () => {
  for (const locale of ["zh", "en", "ar"]) {
    LOCALE = locale;
    cache.clear();
    const copy = dictionaries[locale].admin.licensePlans;
    sample = { license, devices: [], usage: {}, credits: { plan: "standard", unlimited: false, perSeat: 12000, seatsInUse: 3, seatsCap: 10, total: 36000, used: 12345, remaining: 23655, resetsAt } };
    const Page = loadWeb("app/admin/licenses/[id]/page.js").default;
    const html = unescape(await render(React.createElement(async () => Page({ params: Promise.resolve({ id: "lic_1" }) }))));
    assert.ok(html.includes('data-license-credit-pool="limited"'));
    for (const text of [copy.pool.title, copy.pool.seatsHelp, "3 / 10", "12,000", "36,000", "12,345", "23,655"]) assert.ok(html.includes(text), `${locale}: shows ${text}`);
    const reset = new Intl.DateTimeFormat({ zh: "zh-CN", en: "en-US", ar: "ar" }[locale], { dateStyle: "medium", timeStyle: "short" }).format(new Date(resetsAt));
    assert.ok(html.includes(reset), `${locale}: reset time ${reset}`);
    assert.ok(html.includes(copy.pool.legacy.replace("{plan}", "team")), `${locale}: the previous plan is named`);
    assert.ok(html.includes(copy.names.standard), `${locale}: plan is named, not "standard"`);
  }
});

await check("detail page: an unlimited licence says so with this week's usage, no fake total", async () => {
  LOCALE = "zh";
  cache.clear();
  const copy = dictionaries.zh.admin.licensePlans;
  sample = { license: { ...license, plan: "unlimited", legacy_plan: null }, devices: [], usage: {}, credits: { plan: "unlimited", unlimited: true, perSeat: null, seatsInUse: 2, seatsCap: 10, total: null, used: 98765, remaining: null, resetsAt } };
  const Page = loadWeb("app/admin/licenses/[id]/page.js").default;
  const html = unescape(await render(React.createElement(async () => Page({ params: Promise.resolve({ id: "lic_1" }) }))));
  assert.ok(html.includes('data-license-credit-pool="unlimited"'));
  assert.ok(html.includes("不限量 · 本周已用 98,765 积分"));
  assert.ok(!html.includes(copy.pool.remaining) && !html.includes(copy.pool.total), "no total/remaining rows for unlimited");
  assert.ok(html.includes("2 / 10"), "seats still shown");
  assert.ok(!html.includes("原套餐"), "no previous plan line without legacy_plan");
});

await check("detail page: an older server without credits still renders", async () => {
  cache.clear();
  sample = { license: { ...license, legacy_plan: null }, devices: [], usage: {} };
  const Page = loadWeb("app/admin/licenses/[id]/page.js").default;
  const html = await render(React.createElement(async () => Page({ params: Promise.resolve({ id: "lic_1" }) })));
  assert.ok(html.includes(dictionaries.zh.admin.licensePlans.pool.unavailable));
  sample = null;
});

console.log(`\n${checks} checks passed`);
