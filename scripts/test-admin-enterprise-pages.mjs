#!/usr/bin/env node
// The platform enterprise pages, rendered for real and driven through their
// actions: the list finds an organization from a person, the detail page says
// the two switches apart, every money-moving or freezing action refuses what
// the server would refuse before asking it, sends an idempotency key with a
// grant, and answers in sentences — never a raw server code. An issued owner's
// initial password comes back in the action's own result (the old URL-hash
// handoff could lose it on the client-side redirect) and is labelled as the
// OWNER's, with the platform's reissue window stated.
// (Auto-discovered by run-all-tests; not yet registered as a capability gate.)
// Run: node scripts/test-admin-enterprise-pages.mjs
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
const i18nModule = await import("../web/lib/i18n.mjs");
const { dictionaries } = i18nModule;
const { ENTERPRISE_MESSAGE_CODES, enterpriseMessage } = await import("../web/lib/enterprise-messages.mjs");

class NextControl extends Error {}
let LOCALE = "zh";

// Every API read and write the pages make lands here.
const api = { get: new Map(), calls: [], post: async () => ({ ok: true, status: 200, json: { ok: true } }), patch: async () => ({ ok: true }) };
const answer = (apiPath) => {
  const hit = [...api.get.keys()].filter((prefix) => apiPath.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
  return hit ? api.get.get(hit) : undefined;
};
const stubFor = (rel) => {
  if (rel === "lib/api.js") return {
    loadAdmin: async (apiPath, fallback) => { api.calls.push(["GET", apiPath]); return answer(apiPath) ?? fallback; },
    apiGet: async (apiPath) => {
      api.calls.push(["GET", apiPath]);
      const hit = answer(apiPath);
      if (hit === undefined) throw Object.assign(new Error("not found"), { status: 404 });
      return hit;
    },
    apiPostResult: async (apiPath, body) => { api.calls.push(["POST", apiPath, body]); return api.post(apiPath, body); },
    apiPatch: async (apiPath, body) => { api.calls.push(["PATCH", apiPath, body]); return api.patch(apiPath, body); },
  };
  if (rel === "lib/i18n.mjs") return { ...i18nModule, getI18n: async () => ({ locale: LOCALE, dir: "ltr", t: dictionaries[LOCALE] }), getLocale: async () => LOCALE };
  if (rel === "lib/use-i18n.js") return { useI18n: () => ({ locale: LOCALE, dir: "ltr", t: dictionaries[LOCALE] }) };
  if (rel === "lib/admin-load-ledger.js") return { adminLoadFailures: () => [], recordAdminLoadFailure: () => null };
  if (rel === "app/admin/actions.js") return new Proxy({}, { get: (_, key) => (key === "__esModule" ? true : async () => {}) });
  return null;
};
const bare = {
  "next/navigation": {
    useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
    usePathname: () => "/admin/enterprise",
    useSearchParams: () => new URLSearchParams(),
    redirect: (url) => { throw Object.assign(new NextControl("redirect"), { url }); },
    notFound: () => { throw new NextControl("notFound"); },
    unstable_rethrow: (error) => { if (error instanceof NextControl) throw error; },
  },
  "next/cache": { revalidatePath() {} },
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
function compile(file) {
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
  const exports = stubFor(path.relative(WEB, file).replace(/\\/g, "/")) || compile(file);
  cache.set(file, exports);
  return exports;
}
const web = (rel) => load(path.join(WEB, "x.js"), `./${rel}`);
async function render(rel, props = {}) {
  const Page = web(rel).default;
  const element = React.createElement(async () => {
    try { return await Page({ params: Promise.resolve(props.params || {}), searchParams: Promise.resolve(props.searchParams || {}) }); }
    catch (error) { if (error instanceof NextControl) return null; throw error; }
  });
  const errors = [];
  const { prelude } = await prerenderToNodeStream(element, { onError: (error) => { errors.push(error); } });
  let html = "";
  for await (const chunk of prelude) html += chunk;
  if (errors.length) throw errors[0];
  return html.replace(/<!-- -->/g, "");
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const day = 24 * 60 * 60 * 1000;

await check("the enterprise copy exists in all three languages, with the same shape", () => {
  const shape = (value, prefix = "") => (value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, child]) => shape(child, `${prefix}.${key}`))
    : [prefix]);
  const zh = shape(dictionaries.zh.admin.enterprise).sort();
  assert.ok(zh.length > 150, `the enterprise pages say a lot (${zh.length} strings)`);
  for (const locale of ["en", "ar"]) {
    assert.deepEqual(shape(dictionaries[locale].admin.enterprise).sort(), zh, `${locale} has every string zh has`);
    assert.ok(Array.isArray(dictionaries[locale].admin.pages.enterprise), `${locale} titles the page`);
  }
  assert.notEqual(dictionaries.ar.admin.enterprise.list.create, dictionaries.en.admin.enterprise.list.create, "Arabic is translated, not inherited");
  assert.equal(dictionaries.ar.admin.pages.users[0], dictionaries.en.admin.pages.users[0], "the rest of the Arabic admin keeps inheriting English as before");
});

