#!/usr/bin/env node
// The enterprise console (web/app/account/enterprise/**) as its users meet it.
//
// It used to be hardcoded Chinese, showed people as usr_… ids, offered a
// self-serve "create organization" form the server always refuses, blanked a
// whole page when one secondary read failed, removed members on the first
// click, and gave a plain member an empty hub. Each check below pins one of
// those down by rendering the real pages against a fake API.
// Run: node scripts/test-enterprise-console-ui.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const requireWeb = createRequire(path.join(WEB, "package.json"));
const swc = requireWeb("next/dist/build/swc");
await swc.loadBindings();
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const i18nConsole = await import(pathToFileURL(path.join(WEB, "lib/enterprise-console-i18n.mjs")).href);
const { enterpriseMessage } = await import(pathToFileURL(path.join(WEB, "lib/enterprise-messages.mjs")).href);
const realI18n = await import(pathToFileURL(path.join(WEB, "lib/i18n.mjs")).href);

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

// ---------------------------------------------------------------- harness
// Every web/ .js file is transpiled on demand (JSX -> CJS); .mjs files load
// natively; Next's runtime modules and the API are fakes the test controls.
const env = { locale: "zh", pathname: "/", api: null, calls: [] };
const redirect = (url) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url, digest: "NEXT_REDIRECT" }); };
const fakes = {
  "next/link": ({ href, children, className }) => React.createElement("a", { href, className }, children),
  "next/navigation": {
    redirect,
    notFound: () => { throw Object.assign(new Error("NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }); },
    unstable_rethrow: (error) => { if (error?.digest) throw error; },
    usePathname: () => env.pathname,
  },
  "next/cache": { revalidatePath: (...args) => env.calls.push(["revalidate", ...args]) },
  "next/headers": { cookies: async () => ({ get: () => undefined }) },
};
const userApi = {
  API_BASE: "https://api.test",
  userApiGetResult: async (p) => env.api.get(p),
  userApiGet: async (p) => (await env.api.get(p)).data,
  userApiPost: async (p, body) => { env.calls.push(["POST", p, body]); return env.api.write("POST", p, body); },
  userApiPatch: async (p, body) => { env.calls.push(["PATCH", p, body]); return env.api.write("PATCH", p, body); },
  userApiDelete: async (p) => { env.calls.push(["DELETE", p]); return env.api.write("DELETE", p); },
};
const i18nFake = { ...realI18n, getI18n: async () => ({ locale: env.locale, dir: realI18n.dirForLocale(env.locale), t: realI18n.dictionaries[env.locale] }), getLocale: async () => env.locale };
const cache = new Map();
function resolveFile(base) {
  for (const candidate of [base, `${base}.js`, `${base}.mjs`]) if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  throw new Error(`cannot resolve ${base}`);
}
function loadFile(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const source = fs.readFileSync(file, "utf8");
  const { code } = swc.transformSync(source, { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } });
  const module = { exports: {} };
  cache.set(file, module);
  const require = (id) => {
    if (id in fakes) return fakes[id];
    if (id.startsWith(".")) {
      const target = resolveFile(path.resolve(path.dirname(file), id));
      if (target.endsWith("/lib/user-api.js")) return userApi;
      if (target.endsWith("/lib/i18n.mjs")) return i18nFake;
      if (target.endsWith(".mjs")) return requireWeb(target);
      return loadFile(target);
    }
    return requireWeb(id);
  };
  vm.runInThisContext(`(function (exports, require, module) {${code}\n})`, { filename: file })(module.exports, require, module);
  return module.exports;
}
const load = (relative) => loadFile(path.join(WEB, relative));

/** A fake API: GET routes answer fixtures (or a failure), writes answer `writes`. */
function fakeApi({ user = { id: "usr_self", passwordMustChange: false }, org, routes = {}, writes = {} }) {
  return {
    async get(p) {
      if (p === "/api/auth/session/current") return { ok: true, status: 200, data: { ok: true, user } };
      const url = new URL(p, "https://api.test");
      for (const [pattern, answer] of Object.entries(routes)) {
        if (url.pathname.endsWith(pattern)) {
          const value = typeof answer === "function" ? answer(url) : answer;
          return value?.fail ? { ok: false, status: value.status || 500, code: value.code || "", message: "boom", data: null } : { ok: true, status: 200, data: { ok: true, ...value } };
        }
      }
      if (org && url.pathname === `/api/enterprise/organizations/${org.id}`) return { ok: true, status: 200, data: { ok: true, organization: org } };
      return { ok: false, status: 404, code: "ORG_NOT_FOUND", data: null };
    },
    async write(method, p, body) {
      const handler = writes[`${method} ${new URL(p, "https://api.test").pathname}`];
      if (!handler) return { ok: true };
      return typeof handler === "function" ? handler(body) : handler;
    },
  };
}

async function render(element) {
  return renderToStaticMarkup(await element);
}
const textOf = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const CJK = /[㐀-鿿！-～　-〿]/;

const baseOrg = {
  id: "org_acme", name: "Acme Robotics", status: "active", owner_status: "active", platform_status: "active", platform_status_reason: null,
  default_member_weekly_budget: 5000, role: "owner",
  me: { ok: true, weeklyBudget: 5000, weeklyUsed: 1200, resetsAt: "2099-01-08T00:00:00Z", limited: false, perRequestCap: null },
  quota: [
    { id: "g1", resource_type: "token", status: "active", unit_total: 100000, unit_remaining: 64000, expires_at: "2099-01-01T00:00:00Z" },
    { id: "g2", resource_type: "token", status: "active", unit_total: 500, unit_remaining: 500, expires_at: "2000-01-01T00:00:00Z" },
    { id: "g3", resource_type: "image_generation", status: "active", unit_total: 40, unit_remaining: 30, expires_at: "2099-01-01T00:00:00Z" },
  ],
};
const roster = [
  { user_id: "usr_self", role: "owner", status: "active", displayName: "Olivia Owner", loginName: "olivia", phone: "138****0001", lastLoginAt: "2026-09-01T00:00:00Z", issued: false, quota: null, weeklyBudget: null, effectiveWeeklyBudget: 5000, weeklyUsed: 0, weeklyResetsAt: null },
  { user_id: "usr_admin2", role: "admin", status: "active", displayName: "", loginName: "", phone: "139****0002", lastLoginAt: null, issued: false, quota: null, weeklyBudget: 8000, effectiveWeeklyBudget: 8000, weeklyUsed: 8000, weeklyResetsAt: "2099-01-03T00:00:00Z" },
  { user_id: "usr_member3", role: "member", status: "disabled", displayName: "Marco Member", loginName: "max_0001", phone: null, lastLoginAt: null, issued: true, quota: 300, weeklyBudget: null, effectiveWeeklyBudget: null, weeklyUsed: 10, weeklyResetsAt: "2099-01-02T00:00:00Z" },
];
const invitations = [{ id: "inv_1", phone_e164: "+8613800138000", role: "member", status: "pending", created_at: "2026-09-20T00:00:00Z", invited_by: "usr_self", expires_at: "2099-10-20T00:00:00Z" }];
const accounts = [
  { userId: "usr_member3", loginName: "max_0001", displayName: "Marco Member", status: "active", passwordMustChange: true, lastLoginAt: null, role: "member", memberStatus: "disabled" },
  { userId: "usr_gone", loginName: "max_0002", displayName: "", status: "disabled", passwordMustChange: false, lastLoginAt: null, role: null, memberStatus: "removed" },
];

// ---------------------------------------------------------------- dictionary
await check("every locale has every sentence, in its own language, with the same slots", () => {
  const flat = (value, prefix = "") => Object.entries(value).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
  const [zh, en, ar] = ["zh", "en", "ar"].map((l) => new Map(flat(i18nConsole.enterpriseConsoleText(l))));
  assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort(), "en has exactly the zh keys");
  assert.deepEqual([...ar.keys()].sort(), [...zh.keys()].sort(), "ar has exactly the zh keys");
  const slots = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const [key, zhText] of zh) {
    for (const [locale, dict] of [["en", en], ["ar", ar]]) {
      const text = dict.get(key);
      assert.ok(typeof text === "string" && text.length, `${locale}.${key} is written`);
      assert.ok(!CJK.test(text), `${locale}.${key} contains no Chinese: ${text}`);
      assert.equal(slots(text), slots(zhText), `${locale}.${key} fills the same slots as zh`);
    }
    if (/[؀-ۿ]/.test(en.get(key))) assert.fail(`en.${key} is Arabic`);
  }
  assert.equal(i18nConsole.enterpriseConsoleText("fr"), i18nConsole.enterpriseConsoleText("zh"), "an unknown locale falls back to zh");
});

