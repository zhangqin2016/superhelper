#!/usr/bin/env node
// Desktop enterprise identity: the identity the user picks decides who pays,
// with NO silent billing fallback. These tests encode what the client must do
// when that identity stops working:
//   1. a selection whose organization is gone is cleared (and reported); one
//      that is frozen / paused / membership-disabled is kept, flagged, with a
//      one-click way back to personal — never a user stuck on 403s;
//   2. every gateway ORG_* refusal reads as a clear sentence in zh / en / ar
//      (weekly reset time in the user's locale), not as "top up" or "bad key";
//   3. an identity-switch toast reports what was actually saved.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-enterprise-identity-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const serviceClientPath = require.resolve("../src/main/service-client.js");
const fetchCalls = [];
const serviceMock = {
  refreshAccountAccessToken: async () => ({ ok: true, json: { accessToken: "at_test", expiresIn: 900 } }),
  fetchAccountEntitlements: async () => ({ ok: false, error: "MOCK" }),
  setLicenseIdProvider: () => {},
  serviceFetch: async () => ({ ok: false, error: "MOCK_NOT_CONFIGURED" }),
};
require.cache[serviceClientPath] = { id: serviceClientPath, filename: serviceClientPath, loaded: true, exports: serviceMock };

const identity = require("../src/main/organization-identity.js");
const accountManager = require("../src/main/account-manager.js");
const { classifyAssistantError, sanitizeError } = require("../src/main/agent-runner.js");
const { normalizeRunnerFailure } = require("../src/main/runner-failure.js");
const failurePolicy = require("../src/main/opencode-session-failure-policy.js");
const localeSettings = require("../src/main/locale-settings.js");
const view = await import("../src/renderer/modules/organization-identity-view.js");

const LOCALES = ["zh-CN", "en", "ar"];
const dictionaries = Object.fromEntries(LOCALES.map((locale) => [
  locale,
  JSON.parse(fs.readFileSync(new URL(`../src/renderer/i18n/locales/${locale}.json`, import.meta.url), "utf8")),
]));
function translator(locale) {
  const dict = dictionaries[locale];
  return (key, params = {}) => {
    assert.ok(Object.hasOwn(dict, key), `${locale} is missing i18n key ${key}`);
    return String(dict[key]).replace(/\{(\w+)\}/g, (_, name) => (params[name] ?? `{${name}}`));
  };
}

const ALL_CODES = [
  "ORG_NOT_FOUND", "ORG_SUSPENDED", "ORG_DISABLED", "ORG_MEMBER_REQUIRED", "ORG_MEMBER_DISABLED",
  "ORG_MEMBER_WEEKLY_LIMIT", "ORG_POOL_INSUFFICIENT", "ORG_MEMBER_QUOTA_EXCEEDED",
];
assert.deepEqual([...identity.ORG_IDENTITY_CODES].sort(), [...ALL_CODES].sort(), "the client knows exactly the server's ORG_* refusal codes");
assert.deepEqual([...view.ORG_SWITCHABLE_FAILURE_CODES].sort(), [...ALL_CODES].sort(), "every ORG_* refusal offers the switch back to personal");

// ---------------------------------------------------------------- 1. usability + stale-selection decision
const active = { id: "org_a", name: "Acme", status: "active", owner_status: "active", platform_status: "active", membership_status: "active" };
assert.equal(identity.organizationUnusableCode(active), "");
assert.equal(identity.organizationUnusableCode({ ...active, platform_status: "suspended", status: "disabled" }), "ORG_SUSPENDED", "a platform freeze is named first — the enterprise cannot lift it");
assert.equal(identity.organizationUnusableCode({ ...active, platform_status: "suspended", owner_status: "disabled", status: "disabled" }), "ORG_SUSPENDED");
assert.equal(identity.organizationUnusableCode({ ...active, owner_status: "disabled", status: "disabled" }), "ORG_DISABLED");
assert.equal(identity.organizationUnusableCode({ ...active, status: "disabled" }), "ORG_DISABLED");
assert.equal(identity.organizationUnusableCode({ ...active, membership_status: "disabled" }), "ORG_MEMBER_DISABLED");
assert.equal(identity.organizationUnusableCode({ id: "org_old", name: "Old server row" }), "", "a row without status fields (older server) is not blocked on unknowns");

