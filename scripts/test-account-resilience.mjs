#!/usr/bin/env node
// Account resilience: transient refresh failures must NOT silently log the
// user out, and the send path must auto-refresh stale entitlements before
// telling a logged-in user "please log in / buy".

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-account-resilience-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const serviceClientPath = require.resolve("../src/main/service-client.js");
const serviceMock = {
  refreshAccountAccessToken: async () => ({ ok: false, error: "MOCK_NOT_CONFIGURED" }),
  fetchAccountEntitlements: async () => ({ ok: false, error: "MOCK_NOT_CONFIGURED" }),
  setLicenseIdProvider: () => {},
};
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: serviceMock,
};

const accountManager = require("../src/main/account-manager.js");
const licenseManager = require("../src/main/license-manager.js");

function writeAccountState(state) {
  fs.writeFileSync(
    path.join(tmp, "account-state.json"),
    JSON.stringify({
      user: { id: "u1" },
      entitlements: { usable: true, tokenBalance: 1000 },
      // safeStorage unavailable under plain node → plain base64 (encrypted:false)
      refreshToken: { encrypted: false, data: Buffer.from("rt_test", "utf8").toString("base64") },
      loggedInAt: new Date().toISOString(),
      entitlementsRefreshedAt: new Date().toISOString(),
      ...state,
    }),
    "utf8",
  );
}

// 1. Network-level refresh failure (no HTTP status) → account SURVIVES.
{
  writeAccountState({});
  serviceMock.refreshAccountAccessToken = async () => ({
    ok: false,
    error: "SERVICE_REQUEST_FAILED",
    detail: "fetch failed",
  });
  const result = await accountManager.accessTokenForService();
  assert.equal(result.ok, false);
  assert.equal(result.transient, true, "network failure is transient");
  assert.equal(accountManager.accountStatus().loggedIn, true, "transient failure must not log the user out");
}

// 2. 5xx / 429 → also transient, account survives.
{
  writeAccountState({});
  serviceMock.refreshAccountAccessToken = async () => ({ ok: false, error: "SERVICE_REQUEST_FAILED", status: 503 });
  const result = await accountManager.accessTokenForService();
  assert.equal(result.transient, true);
  assert.equal(accountManager.accountStatus().loggedIn, true);
}

// 3. Server EXPLICITLY rejects the refresh token (401) → real logout.
{
  writeAccountState({});
  serviceMock.refreshAccountAccessToken = async () => ({ ok: false, error: "REFRESH_TOKEN_INVALID", status: 401 });
  const result = await accountManager.accessTokenForService();
  assert.equal(result.ok, false);
  assert.equal(result.transient, undefined, "explicit rejection is not transient");
  assert.equal(accountManager.accountStatus().loggedIn, false, "explicit 401 rejection must clear the account");
}

// 4. Send path: stale entitlements cache → requireValidLicenseFresh refreshes live.
{
  writeAccountState({
    entitlementsRefreshedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  let entitlementsFetched = 0;
  serviceMock.refreshAccountAccessToken = async () => ({
    ok: true,
    json: { accessToken: "at_test", expiresIn: 900 },
  });
  serviceMock.fetchAccountEntitlements = async () => {
    entitlementsFetched += 1;
    return { ok: true, json: { entitlements: { usable: true, tokenBalance: 5000 } } };
  };
  const syncVerdict = licenseManager.requireValidLicense();
  assert.equal(syncVerdict.ok, false, "sync check still reports stale cache");
  assert.equal(syncVerdict.accountError, "ACCOUNT_ENTITLEMENTS_STALE");
  const freshVerdict = await licenseManager.requireValidLicenseFresh();
  assert.equal(entitlementsFetched, 1, "send path must attempt exactly one live refresh");
  assert.equal(freshVerdict.ok, true, "refreshed entitlements must unblock the send");
  assert.equal(freshVerdict.source, "account");
}

// 5. Refresh itself fails transiently → verdict stays LICENSE_REQUIRED but the account survives.
{
  writeAccountState({
    entitlementsRefreshedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  });
  serviceMock.refreshAccountAccessToken = async () => ({ ok: false, error: "SERVICE_REQUEST_FAILED", status: 502 });
  serviceMock.fetchAccountEntitlements = async () => ({ ok: false, error: "SERVICE_REQUEST_FAILED", status: 502 });
  const verdict = await licenseManager.requireValidLicenseFresh();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error, "LICENSE_REQUIRED");
  assert.equal(accountManager.accountStatus().loggedIn, true, "failed refresh must not log the user out");
}

// 6. Genuinely zero balance (server confirms) → still LICENSE_REQUIRED, account intact.
{
  writeAccountState({
    entitlements: { usable: false, tokenBalance: 0 },
  });
  serviceMock.refreshAccountAccessToken = async () => ({ ok: true, json: { accessToken: "at_test", expiresIn: 900 } });
  serviceMock.fetchAccountEntitlements = async () => ({
    ok: true,
    json: { entitlements: { usable: false, tokenBalance: 0 } },
  });
  const verdict = await licenseManager.requireValidLicenseFresh();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.accountError, "ACCOUNT_ENTITLEMENTS_INSUFFICIENT");
  assert.equal(accountManager.accountStatus().loggedIn, true);
}

// A service's 401 can invalidate an otherwise fresh cached access token.
{
  let refreshes = 0;
  serviceMock.refreshAccountAccessToken = async () => {
    refreshes += 1;
    return { ok: true, json: { accessToken: "at_forced", expiresIn: 900 } };
  };
  const result = await accountManager.accessTokenForService({ forceRefresh: true });
  assert.equal(result.accessToken, "at_forced");
  assert.equal(refreshes, 1);
  assert.equal((await accountManager.accessTokenForService()).accessToken, "at_forced");
  assert.equal(refreshes, 1, "ordinary callers retain the existing cached-token behavior");
}
console.log("account-resilience: ok");
// A late refresh result or rejection belongs only to the session that began it.
for (const lateResult of [
  { ok: true, json: { accessToken: "alice-late-token", expiresIn: 900 } },
  { ok: false, status: 401, error: "REFRESH_TOKEN_INVALID" },
]) {
  accountManager.clearAccount();
  writeAccountState({ user: { id: "alice" } });
  let finishRefresh;
  serviceMock.refreshAccountAccessToken = () => new Promise((resolve) => { finishRefresh = resolve; });
  const refreshing = accountManager.accessTokenForService({ forceRefresh: true });
  accountManager.clearAccount();
  serviceMock.loginWithSms = async () => ({ ok: true, json: { user: { id: "bob" }, accessToken: "bob-token", refreshToken: "bob-refresh", expiresIn: 900 } });
  await accountManager.loginWithSms({ phone: "test", code: "test" });
  finishRefresh(lateResult);
  assert.equal((await refreshing).ok, false, "stale refresh never installs a token or signs out the new account");
  assert.equal(accountManager.accountStatus().user.id, "bob");
  assert.equal((await accountManager.accessTokenForService()).accessToken, "bob-token");
}
console.log("account refresh generation isolation: ok");