await check("no page or console component carries a literal Chinese sentence", () => {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, e.name); if (e.isDirectory()) walk(full); else if (e.name.endsWith(".js")) files.push(full); } };
  walk(path.join(WEB, "app/account/enterprise"));
  for (const f of fs.readdirSync(path.join(WEB, "components"))) if (/^enterprise-.*\.js$/.test(f)) files.push(path.join(WEB, "components", f));
  const offenders = files.filter((f) => CJK.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\[\\n,，;；\\s\]/g, "")));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), [], "all copy comes from enterprise-console-i18n.mjs");
});

await check("an unknown failure reads as a sentence, never as the raw code", () => {
  for (const locale of ["zh", "en", "ar"]) {
    for (const raw of ["NETWORK_ERROR", "HTTP_502", new Error("fetch failed"), new Error("23505")]) {
      const message = i18nConsole.consoleErrorMessage(raw, locale);
      assert.ok(!/NETWORK_ERROR|HTTP_502|23505|fetch failed/.test(message), `${locale}: ${message}`);
    }
    assert.equal(i18nConsole.consoleErrorMessage(new Error("ORG_LAST_OWNER: detail"), locale), enterpriseMessage("ORG_LAST_OWNER", locale));
  }
});

// ---------------------------------------------------------------- page helpers
await check("a failed secondary read degrades its section instead of throwing the page away", async () => {
  const lib = load("lib/enterprise-page.js");
  env.api = fakeApi({ org: baseOrg, routes: { "/invitations": { fail: true, status: 502 }, "/audit": { fail: true, code: "ORG_FORBIDDEN", status: 403 } } });
  const degraded = await lib.requireEnterpriseData("/api/enterprise/organizations/org_acme/invitations", { invitations: [] });
  assert.deepEqual(degraded.invitations, [], "the fallback is what the page renders");
  assert.equal(degraded.loadError, "INTERNAL_ERROR", "and it says why");
  assert.equal((await lib.requireEnterpriseData("/api/enterprise/organizations/org_acme/audit?limit=5", { entries: [] })).loadError, "ORG_FORBIDDEN");
  await assert.rejects(lib.requireEnterpriseData("/api/enterprise/organizations/org_acme/invitations"), "without a fallback the data is required");
  const loaded = await lib.loadEnterpriseOrganization("org_acme");
  assert.equal(loaded.org.viewerId, "usr_self", "the page knows who is looking (to hide self-removal)");
});