const decide = (currentId, organizations) => identity.organizationSelectionDecision({ currentId, organizations });
assert.deepEqual(decide("", [active]), { action: "none", organizationId: "", code: "" }, "personal identity: nothing to decide");
assert.equal(decide("org_a", [active]).action, "keep");
assert.deepEqual(decide("org_gone", [active]), { action: "clear", organizationId: "org_gone", code: "ORG_MEMBER_REQUIRED" }, "removed / left / deleted: the selection is gone");
assert.deepEqual(decide("org_a", []), { action: "clear", organizationId: "org_a", code: "ORG_MEMBER_REQUIRED" }, "no orgs left at all still clears — never a hidden selector over a dead header");
for (const [row, code] of [
  [{ ...active, platform_status: "suspended", status: "disabled" }, "ORG_SUSPENDED"],
  [{ ...active, owner_status: "disabled", status: "disabled" }, "ORG_DISABLED"],
  [{ ...active, membership_status: "disabled" }, "ORG_MEMBER_DISABLED"],
]) {
  assert.deepEqual(decide("org_a", [row]), { action: "flag", organizationId: "org_a", code }, `${code}: kept and flagged, not silently swapped to personal billing`);
}

// ---------------------------------------------------------------- 1b. fetchOrganizations applies it (real account-manager, mocked HTTP)
function writeAccountState(state) {
  fs.writeFileSync(path.join(tmp, "account-state.json"), JSON.stringify({
    user: { id: "u1" },
    refreshToken: { encrypted: false, data: Buffer.from("rt_test", "utf8").toString("base64") },
    loggedInAt: new Date().toISOString(),
    ...state,
  }), "utf8");
}
const readAccountState = () => JSON.parse(fs.readFileSync(path.join(tmp, "account-state.json"), "utf8"));
const RESETS_AT = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
function mockServer({ organizations, me = { ok: true, weeklyBudget: 1000, weeklyUsed: 250, resetsAt: RESETS_AT, limited: false, perRequestCap: null }, listOk = true }) {
  fetchCalls.length = 0;
  serviceMock.serviceFetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (url === "/api/enterprise/organizations") return listOk ? { ok: true, json: { ok: true, organizations } } : { ok: false, error: "SERVICE_REQUEST_FAILED", status: 503 };
    const match = /^\/api\/enterprise\/organizations\/([^/]+)$/.exec(url);
    if (match) return { ok: true, json: { ok: true, organization: { id: decodeURIComponent(match[1]), me } } };
    return { ok: false, error: "UNEXPECTED" };
  };
}

{
  // Gone: cleared, reported with the name it had.
  writeAccountState({ currentOrganizationId: "org_gone", organizations: [{ id: "org_gone", name: "Gone Ltd" }], organizationMe: { organizationId: "org_gone", resetsAt: RESETS_AT } });
  mockServer({ organizations: [active] });
  const result = await accountManager.fetchOrganizations();
  assert.equal(result.ok, true);
  assert.equal(result.selection.action, "clear");
  assert.equal(result.selection.organizationName, "Gone Ltd", "the notice can name the organization the user lost");
  assert.equal(result.currentOrganizationId, "");
  assert.equal(accountManager.getCurrentOrganizationId(), "", "the header source reads personal now — requests stop 403ing");
  assert.equal(readAccountState().organizationMe, undefined, "a gone org's weekly cache is dropped");
  assert.equal(result.organizations[0].unusableCode, "", "rows arrive annotated by the single usability rule");
}
{
  // Frozen: kept + flagged, no detail fetch, header unchanged (no silent billing switch).
  const frozen = { ...active, platform_status: "suspended", status: "disabled" };
  writeAccountState({ currentOrganizationId: "org_a" });
  mockServer({ organizations: [frozen] });
  const result = await accountManager.fetchOrganizations();
  assert.deepEqual(result.selection, { action: "flag", organizationId: "org_a", code: "ORG_SUSPENDED" });
  assert.equal(accountManager.getCurrentOrganizationId(), "org_a", "frozen is NOT gone: the selection stays, visibly flagged");
  assert.equal(result.organizations[0].unusableCode, "ORG_SUSPENDED");
  assert.equal(fetchCalls.length, 1, "no member-week lookup for an unusable org");
}
{
  // Usable: detail `me` fetched with the bearer token and cached for the chat error.
  writeAccountState({ currentOrganizationId: "org_a" });
  mockServer({ organizations: [active] });
  const result = await accountManager.fetchOrganizations();
  assert.equal(result.selection.action, "keep");
  assert.equal(result.currentOrganizationMe.weeklyBudget, 1000);
  assert.equal(fetchCalls[1].url, "/api/enterprise/organizations/org_a");
  assert.equal(fetchCalls[1].options.headers.Authorization, "Bearer at_test");
  assert.equal(accountManager.getCurrentOrganizationMe().resetsAt, RESETS_AT);
  accountManager.setCurrentOrganizationId("org_other");
  assert.equal(accountManager.getCurrentOrganizationMe(), null, "a cached week never leaks onto another organization");
}
{
  // A failed refresh proves nothing: selection untouched.
  writeAccountState({ currentOrganizationId: "org_a" });
  mockServer({ organizations: [], listOk: false });
  const result = await accountManager.fetchOrganizations();
  assert.equal(result.ok, false);
  assert.equal(accountManager.getCurrentOrganizationId(), "org_a", "network failure must not clear the selection");
}

