#!/usr/bin/env node
// Licence-code (授权码) refusals on the desktop client. A licensed device with
// no signed-in account whose licence pool is used up gets
// 402 payment_required LICENSE_WEEKLY_LIMIT (+ resetsAt); a lapsed licence gets
// LICENSE_UNAVAILABLE. Both must read as a clear zh / en / ar sentence (the
// weekly one with the reset time in the user's locale and the "sign in to use
// your personal credits" way out) — never "top up your account" — and must not
// be replayed.
// Run: node scripts/test-license-limit-client.mjs

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-license-limit-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const license = require("../src/main/license-limit.js");
const identity = require("../src/main/organization-identity.js");
const { classifyAssistantError, sanitizeError } = require("../src/main/agent-runner.js");
const { normalizeRunnerFailure } = require("../src/main/runner-failure.js");
const failurePolicy = require("../src/main/opencode-session-failure-policy.js");
const localeSettings = require("../src/main/locale-settings.js");

let checks = 0;
const ok = (name) => { checks += 1; console.log(`ok - ${name}`); };

const CODES = ["LICENSE_WEEKLY_LIMIT", "LICENSE_UNAVAILABLE"];
const LOCALES = ["zh-CN", "en", "ar"];
const now = Date.parse("2026-09-30T08:00:00Z");
const resetsAt = "2026-10-03T02:00:00.000Z";

assert.deepEqual([...license.LICENSE_LIMIT_CODES].sort(), [...CODES].sort());
const serverSource = fs.readFileSync(new URL("../server/src/services/license-credits.js", import.meta.url), "utf8");
for (const code of CODES) assert.ok(serverSource.includes(`"${code}"`), `the server really answers ${code}`);
ok("the client knows exactly the server's licence refusal codes");

// Copy: every locale, no raw code, weekly carries the locale's reset time.
for (const locale of LOCALES) {
  const copy = license.LICENSE_FAILURE_COPY[locale];
  for (const key of ["LICENSE_WEEKLY_LIMIT", "LICENSE_WEEKLY_LIMIT_NO_TIME", "LICENSE_UNAVAILABLE"]) {
    assert.ok(copy[key] && copy[key].length > 20, `${locale}/${key} has a sentence`);
    assert.doesNotMatch(copy[key], /LICENSE_[A-Z_]+/, `${locale}/${key} never shows the raw code`);
  }
  const weekly = license.licenseFailureMessage("LICENSE_WEEKLY_LIMIT", { locale, resetsAt, now });
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(resetsAt));
  assert.ok(weekly.includes(time), `${locale}: reset time in the user's locale (${time})`);
  assert.doesNotMatch(weekly, /\{time\}/);
  assert.equal(license.licenseFailureMessage("LICENSE_WEEKLY_LIMIT", { locale, resetsAt: "", now }), copy.LICENSE_WEEKLY_LIMIT_NO_TIME, `${locale}: unknown reset -> honest generic copy`);
  assert.equal(license.licenseFailureMessage("LICENSE_WEEKLY_LIMIT", { locale, resetsAt: "2026-09-01T00:00:00Z", now }), copy.LICENSE_WEEKLY_LIMIT_NO_TIME, `${locale}: a past reset is not shown`);
  assert.equal(license.licenseFailureMessage("LICENSE_UNAVAILABLE", { locale }), copy.LICENSE_UNAVAILABLE);
}
assert.equal(license.LICENSE_FAILURE_COPY["zh-CN"].LICENSE_WEEKLY_LIMIT.startsWith("本授权码本周积分已用完，{time} 重置；登录账号后可用个人积分继续"), true, "zh wording as specified");
assert.match(license.LICENSE_FAILURE_COPY["zh-CN"].LICENSE_UNAVAILABLE, /过期|停用/);
assert.match(license.LICENSE_FAILURE_COPY["zh-CN"].LICENSE_UNAVAILABLE, /管理员/);
assert.match(license.LICENSE_FAILURE_COPY["zh-CN"].LICENSE_UNAVAILABLE, /登录/);
assert.equal(license.licenseFailureMessage("ORG_SUSPENDED", { locale: "en" }), "", "not a licence code -> nothing");
ok("zh / en / ar copy: weekly with locale reset time or honest fallback, unavailable points at admin + sign-in");