// ---------------------------------------------------------------- list
await check("no self-serve create; an empty list explains that the platform opens organizations", async () => {
  const src = fs.readFileSync(path.join(WEB, "app/account/enterprise/page.js"), "utf8");
  assert.ok(!/createOrganization/.test(src), "the create action is gone from the list page");
  assert.ok(!/createOrganization/.test(fs.readFileSync(path.join(WEB, "app/account/enterprise/actions.js"), "utf8")), "and from the actions");
  env.locale = "en";
  env.api = fakeApi({ routes: { "/api/enterprise/organizations": { organizations: [] } } });
  const html = await render(load("app/account/enterprise/page.js").default());
  assert.match(html, /You are not in any organization yet/);
  assert.match(html, /opened for companies by the platform/);
  assert.match(html, /href="\/contact"/, "with a way to reach sales/support");
  assert.ok(!/<input/.test(html), "and no form to fill");
});

await check("the list shows effective state per organization and survives a failed read", async () => {
  env.locale = "ar";
  env.api = fakeApi({ routes: { "/api/enterprise/organizations": { organizations: [
    { ...baseOrg, id: "o1", member_count: 12, membership_status: "active" },
    { ...baseOrg, id: "o2", name: "Frozen Co", status: "disabled", platform_status: "suspended", member_count: 3, role: "member", membership_status: "active" },
    { ...baseOrg, id: "o3", name: "Paused Co", status: "disabled", owner_status: "disabled", member_count: 1, role: "admin", membership_status: "disabled" },
  ] } } });
  const html = textOf(await render(load("app/account/enterprise/page.js").default()));
  const T = i18nConsole.enterpriseConsoleText("ar");
  for (const s of [T.orgStatus.active, T.orgStatus.frozen, T.orgStatus.paused, T.list.membershipDisabled, "Frozen Co"]) assert.ok(html.includes(s), `shows ${s}`);
  env.api = fakeApi({ routes: { "/api/enterprise/organizations": { fail: true, status: 0, code: "NETWORK_ERROR" } } });
  const failed = textOf(await render(load("app/account/enterprise/page.js").default()));
  assert.ok(failed.includes(T.common.loadFailed), "a readable failure");
  assert.ok(!failed.includes("NETWORK_ERROR"), "never the raw code");
});