// ---------------------------------------------------------------- 2. code -> message (all codes, 3 locales)
const now = Date.parse("2026-10-01T00:00:00.000Z");
const resetsAt = "2026-10-03T08:30:00.000Z";
for (const code of ALL_CODES) {
  const texts = LOCALES.map((locale) => identity.organizationFailureMessage(code, { locale, resetsAt, now }));
  texts.forEach((text, i) => {
    assert.ok(text && text.length > 20, `${code}/${LOCALES[i]} has a real sentence`);
    assert.doesNotMatch(text, /\{\w+\}/, `${code}/${LOCALES[i]} has no unfilled placeholder`);
    assert.doesNotMatch(text, /ORG_[A-Z_]+/, `${code}/${LOCALES[i]} does not show the raw code`);
  });
  assert.equal(new Set(texts).size, 3, `${code} is translated per locale`);
  // A sentence we produced must not be relabeled by a later sanitize pass.
  for (const text of texts) assert.equal(classifyAssistantError(text), null, `${code} copy must not re-classify as another failure: ${text}`);
}
for (const locale of LOCALES) {
  const weekly = identity.organizationFailureMessage("ORG_MEMBER_WEEKLY_LIMIT", { locale, resetsAt, now });
  const expected = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(resetsAt));
  assert.ok(weekly.includes(expected), `${locale} weekly limit names the reset time in the user's locale (${expected})`);
  const noTime = identity.organizationFailureMessage("ORG_MEMBER_WEEKLY_LIMIT", { locale, resetsAt: "", now });
  assert.equal(noTime, identity.ORG_FAILURE_COPY[locale].ORG_MEMBER_WEEKLY_LIMIT_NO_TIME, "unknown reset time: honest generic copy");
  const past = identity.organizationFailureMessage("ORG_MEMBER_WEEKLY_LIMIT", { locale, resetsAt: "2026-09-01T00:00:00Z", now });
  assert.equal(past, noTime, "a reset time already in the past is never presented as upcoming");
  // guidance: admin/platform for pool and frozen; the switch-to-personal way out
  const pool = identity.organizationFailureMessage("ORG_POOL_INSUFFICIENT", { locale });
  const frozen = identity.organizationFailureMessage("ORG_SUSPENDED", { locale });
  const admin = { "zh-CN": "企业管理员", en: "enterprise admin", ar: "مسؤول مؤسستك" }[locale];
  const platform = { "zh-CN": "平台", en: "platform", ar: "المنصة" }[locale];
  assert.ok(pool.includes(admin), `${locale} pool-empty points at the enterprise admin`);
  assert.ok(frozen.includes(admin) && frozen.includes(platform), `${locale} frozen points at admin + platform`);
}

// Classifier: the gateway's raw refusal text -> the org code, localized at failure time.
localeSettings.setLocale("en");
for (const code of ALL_CODES) {
  const type = code.startsWith("ORG_MEMBER_WEEKLY") || code === "ORG_POOL_INSUFFICIENT" || code === "ORG_MEMBER_QUOTA_EXCEEDED" ? "402 payment_required" : "403 org_forbidden";
  const classified = classifyAssistantError(`Request failed: ${type} ${code}`);
  assert.equal(classified?.code, code, `${type} ${code} is classified as itself, not quota/auth/connection`);
  assert.equal(classified.retryable, false, `${code}: the same identity is refused the same way — no blind replay`);
  const bare = classifyAssistantError(code);
  assert.equal(bare?.code, code, `${code} alone (the gateway error.message) classifies`);
}
assert.equal(classifyAssistantError("Request failed: 402 payment_required ORG_MEMBER_QUOTA_EXCEEDED").code, "ORG_MEMBER_QUOTA_EXCEEDED", "the per-request cap is not a personal top-up");
assert.notEqual(classifyAssistantError("XORG_SUSPENDEDX")?.code, "ORG_SUSPENDED", "codes match as whole tokens only");
// Personal identity unchanged.
const personal = classifyAssistantError("Request failed: 402 payment_required ENTITLEMENT_INSUFFICIENT");
assert.equal(personal.code, "QUOTA_EXCEEDED", "ENTITLEMENT_INSUFFICIENT under personal identity keeps today's behaviour");
assert.equal(personal.message, "Insufficient account balance or quota. Please top up your account, then retry.");

