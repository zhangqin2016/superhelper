#!/usr/bin/env node
import assert from "node:assert/strict";

const {
  smsRequestAllowedFromRegion,
} = await import("../server/src/services/sms-region-policy.js");

assert.equal(
  smsRequestAllowedFromRegion({ headers: { "cf-ipcountry": "US" } }).ok,
  false,
  "known non-China source country must be blocked before sending SMS",
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

console.log("sms-region-policy: ok");