// ---------------------------------------------------------------- layout
await check("the layout tells a platform freeze from an owner pause, and tabs follow the role", async () => {
  const layout = load("app/account/enterprise/[id]/layout.js").default;
  env.locale = "en";
  const frozenOrg = { ...baseOrg, status: "disabled", platform_status: "suspended", platform_status_reason: "Overdue invoice", owner_status: "disabled", role: "member" };
  env.api = fakeApi({ org: frozenOrg });
  const html = textOf(await render(layout({ params: Promise.resolve({ id: baseOrg.id }), children: React.createElement("p", null, "CHILD") })));
  assert.match(html, /frozen by the platform/);
  assert.match(html, /Overdue invoice/);
  assert.match(html, /the owner still has to resume it/, "both switches are explained");
  assert.match(html, /CHILD/);
  assert.ok(!/Members|Usage|History|Pool/.test(html), "a plain member sees no admin tabs");
  assert.match(html, /Overview/); assert.match(html, /Settings/);
  env.api = fakeApi({ org: { ...baseOrg, status: "disabled", owner_status: "disabled" } });
  const paused = textOf(await render(layout({ params: Promise.resolve({ id: baseOrg.id }), children: null })));
  assert.match(paused, /The owner has paused this organization/);
  assert.match(paused, /You can resume it in Settings/);
  for (const tab of ["Members", "Usage", "History", "Pool"]) assert.ok(paused.includes(tab), `owner tab ${tab}`);
  env.api = fakeApi({ routes: { [`/api/enterprise/organizations/${baseOrg.id}`]: { fail: true, status: 403, code: "ORG_MEMBER_DISABLED" } } });
  const refused = textOf(await render(layout({ params: Promise.resolve({ id: baseOrg.id }), children: React.createElement("p", null, "CHILD") })));
  assert.ok(refused.includes(enterpriseMessage("ORG_MEMBER_DISABLED", "en")), "a refused organization says why in words");
  assert.ok(!refused.includes("CHILD"));
});

// ---------------------------------------------------------------- overview
await check("a plain member's hub is not empty: my week, who pays, and a way out", async () => {
  env.locale = "ar";
  const T = i18nConsole.enterpriseConsoleText("ar");
  const memberOrg = { ...baseOrg, role: "member" };
  delete memberOrg.quota;
  env.api = fakeApi({ org: memberOrg });
  const html = textOf(await render(load("app/account/enterprise/[id]/page.js").default({ params: Promise.resolve({ id: baseOrg.id }) })));
  for (const s of [T.overview.myWeekTitle, T.overview.whoPaysTitle, T.overview.linkLeave, T.overview.memberHint, T.overview.weekExplain]) assert.ok(html.includes(s), `member hub shows ${s}`);
  assert.ok(!html.includes(T.overview.linkMembers), "no admin tools");
  assert.ok(!html.includes(T.overview.poolTopup) && !html.includes(T.overview.poolRemaining), "and not the pool");
});