// Locale-aware at failure time; weekly reset from the error body when present, else the cached week.
localeSettings.setLocale("zh-CN");
assert.equal(sanitizeError("403 org_forbidden ORG_DISABLED"), identity.ORG_FAILURE_COPY["zh-CN"].ORG_DISABLED);
localeSettings.setLocale("ar");
assert.equal(sanitizeError("403 org_forbidden ORG_DISABLED"), identity.ORG_FAILURE_COPY.ar.ORG_DISABLED);
localeSettings.setLocale("en");
{
  const future = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
  const text = classifyAssistantError(`402 payment_required {"message":"ORG_MEMBER_WEEKLY_LIMIT","resetsAt":"${future}"}`).message;
  assert.ok(text.includes(identity.formatResetTime(future, "en")), "reset time read from the refusal body when the engine kept it");
  writeAccountState({ currentOrganizationId: "org_a", organizationMe: { organizationId: "org_a", resetsAt: future } });
  const cached = classifyAssistantError("402 payment_required ORG_MEMBER_WEEKLY_LIMIT").message;
  assert.ok(cached.includes(identity.formatResetTime(future, "en")), "else from the member's cached week for the current org");
}

// Runner envelope: a 403 status must not override the org code with a generic "HTTP 403".
{
  const { classified } = normalizeRunnerFailure("ORG_MEMBER_REQUIRED", { name: "AI_APICallError", data: { message: "ORG_MEMBER_REQUIRED", statusCode: 403, isRetryable: false } });
  assert.equal(classified.code, "ORG_MEMBER_REQUIRED");
  assert.equal(classified.message, identity.ORG_FAILURE_COPY.en.ORG_MEMBER_REQUIRED);
}
// A gateway-token 403 org refusal is not a stale token: no config refresh + replay.
{
  const spawnOptions = { modelRouteAudit: { keyKind: "gateway-token", route: "gateway" } };
  const classified = classifyAssistantError("403 org_forbidden ORG_SUSPENDED");
  assert.equal(failurePolicy.isManagedGatewayAuthFailure(classified, "403 org_forbidden ORG_SUSPENDED", spawnOptions), false);
  assert.equal(failurePolicy.isSafeReplayableModelFailure(classified, "403 org_forbidden ORG_SUSPENDED", spawnOptions), false);
  assert.equal(failurePolicy.isManagedGatewayAuthFailure({ code: "AUTH_FAILED" }, "403 unauthorized", spawnOptions), true, "a real gateway 403 auth failure still self-heals");
}

// ---------------------------------------------------------------- 3. selector labels, weekly line, notices (3 locales)
for (const locale of LOCALES) {
  const t = translator(locale);
  for (const code of ["ORG_SUSPENDED", "ORG_DISABLED", "ORG_MEMBER_DISABLED"]) {
    const row = { id: "org_a", name: "Acme", unusableCode: code };
    assert.equal(view.organizationOptionLabel(row, t), `Acme (${dictionaries[locale][`orgIdentity.label.${code}`]})`, `${locale}: unusable org is labeled`);
    assert.equal(view.organizationOptionDisabled(row), true, "an unusable org cannot be newly picked");
    const notice = view.organizationSelectionNotice({ selection: { action: "flag", organizationId: "org_a", code } }, [row], t);
    assert.equal(notice.kind, "warning");
    assert.equal(notice.offerSwitch, true, "flagged selection always offers the one-click switch");
    assert.ok(notice.text.includes("Acme"));
  }
  assert.equal(view.organizationOptionLabel({ id: "org_a", name: "Acme", unusableCode: "" }, t), "Acme");
  assert.equal(view.organizationOptionDisabled({ id: "org_a", unusableCode: "" }), false);
  const cleared = view.organizationSelectionNotice({ selection: { action: "clear", organizationId: "org_gone", organizationName: "Gone Ltd", code: "ORG_MEMBER_REQUIRED" } }, [], t);
  assert.ok(cleared.text.includes("Gone Ltd") && cleared.kind === "info", `${locale}: the user is told they are on personal now`);
  const clearedUnnamed = view.organizationSelectionNotice({ selection: { action: "clear", organizationId: "org_gone" } }, [], t);
  assert.ok(clearedUnnamed.text.includes(dictionaries[locale]["orgIdentity.unknownOrg"]));
  assert.equal(view.organizationSelectionNotice({ selection: { action: "keep" } }, [], t).text, "");

  const me = { ok: true, weeklyBudget: 1000, weeklyUsed: 250, resetsAt, limited: false };
  const weekly = view.organizationWeeklyText(me, t, locale, now);
  const nf = new Intl.NumberFormat(locale);
  assert.ok(weekly.includes(nf.format(250)) && weekly.includes(nf.format(1000)), `${locale}: used / budget shown`);
  assert.ok(weekly.includes(new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(resetsAt))), `${locale}: reset time in locale`);
  assert.equal(view.organizationWeeklyText({ ...me, weeklyBudget: null }, t, locale, now), "", "no budget -> no line");
  assert.equal(view.organizationWeeklyText({ ok: false, code: "ORG_MEMBER_REQUIRED" }, t, locale, now), "");
  assert.equal(view.organizationWeeklyText({ ...me, limited: true }, t, locale, now).includes(dictionaries[locale]["orgIdentity.weeklyLimited"].split("{")[0].trim().slice(0, 4)), true);
  assert.equal(view.organizationWeeklyText({ ...me, resetsAt: null }, t, locale, now), t("orgIdentity.weeklyNoReset", { used: nf.format(250), budget: nf.format(1000) }));
}

