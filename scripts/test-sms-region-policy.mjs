#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  smsRequestAllowedFromRegion,
} = await import("../server/src/services/sms-region-policy.js");

assert.equal(
  smsRequestAllowedFromRegion({ headers: { "cf-ipcountry": "US" } }).ok,
  false,
  "known non-China source country must be blocked before sending SMS",
);
assert.equal(
  smsRequestAllowedFromRegion({ headers: { "x-forwarded-for": "5.30.0.1, 101.200.232.184" } }).ok,
  false,
  "UAE client IP must be blocked before sending SMS even without geo headers",
);
assert.equal(
  smsRequestAllowedFromRegion({ headers: { "cf-ipcountry": "CN" } }).ok,
  true,
  "China source country can request SMS",
);
assert.equal(
  smsRequestAllowedFromRegion({ headers: {} }).ok,
  true,
  "missing geo headers should not break local/dev or undecorated reverse proxies",
);
assert.equal(
  smsRequestAllowedFromRegion({ headers: { "x-lily-region": "uae" } }).ok,
  false,
  "explicit overseas region hint must be blocked",
);
assert.equal(
  smsRequestAllowedFromRegion(
    { headers: { "x-lily-region": "uae", "cf-ipcountry": "AE" } },
    { phoneE164: "+8618210178959", env: { SMS_REGION_BYPASS_PHONES: "18210178959" } },
  ).ok,
  true,
  "configured bypass phone can request SMS from overseas",
);
assert.equal(
  smsRequestAllowedFromRegion(
    { headers: { "x-lily-region": "uae", "cf-ipcountry": "AE" } },
    { phoneE164: "+8618210178960", env: { SMS_REGION_BYPASS_PHONES: "18210178959" } },
  ).ok,
  false,
  "overseas SMS remains blocked for non-bypass phones",
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicAuth = fs.readFileSync(path.join(root, "server/src/routes/public/auth.js"), "utf8");
const bypassedAccountLoginGates = publicAuth.match(
  /regionAllowed\.bypass\s*!==\s*["']phone["']\s*&&\s*!clientFeatureEnabled\(request,\s*["']accountLogin["']\)/g,
);
assert.equal(
  bypassedAccountLoginGates?.length,
  2,
  "phone bypass must skip the overseas account-login feature gate for both SMS send and SMS login",
);

console.log("sms-region-policy: ok");