await check("an admin's overview shows the spendable pool and says top-ups come from the platform", async () => {
  env.locale = "en";
  env.api = fakeApi({ org: baseOrg });
  const html = textOf(await render(load("app/account/enterprise/[id]/page.js").default({ params: Promise.resolve({ id: baseOrg.id }) })));
  assert.match(html, /64,000 Tokens available/, "expired grants are not spendable");
  assert.match(html, /Image generation 30/);
  assert.match(html, /topped up by the platform/);
  assert.match(html, /1,200/); assert.match(html, /5,000/, "my week: used and budget");
  env.api = fakeApi({ org: { ...baseOrg, me: { ok: true, weeklyBudget: 100, weeklyUsed: 100, resetsAt: "2099-01-01T00:00:00Z", limited: true, perRequestCap: 50 } } });
  const limited = textOf(await render(load("app/account/enterprise/[id]/page.js").default({ params: Promise.resolve({ id: baseOrg.id }) })));
  assert.match(limited, /budget is used up/); assert.match(limited, /Per-request cap: 50/);
});

// ---------------------------------------------------------------- members
await check("members are people (name / login / masked phone), with week, controls and seats", async () => {
  env.locale = "en";
  env.api = fakeApi({ org: baseOrg, routes: {
    "/members": (url) => { env.calls.push(["members-query", url.search]); return { members: roster, total: 120, limit: 50, offset: 0 }; },
    "/invitations": { invitations },
    "/accounts": { accounts },
  } });
  env.calls = [];
  const page = load("app/account/enterprise/[id]/members/page.js").default;
  const html = await render(page({ params: Promise.resolve({ id: baseOrg.id }), searchParams: Promise.resolve({ q: "ma" }) }));
  const text = textOf(html);
  assert.ok(env.calls.some(([k, s]) => k === "members-query" && /q=ma/.test(s) && /limit=50/.test(s)), "search and page size reach the API");
  for (const s of ["Olivia Owner", "139****0002", "Marco Member", "max_0001", "+86 138****8000"]) assert.ok(text.includes(s), `shows ${s}`);
  assert.ok(!/usr_/.test(text), "never a bare usr_ id on screen");
  assert.match(text, /Used 8,000 \/ 8,000/); assert.match(text, /Used 10 · unlimited/); assert.match(text, /Week not started/);
  assert.match(text, /1–3 of 120/); assert.match(html, /offset=50/, "pagination");
  assert.match(text, /Pending seats \(1\)/); assert.match(text, /Expires/);
  assert.match(text, /Issued accounts \(2\)/); assert.match(text, /Restore to organization/, "a removed issued account can come back");
  assert.match(text, /This is you/);
  assert.equal((text.match(/ Remove /g) || []).length, 2, "the owner may remove everyone but themselves");
});

await check("an admin is not offered controls the server would refuse", async () => {
  env.locale = "en";
  env.api = fakeApi({ user: { id: "usr_admin2" }, org: { ...baseOrg, role: "admin" }, routes: { "/members": { members: roster, total: 3 }, "/invitations": { invitations: [] }, "/accounts": { accounts } } });
  const text = textOf(await render(load("app/account/enterprise/[id]/members/page.js").default({ params: Promise.resolve({ id: baseOrg.id }), searchParams: Promise.resolve({}) })));
  assert.equal((text.match(/ Remove /g) || []).length, 1, "only the plain member can be removed by an admin");
  assert.match(text, /Admins cannot change other admins or owners/);
  assert.match(text, /No pending seats/);
});