await check("the list finds an organization from a person and says why it is not usable", async () => {
  api.get.clear(); api.calls.length = 0;
  api.get.set("/api/admin/enterprise/organizations", { total: 120, limit: 50, offset: 50, organizations: [
    { id: "org_frozen", name: "星河科技", status: "disabled", platform_status: "suspended", owner_status: "active", platform_status_reason: "合同到期未续费", source: "platform", member_count: 12,
      owner: { userId: "u_owner", displayName: "王经理", loginName: "xinghe-owner", phone: "+86 138****0000" }, pool: { token: 1500000, image_generation: 20 }, units30d: 98765, created_at: "2026-09-01T00:00:00Z" },
    { id: "org_legacy", name: "旧自助企业", status: "disabled", platform_status: "active", owner_status: "disabled", source: "self_serve", member_count: 1, owner: null, pool: {}, units30d: 0, created_at: "2026-01-01T00:00:00Z" },
  ] });
  const html = text(await render("app/admin/enterprise/page.js", { searchParams: { q: "13800000000", status: "all", cursor: "50" } }));
  const [, listPath] = api.calls.find(([, p]) => p.startsWith("/api/admin/enterprise/organizations"));
  const sent = new URL(`https://x${listPath}`).searchParams;
  assert.equal(sent.get("q"), "13800000000", "the search reaches the server, which matches any member's phone");
  assert.equal(sent.get("offset"), "50", "the page cursor is the offset");
  assert.equal(sent.get("limit"), "50");
  const e = dictionaries.zh.admin.enterprise;
  for (const expected of ["王经理", "xinghe-owner", "+86 138****0000", e.statusLabel.frozen, "合同到期未续费", e.statusLabel.paused, e.statusWhy.paused,
    "1,500,000 Token", "20 张图片", "98,765", e.source.self_serve, e.list.noOwner, e.list.poolEmpty, "共 120 家企业", e.list.createTitle, e.list.searchHelp]) {
    assert.ok(html.includes(expected), `the list says "${expected}"`);
  }
  assert.ok(!html.includes("suspended") && !html.includes("self_serve"), "no raw column values");
  assert.ok(html.includes(dictionaries.zh.admin.paging.next), "and there is a next page (100 of 120)");
  api.get.clear();
  const empty = text(await render("app/admin/enterprise/page.js", { searchParams: { q: "nobody" } }));
  assert.ok(empty.includes(e.list.noMatchTitle), "a search with no hit says so, rather than 'no organizations yet'");
});