// Chat action is offered on ORG_* failures only.
assert.equal(view.shouldOfferPersonalSwitch({ failed: true, record: { failure: { errorCode: "ORG_POOL_INSUFFICIENT" } } }), true);
assert.equal(view.shouldOfferPersonalSwitch({ failed: true, record: { failureCode: "ORG_SUSPENDED" } }), true);
assert.equal(view.shouldOfferPersonalSwitch({ failed: true, record: { failure: { errorCode: "QUOTA_EXCEEDED" } } }), false, "personal top-up failure keeps today's actions");
assert.equal(view.shouldOfferPersonalSwitch({ failed: false, record: { failure: { errorCode: "ORG_SUSPENDED" } } }), false);

// ---------------------------------------------------------------- 4. toast honesty
for (const locale of LOCALES) {
  const t = translator(locale);
  const failed = t("orgIdentity.switchFailed");
  assert.deepEqual(view.organizationSwitchOutcome({ ok: true, organizationId: "org_a" }, "org_a", t), { ok: true, text: t("settings.accountOrgSet"), kind: "success" });
  assert.deepEqual(view.organizationSwitchOutcome({ ok: true, organizationId: "" }, "", t), { ok: true, text: t("orgIdentity.switchedPersonal"), kind: "success" });
  assert.equal(view.organizationSwitchOutcome(undefined, "org_a", t, new Error("ipc down")).text, failed, "a thrown IPC call is a failure, not 'switched'");
  assert.equal(view.organizationSwitchOutcome({ ok: false, error: "X" }, "org_a", t).kind, "error");
  assert.equal(view.organizationSwitchOutcome({ ok: true, organizationId: "" }, "org_a", t).ok, false, "account feature disabled answers ok with '' — the org was NOT set");
  assert.equal(view.organizationSwitchOutcome(null, "", t).ok, false);
}
{
  const source = fs.readFileSync(new URL("../src/renderer/modules/account-organizations.js", import.meta.url), "utf8");
  const load = source.slice(source.indexOf("export async function loadOrganizations()"));
  assert.ok(load.length > 200, "loadOrganizations lives in account-organizations.js");
  assert.doesNotMatch(load, /catch\s*\{[^}]*\}\s*showToast\(/, "no toast after a swallowed failure");
  assert.doesNotMatch(load, /showToast\(\s*nextId \? t\("settings\.accountOrgSet"\)/, "the old unconditional 'switched' toast is gone");
  assert.match(source, /organizationSwitchOutcome\(result, nextId, t, error\)/, "the toast is decided by what was saved");
  assert.doesNotMatch(load, /card\.hidden = rows\.length === 0;/, "the selector must not vanish while a selection (or its notice) still exists");
  const modelConfig = fs.readFileSync(new URL("../src/main/runtime/opencode-model-config.js", import.meta.url), "utf8");
  assert.equal((modelConfig.match(/x-lily-organization-id/g) || []).length, 1, "the org header is injected in exactly one place");
  const mainFiles = ["account-manager.js", "organization-identity.js", "ipc-handlers.js", "agent-runner.js"].map((f) => fs.readFileSync(new URL(`../src/main/${f}`, import.meta.url), "utf8"));
  for (const text of mainFiles) assert.doesNotMatch(text, /x-lily-organization-id/, "no second place decides the org header");
}

console.log("test-enterprise-identity-client: ok");