await check("one failed section does not blank the members page", async () => {
  env.locale = "zh";
  const T = i18nConsole.enterpriseConsoleText("zh");
  env.api = fakeApi({ org: baseOrg, routes: { "/members": { members: roster, total: 3 }, "/invitations": { fail: true, status: 500 }, "/accounts": { fail: true, code: "ORG_FORBIDDEN", status: 403 } } });
  const text = textOf(await render(load("app/account/enterprise/[id]/members/page.js").default({ params: Promise.resolve({ id: baseOrg.id }), searchParams: Promise.resolve({}) })));
  assert.ok(text.includes("Olivia Owner"), "members still render");
  assert.ok(text.includes(enterpriseMessage("INTERNAL_ERROR", "zh")), "the failed section says so");
  assert.ok(text.includes(enterpriseMessage("ORG_FORBIDDEN", "zh")));
  assert.ok(!/INTERNAL_ERROR|ORG_FORBIDDEN/.test(text));
});

await check("a plain member opening an admin page gets an explanation, not a crash", async () => {
  env.locale = "en";
  env.api = fakeApi({ org: { ...baseOrg, role: "member" } });
  for (const page of ["members", "usage", "history"]) {
    const text = textOf(await render(load(`app/account/enterprise/[id]/${page}/page.js`).default({ params: Promise.resolve({ id: baseOrg.id }), searchParams: Promise.resolve({}) })));
    assert.match(text, /needs a higher role/, page);
  }
});