const detail = {
  id: "org_1", name: "星河科技", status: "disabled", platform_status: "suspended", owner_status: "disabled", platform_status_reason: "欠费",
  platform_status_changed_at: "2026-09-20T00:00:00Z", plan: "standard", default_member_weekly_budget: 50000, created_at: "2026-09-01T00:00:00Z",
  memberCount: 12, pendingInvitations: 3,
  owners: [
    { id: "u_new", loginName: "new-owner", displayName: "王经理", passwordMustChange: true, issued: true },
    { id: "u_done", loginName: "done-owner", displayName: null, passwordMustChange: false, issued: true },
  ],
  grants: [
    { id: "grant_live", resource_type: "token", unit_total: 2000000, unit_remaining: 1500000, state: "active", starts_at: "2026-09-01T00:00:00Z", expires_at: new Date(Date.now() + 300 * day).toISOString() },
    { id: "grant_old", resource_type: "token", unit_total: 100, unit_remaining: 40, state: "expired", starts_at: "2025-01-01T00:00:00Z", expires_at: "2026-01-01T00:00:00Z" },
    { id: "grant_gone", resource_type: "image_generation", unit_total: 10, unit_remaining: 0, state: "revoked", starts_at: "2026-09-01T00:00:00Z", expires_at: new Date(Date.now() + 30 * day).toISOString() },
  ],
};

await check("the detail page says the two switches apart and offers only what each can do", async () => {
  api.get.clear(); api.calls.length = 0;
  api.get.set("/api/admin/enterprise/organizations/org_1", { ok: true, organization: detail });
  api.get.set("/api/admin/enterprise/organizations/org_1/usage", { usage: { days: 7, totals: { requests: 321, units: 45678 },
    byMember: [{ user_id: "u_member", units: 40000, request_count: 300, tokens: 39000, displayName: "李四", loginName: "lisi", phone: "+86 139****1111" }],
    byModel: [{ model: "deepseek-v4-pro", units: 45678, request_count: 321 }] } });
  api.get.set("/api/admin/enterprise/organizations/org_1/audit", { nextBefore: 17, entries: [
    { id: 20, action: "enterprise_grant_adjust", createdAt: "2026-09-25T00:00:00Z", metadata: { resourceType: "token", unitTotal: 2000000, expiresDays: 365 }, actor: { kind: "platform", name: "ops@lily" } },
    { id: 19, action: "enterprise_org_change", createdAt: "2026-09-24T00:00:00Z", metadata: JSON.stringify({ role: "owner", ownerStatus: "disabled" }), actor: { kind: "member", userId: "u_new", displayName: "王经理" } },
  ] });
  const raw = await render("app/admin/enterprise/[id]/page.js", { params: { id: "org_1" }, searchParams: { days: "7" } });
  const html = text(raw);
  const e = dictionaries.zh.admin.enterprise;
  const d = e.detail;
  assert.ok(api.calls.some(([, p]) => p.includes("/usage?days=7")), "the days selector reaches the usage read");
  assert.ok(html.includes(e.statusLabel.both) && html.includes(d.platformLayer) && html.includes(d.ownerLayer), "effective status and both switches");
  assert.ok(html.includes("原因：欠费"), "the platform's reason is shown");
  assert.ok(html.includes(d.unfreeze) && !html.includes(d.freezeReason), "a frozen organization offers unfreeze, not freeze");
  assert.ok(html.includes(d.unfreezeStillPaused), "and warns it stays paused by its owner");
  assert.ok(html.includes(d.ownerLayerHelp), "the owner's switch is explained as read-only");
  assert.equal((html.match(new RegExp(d.reissue, "g")) || []).length, 1, "reissue is offered only to the owner who has not activated");
  assert.ok(html.includes("12 位成员 · 3 个待接受的邀请") && html.includes(d.membersNote), "member counts, and why they are not editable here");
  assert.ok(html.includes("1,500,000 Token"), "the pool says what is available now, with its unit");
  assert.ok(html.includes(e.pool.states.expired) && html.includes(e.pool.states.revoked), "each grant says what state it is in");
  assert.equal((raw.match(new RegExp(`${e.pool.reduce} / ${e.pool.revoke}`, "g")) || []).length, 1, "only the live grant can be reduced or revoked");
  assert.match(raw, /name="idempotencyKey" value="[0-9a-f-]{36}"/, "the grant form carries an idempotency key");
  assert.ok(html.includes(e.grant.summaryEmpty), "and says what it will do once filled in");
  assert.ok(html.includes("45,678") && html.includes("李四") && raw.includes('href="/admin/users/u_member"'), "usage by member links to the person");
  assert.ok(html.includes("deepseek-v4-pro") && html.includes(e.usage.help), "usage by model, and what the figures include");
  assert.ok(html.includes(e.history.actions.enterprise_grant_adjust) && html.includes("2,000,000 Token"), "history reads as sentences");
  assert.ok(html.includes(e.history.platform) && html.includes("王经理") && html.includes(e.roles.owner), "and says who did it, platform or member");
  assert.ok(raw.includes("before=17#history"), "older history is one click away");
  assert.ok(raw.includes('value="50000"') && html.includes("当前：50,000"), "the weekly default is shown and editable");

  // Active, and no owner: a grant cannot be made, and the page says why before the operator tries.
  api.get.set("/api/admin/enterprise/organizations/org_1", { ok: true, organization: { ...detail, status: "active", platform_status: "active", owner_status: "active", owners: [], grants: [] } });
  const active = text(await render("app/admin/enterprise/[id]/page.js", { params: { id: "org_1" } }));
  assert.ok(active.includes(d.freezeReason) && active.includes(d.freeze), "an active organization offers freeze, with a reason");
  assert.ok(active.includes(d.noOwners), "no owner, no grant — said up front");
  assert.ok(active.includes(e.pool.emptyTitle));

  api.get.clear();
  const missing = text(await render("app/admin/enterprise/[id]/page.js", { params: { id: "org_missing" } }));
  assert.ok(missing.includes(d.notFoundTitle), "a missing organization says so");
});