// Classifier: the gateway's raw refusal -> the licence code, not QUOTA_EXCEEDED.
localeSettings.setLocale("en");
for (const code of CODES) {
  for (const raw of [
    `Request failed: 402 payment_required ${code}`,
    code,
    `402 {"error":{"type":"payment_required","message":"${code}","weeklyBudget":10000,"weeklyUsed":10020}}`,
  ]) {
    const classified = classifyAssistantError(raw);
    assert.equal(classified?.code, code, `${raw} -> ${code}`);
    assert.equal(classified.retryable, false, `${code}: no blind replay`);
    assert.doesNotMatch(classified.message, /top up/i, `${code}: not the personal top-up advice`);
  }
}
assert.notEqual(classifyAssistantError("XLICENSE_WEEKLY_LIMITX")?.code, "LICENSE_WEEKLY_LIMIT", "whole tokens only");
assert.equal(classifyAssistantError("Request failed: 402 payment_required ENTITLEMENT_INSUFFICIENT").code, "QUOTA_EXCEEDED", "personal 402 unchanged");
assert.equal(classifyAssistantError("Request failed: 402 payment_required ORG_MEMBER_WEEKLY_LIMIT").code, "ORG_MEMBER_WEEKLY_LIMIT", "org codes unchanged");
ok("classifier: licence codes win over the generic 402, personal and org codes unchanged");

// Locale at failure time; reset time read from the refusal body.
localeSettings.setLocale("zh-CN");
assert.equal(sanitizeError("402 payment_required LICENSE_UNAVAILABLE"), license.LICENSE_FAILURE_COPY["zh-CN"].LICENSE_UNAVAILABLE);
localeSettings.setLocale("ar");
assert.equal(sanitizeError("402 payment_required LICENSE_UNAVAILABLE"), license.LICENSE_FAILURE_COPY.ar.LICENSE_UNAVAILABLE);
localeSettings.setLocale("en");
{
  const future = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
  const text = classifyAssistantError(`402 payment_required {"message":"LICENSE_WEEKLY_LIMIT","resetsAt":"${future}"}`).message;
  assert.ok(text.includes(identity.formatResetTime(future, "en")), "reset time read from the refusal body");
  assert.equal(classifyAssistantError("402 payment_required LICENSE_WEEKLY_LIMIT").message, license.LICENSE_FAILURE_COPY.en.LICENSE_WEEKLY_LIMIT_NO_TIME, "no body -> generic weekly copy");
}
ok("the sentence is written in the user's current locale, with the reset time from the body");

// Runner envelope + replay policy.
{
  const { classified } = normalizeRunnerFailure("LICENSE_WEEKLY_LIMIT", { name: "AI_APICallError", data: { message: "LICENSE_WEEKLY_LIMIT", statusCode: 402, isRetryable: false } });
  assert.equal(classified.code, "LICENSE_WEEKLY_LIMIT");
  const spawnOptions = { modelRouteAudit: { keyKind: "gateway-token", route: "gateway" } };
  const raw = "402 payment_required LICENSE_UNAVAILABLE";
  const refused = classifyAssistantError(raw);
  assert.equal(failurePolicy.isSafeReplayableModelFailure(refused, raw, spawnOptions), false, "not replayed");
  assert.equal(failurePolicy.isManagedGatewayAuthFailure(refused, raw, spawnOptions), false, "not treated as a stale gateway token");
}
ok("runner envelope keeps the licence code; the refusal is not replayed");

console.log(`\n${checks} checks passed`);