await check("every destructive action asks first, through the shared DangerForm", () => {
  const form = fs.readFileSync(path.join(WEB, "components/enterprise-action-form.js"), "utf8");
  assert.match(form, /import \{ DangerForm \} from "\.\/danger-form"/);
  assert.match(form, /if \(confirm\) \{\s*return <DangerForm action=\{submit\} confirm=\{confirm\}/);
  const destructive = [
    ["members/page.js", /removeMemberAction/], ["members/page.js", /revokeInvitationAction/], ["members/page.js", /resetAccountPasswordAction/],
    ["members/page.js", /setMemberStatusAction\.bind\(null, id, member\.user_id, "disabled"\)/],
    ["settings/page.js", /leaveOrganizationAction/], ["settings/page.js", /transferOwnershipAction/], ["settings/page.js", /setOrganizationPausedAction\.bind\(null, id, true\)/],
  ];
  for (const [file, pattern] of destructive) {
    const src = fs.readFileSync(path.join(WEB, "app/account/enterprise/[id]", file), "utf8");
    const tags = [...src.matchAll(/<EnterpriseActionForm\b[^>]*>/g)].map((m) => m[0]).filter((tag) => pattern.test(tag));
    assert.ok(tags.length > 0, `${file} wires ${pattern}`);
    for (const tag of tags) assert.match(tag, /confirm=\{/, `${file}: ${pattern} must confirm`);
  }
});

// ---------------------------------------------------------------- actions
await check("actions answer in the viewer's language and say what actually happened", async () => {
  const actions = load("app/account/enterprise/actions.js");
  env.locale = "en";
  const add = new FormData(); add.set("phoneE164", "138 0013 8000"); add.set("role", "member");
  env.api = fakeApi({ writes: { "POST /api/enterprise/organizations/org_acme/members": { invitation: { id: "inv", expires_at: "2099-10-20T00:00:00Z" } } } });
  const invited = await actions.addMemberAction("org_acme", add);
  assert.equal(invited.ok, true); assert.match(invited.message, /not registered yet/); assert.match(invited.message, /2099/);
  env.api = fakeApi({ writes: { "POST /api/enterprise/organizations/org_acme/members": { member: { user_id: "usr_x" } } } });
  assert.match((await actions.addMemberAction("org_acme", add)).message, /Added as a member/);
  env.api = fakeApi({ writes: { "DELETE /api/enterprise/organizations/org_acme/members/usr_admin2": () => { throw new Error("ORG_ADMIN_PEER_FORBIDDEN: nope"); } } });
  const refused = await actions.removeMemberAction("org_acme", "usr_admin2");
  assert.equal(refused.ok, false); assert.equal(refused.message, enterpriseMessage("ORG_ADMIN_PEER_FORBIDDEN", "en"));
  env.api = fakeApi({ writes: { "DELETE /api/enterprise/organizations/org_acme/members/usr_x": () => { throw new Error("fetch failed"); } } });
  assert.equal((await actions.removeMemberAction("org_acme", "usr_x")).message, i18nConsole.enterpriseConsoleText("en").common.failed, "a network failure is a sentence");
  env.api = fakeApi({ writes: { "PATCH /api/enterprise/organizations/org_acme": { organization: { status: "disabled", owner_status: "active", platform_status: "suspended" } } } });
  assert.match((await actions.setOrganizationPausedAction("org_acme", false)).message, /still has the organization frozen/, "resuming does not pretend to lift a freeze");
  env.api = fakeApi({});
  env.calls = [];
  const edit = new FormData();
  edit.set("role", "member"); edit.set("roleWas", "member");
  edit.set("weeklyBudget", "800"); edit.set("weeklyBudgetWas", "500");
  edit.set("quota", ""); edit.set("quotaWas", "");
  assert.equal((await actions.patchMemberAction("org_acme", "usr_x", edit)).ok, true);
  assert.deepEqual(env.calls.find(([m]) => m === "PATCH")?.[2], { weeklyBudget: 800 }, "only what changed is sent");
  const clear = new FormData(); clear.set("weeklyBudget", ""); clear.set("weeklyBudgetWas", "800");
  env.calls = [];
  await actions.patchMemberAction("org_acme", "usr_x", clear);
  assert.deepEqual(env.calls.find(([m]) => m === "PATCH")?.[2], { weeklyBudget: null }, "empty = back to the org default");
  const bad = new FormData(); bad.set("weeklyBudget", "-3"); bad.set("weeklyBudgetWas", "");
  assert.equal((await actions.patchMemberAction("org_acme", "usr_x", bad)).message, enterpriseMessage("WEEKLY_BUDGET_INVALID", "en"));
  await assert.rejects(actions.leaveOrganizationAction("org_acme"), (e) => e.url === "/account/enterprise", "leaving goes back to the list");
  const settings = new FormData(); settings.set("defaultMemberWeeklyBudget", "");
  env.calls = [];
  await actions.saveOrganizationSettingsAction("org_acme", settings);
  assert.deepEqual(env.calls.find(([m]) => m === "PATCH")?.[2], { defaultMemberWeeklyBudget: null }, "an empty default means unlimited");
});

// ---------------------------------------------------------------- usage
await check("usage names people, and a bad or failed range never blanks the page", async () => {
  env.locale = "en";
  const seen = [];
  env.api = fakeApi({ org: baseOrg, routes: { "/usage": (url) => { seen.push(url.searchParams.get("days")); return { usage: {
    days: 30,
    byMember: [{ user_id: "usr_a", request_count: 3, units: 300, tokens: 900, displayName: "Ada", loginName: "ada", phone: null }, { user_id: "usr_gone", request_count: 1, units: 100, tokens: 50 }],
    byModel: [{ model: "deepseek-v4-pro", request_count: 4, units: 400 }],
    totals: { requests: 4, units: 400, tokens: 950 },
  } }; } } });
  const page = load("app/account/enterprise/[id]/usage/page.js").default;
  const text = textOf(await render(page({ params: Promise.resolve({ id: baseOrg.id }), searchParams: Promise.resolve({ days: "abc" }) })));
  assert.deepEqual(seen, ["30"], "?days=abc falls back to 30");
  assert.match(text, /Ada/); assert.match(text, /Former member/); assert.ok(!/usr_/.test(text));
  assert.match(text, /deepseek-v4-pro/); assert.match(text, /75%/); assert.match(text, /950/);
  env.api = fakeApi({ org: baseOrg, routes: { "/usage": { fail: true, status: 500 } } });
  const failed = textOf(await render(page({ params: Promise.resolve({ id: baseOrg.id }), searchParams: Promise.resolve({ days: "7" }) })));
  assert.match(failed, /Something went wrong on our side/); assert.match(failed, /90 days/, "the range selector stays so the user can move on");
});

// ---------------------------------------------------------------- history
await check("history reads as who did what, when — with load more", async () => {
  env.locale = "en";
  env.api = fakeApi({ org: baseOrg, routes: {
    "/audit": (url) => ({ entries: [
      { id: 9, action: "enterprise_member_change", metadata: { userId: "usr_member3", memberRole: "admin", previousRole: "member", weeklyBudget: 800 }, createdAt: "2026-09-29T08:00:00Z", actor: { kind: "member", userId: "usr_self", displayName: "Olivia Owner" } },
      { id: 8, action: "enterprise_org_status", metadata: JSON.stringify({ platformStatus: "suspended", reason: "Overdue" }), createdAt: "2026-09-28T08:00:00Z", actor: { kind: "platform" } },
      { id: 7, action: "enterprise_member_remove", metadata: { userId: "usr_vanished" }, createdAt: "2026-09-27T08:00:00Z", actor: { kind: "member", userId: "usr_admin2", phone: "139****0002" } },
      { id: 6, action: "enterprise_grant_adjust", metadata: { resourceType: "token", unitTotal: 100000 }, createdAt: "2026-09-26T08:00:00Z", actor: { kind: "platform" } },
    ].slice(0, Number(url.searchParams.get("limit"))), nextBefore: 6 }),
    "/members": { members: roster },
    "/accounts": { accounts },
  } });
  const html = await render(load("app/account/enterprise/[id]/history/page.js").default({ params: Promise.resolve({ id: baseOrg.id }), searchParams: Promise.resolve({}) }));
  const text = textOf(html);
  assert.match(text, /Olivia Owner changed Marco Member: role Member → Admin, weekly budget set to 800/);
  assert.match(text, /The platform froze the organization/); assert.match(text, /note: Overdue/);
  assert.match(text, /139\*\*\*\*0002 removed a former member from the organization/);
  assert.match(text, /The platform added 100,000 Tokens to the pool/);
  assert.ok(!/usr_/.test(text));
  assert.match(html, /history\?show=100/, "load more");
});

// ---------------------------------------------------------------- settings
await check("settings follow the role: owner pause/transfer, admin rename/budget, member leave", async () => {
  env.locale = "en";
  const page = load("app/account/enterprise/[id]/settings/page.js").default;
  env.api = fakeApi({ org: { ...baseOrg, status: "disabled", platform_status: "suspended" }, routes: { "/members": { members: roster } } });
  const owner = textOf(await render(page({ params: Promise.resolve({ id: baseOrg.id }) })));
  for (const s of ["Organization name", "Default weekly budget", "Pause organization", "Transfer ownership", "You are the only owner"]) assert.ok(owner.includes(s), `owner sees ${s}`);
  assert.match(owner, /frozen by the platform\. This is not your own pause/, "a freeze is not offered as something a resume fixes");
  env.api = fakeApi({ org: { ...baseOrg, status: "disabled", owner_status: "disabled" }, routes: { "/members": { members: roster } } });
  assert.match(textOf(await render(page({ params: Promise.resolve({ id: baseOrg.id }) }))), /Resume organization/);
  env.api = fakeApi({ user: { id: "usr_member3" }, org: { ...baseOrg, role: "member" }, routes: { "/members": { members: [roster[2]] } } });
  const issuedMember = textOf(await render(page({ params: Promise.resolve({ id: baseOrg.id }) })));
  assert.ok(!issuedMember.includes("Pause organization") && !issuedMember.includes("Transfer ownership") && !issuedMember.includes("Default weekly budget"));
  assert.match(issuedMember, /issued by the organization and cannot leave/);
  env.api = fakeApi({ user: { id: "usr_plain" }, org: { ...baseOrg, role: "member" }, routes: { "/members": { members: [{ ...roster[2], user_id: "usr_plain", issued: false }] } } });
  assert.match(textOf(await render(page({ params: Promise.resolve({ id: baseOrg.id }) }))), /Leave organization/);
});

console.log(`enterprise console ui: ${checks} checks passed`);