await check("a user's page lists the organizations they belong to", async () => {
  api.get.clear();
  api.get.set("/api/admin/users/u_1", { user: { id: "u_1", phoneE164: "+8613800000000", status: "active" }, entitlements: {},
    organizations: [{ id: "org_1", name: "星河科技", status: "active", platform_status: "active", owner_status: "active", role: "admin", membership_status: "active", joined_at: "2026-09-02T00:00:00Z" }] });
  const raw = await render("app/admin/users/[id]/page.js", { params: { id: "u_1" } });
  const e = dictionaries.zh.admin.enterprise;
  assert.ok(raw.includes('href="/admin/enterprise/org_1"') && text(raw).includes(e.roles.admin), "each organization links to its page, with the role");
  api.get.set("/api/admin/users/u_1", { user: { id: "u_1", phoneE164: "+8613800000000", status: "active" }, entitlements: {} });
  assert.ok(text(await render("app/admin/users/[id]/page.js", { params: { id: "u_1" } })).includes(e.userOrgs.empty));
  api.get.clear();
});

const actions = web("app/admin/enterprise/actions.js");
const form = (fields) => { const data = new FormData(); for (const [k, v] of Object.entries(fields)) data.set(k, v); return data; };
const lastCall = () => api.calls.at(-1);
const noRawCode = (message) => assert.ok(!/\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/.test(message), `no raw server code in "${message}"`);

await check("creating: an issued owner's password comes back in the result, a phone owner opens the organization", async () => {
  api.calls.length = 0;
  api.post = async () => ({ ok: true, status: 200, json: { ok: true, organization: { id: "org_new" }, owner: { issued: true, userId: "u_o", loginName: "galaxy-owner", initialPassword: "Init-Pass-1" } } });
  const issued = await actions.createOrganizationAction(form({ name: "星河", ownerMode: "issue", ownerLoginName: "galaxy-owner" }));
  assert.equal(issued.ok, true);
  assert.deepEqual(issued.issued, [{ l: "galaxy-owner", p: "Init-Pass-1" }], "the password rides the result, not a URL");
  assert.equal(issued.organizationId, "org_new", "with a way to open the new organization");
  assert.deepEqual(lastCall()[2], { name: "星河", plan: "standard", owner: { issue: true, loginName: "galaxy-owner" } });
  api.post = async () => ({ ok: true, status: 200, json: { ok: true, organization: { id: "org_phone" }, owner: { issued: false, userId: "u_p" } } });
  await assert.rejects(actions.createOrganizationAction(form({ name: "星河", ownerMode: "phone", ownerPhone: "13800000000" })), (error) => error.url === "/admin/enterprise/org_phone");
  assert.deepEqual(lastCall()[2].owner, { phoneE164: "13800000000" }, "exactly one way to name the owner");
  api.post = async () => ({ ok: false, status: 404, json: { ok: false, code: "OWNER_NOT_REGISTERED" } });
  const refused = await actions.createOrganizationAction(form({ name: "星河", ownerMode: "phone", ownerPhone: "13900000000" }));
  assert.equal(refused.message, enterpriseMessage("OWNER_NOT_REGISTERED", "zh"), "a refusal is the sentence, not the code");
  api.calls.length = 0;
  assert.equal((await actions.createOrganizationAction(form({ name: "星河", ownerMode: "phone" }))).ok, false);
  assert.equal(api.calls.length, 0, "a phone owner with no phone never reaches the server");

  const src = fs.readFileSync(path.join(WEB, "app/admin/enterprise/actions.js"), "utf8");
  assert.ok(!/#issued=/.test(src), "the URL-hash handoff is gone");
  const credentials = dictionaries.zh.admin.enterprise.credentials;
  assert.match(credentials.title, /所有者/, "the banner says it is the owner's password");
  assert.match(credentials.body, /激活/, "and that the platform can reissue it only until the owner activates");
  assert.ok(!/员工/.test(credentials.title + credentials.body), "not the employee copy");
});

await check("freezing needs a reason; the switch sent is the platform's", async () => {
  api.calls.length = 0;
  const bare = await actions.freezeOrganizationAction("org_1", form({ reason: "  " }));
  assert.equal(bare.ok, false);
  assert.equal(api.calls.length, 0, "no reason, no request");
  api.patch = async () => ({ ok: true });
  assert.equal((await actions.freezeOrganizationAction("org_1", form({ reason: "欠费" }))).ok, true);
  assert.deepEqual(lastCall(), ["PATCH", "/api/admin/enterprise/organizations/org_1", { platformStatus: "suspended", reason: "欠费" }]);
  await actions.unfreezeOrganizationAction("org_1", form({}));
  assert.deepEqual(lastCall()[2], { platformStatus: "active" }, "unfreezing lifts only the platform switch");
  api.patch = async () => { throw new Error("ORG_NOT_FOUND"); };
  const gone = await actions.unfreezeOrganizationAction("org_1", form({}));
  assert.equal(gone.message, enterpriseMessage("ORG_NOT_FOUND", "zh"));
  api.patch = async () => ({ ok: true });
});

await check("rename and the weekly default: empty means unlimited, anything else is a whole number", async () => {
  await actions.setDefaultWeeklyBudgetAction("org_1", form({ defaultMemberWeeklyBudget: "" }));
  assert.deepEqual(lastCall()[2], { defaultMemberWeeklyBudget: null });
  await actions.setDefaultWeeklyBudgetAction("org_1", form({ defaultMemberWeeklyBudget: "50,000" }));
  assert.deepEqual(lastCall()[2], { defaultMemberWeeklyBudget: 50000 });
  api.calls.length = 0;
  const bad = await actions.setDefaultWeeklyBudgetAction("org_1", form({ defaultMemberWeeklyBudget: "-3" }));
  assert.equal(bad.message, enterpriseMessage("WEEKLY_BUDGET_INVALID", "zh"));
  assert.equal(api.calls.length, 0);
  await actions.renameOrganizationAction("org_1", form({ name: " 新名字 " }));
  assert.deepEqual(lastCall()[2], { name: "新名字" });
});

await check("a grant carries its idempotency key, and a replay says nothing was granted twice", async () => {
  api.post = async () => ({ ok: true, status: 200, json: { ok: true, grant: { id: "g" } } });
  const done = await actions.grantOrganizationQuotaAction("org_1", form({ resourceType: "token", unitTotal: "1,000,000", expiresDays: "365", idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e", note: "合同首期" }));
  assert.deepEqual(lastCall(), ["POST", "/api/admin/enterprise/organizations/org_1/grants",
    { resourceType: "token", unitTotal: 1000000, expiresDays: 365, idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e", note: "合同首期" }]);
  assert.ok(done.ok && done.message.includes("1,000,000 Token") && done.message.includes("365"), done.message);
  api.post = async () => ({ ok: true, status: 200, json: { ok: true, grant: { id: "g" }, idempotent: true } });
  const replay = await actions.grantOrganizationQuotaAction("org_1", form({ resourceType: "image_generation", unitTotal: "20", idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e" }));
  assert.match(replay.message, /没有重复调拨/, "a replay is said to be one");
  api.calls.length = 0;
  for (const units of ["0", "abc", "1.5", "2000000000"]) {
    assert.equal((await actions.grantOrganizationQuotaAction("org_1", form({ resourceType: "token", unitTotal: units }))).ok, false, `${units} is refused`);
  }
  assert.equal(api.calls.length, 0, "and never reaches the server");
  api.post = async () => ({ ok: false, status: 409, json: { ok: false, code: "ORG_NO_OWNER" } });
  const noOwner = await actions.grantOrganizationQuotaAction("org_1", form({ resourceType: "token", unitTotal: "5" }));
  assert.equal(noOwner.message, enterpriseMessage("ORG_NO_OWNER", "zh"));
});

await check("taking quota back needs a reason; revoke takes all of it; refusals are sentences", async () => {
  api.calls.length = 0;
  assert.equal((await actions.reduceGrantAction("org_1", "grant_live", form({ units: "100", reason: "" }))).ok, false);
  assert.equal((await actions.revokeGrantAction("org_1", "grant_live", form({ reason: "" }))).ok, false);
  assert.equal(api.calls.length, 0, "no reason, no request");
  api.post = async () => ({ ok: true, status: 200, json: { ok: true, taken: 100 } });
  const reduced = await actions.reduceGrantAction("org_1", "grant_live", form({ units: "100", reason: "多输了一个 0" }));
  assert.deepEqual(lastCall(), ["POST", "/api/admin/enterprise/organizations/org_1/grants/grant_live/reduce", { units: 100, reason: "多输了一个 0" }]);
  assert.ok(reduced.message.includes("100"));
  await actions.revokeGrantAction("org_1", "grant_live", form({ reason: "合同取消" }));
  assert.deepEqual(lastCall()[2], { all: true, reason: "合同取消" });
  for (const code of ["GRANT_NOT_ACTIVE", "GRANT_NOTHING_LEFT", "GRANT_NOT_FOUND"]) {
    api.post = async () => ({ ok: false, status: 409, json: { ok: false, code } });
    const refused = await actions.reduceGrantAction("org_1", "grant_live", form({ units: "1", reason: "x" }));
    assert.equal(refused.message, enterpriseMessage(code, "zh"));
    noRawCode(refused.message);
  }
});

await check("the owner's initial password is reissued into the result, in the operator's language", async () => {
  api.post = async () => ({ ok: true, status: 200, json: { ok: true, owner: { loginName: "new-owner", initialPassword: "Again-2" } } });
  const again = await actions.reissueOwnerInitialPasswordAction("org_1", "u_new");
  assert.deepEqual(lastCall(), ["POST", "/api/admin/enterprise/organizations/org_1/owner-initial-password", { userId: "u_new" }]);
  assert.deepEqual(again.issued, [{ l: "new-owner", p: "Again-2" }]);
  LOCALE = "en";
  api.post = async () => ({ ok: false, status: 409, json: { ok: false, code: "OWNER_INITIAL_PASSWORD_UNAVAILABLE" } });
  const late = await actions.reissueOwnerInitialPasswordAction("org_1", "u_done");
  assert.equal(late.message, enterpriseMessage("OWNER_INITIAL_PASSWORD_UNAVAILABLE", "en"));
  LOCALE = "zh";
  // Every code the enterprise routes can answer these calls with has a sentence.
  for (const code of ["OWNER_NOT_REGISTERED", "ORG_NO_OWNER", "GRANT_NOT_ACTIVE", "GRANT_NOTHING_LEFT", "OWNER_INITIAL_PASSWORD_UNAVAILABLE", "WEEKLY_BUDGET_INVALID", "VALIDATION_ERROR"]) {
    assert.ok(ENTERPRISE_MESSAGE_CODES.includes(code), `${code} has a message`);
  }
});

console.log(`\n${checks} checks passed (admin enterprise pages)`);
