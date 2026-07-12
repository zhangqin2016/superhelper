#!/usr/bin/env node
// Desktop pairing manager orchestration. Injectable I/O, no Electron/network.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createMobilePairingManager, buildQrPayload } = require(path.join(ROOT, "src/main/mobile-pairing-manager.js"));

function makeManager(overrides = {}) {
  const calls = [];
  const bridges = [];
  const mgr = createMobilePairingManager({
    serviceFetch: overrides.serviceFetch || (async (pathname, opts) => { calls.push({ pathname, body: JSON.parse(opts.body), headers: opts.headers }); return { ok: true, json: { ok: true } }; }),
    getAccountToken: overrides.getAccountToken || (async () => ({ ok: true, accessToken: "acc_tok" })),
    getDesktopDeviceId: () => "dtop",
    getServerBaseUrl: () => "https://lily.example",
    getRelayUrl: () => "wss://lily.example",
    startBridge: (opts) => { const b = { ...opts, started: false, connected: true, start() { this.started = true; }, stop() { this.connected = false; }, isConnected() { return this.connected; } }; bridges.push(b); return b; },
  });
  return { mgr, calls, bridges };
}

// --- QR payload: carries reach + token, versioned ---------------------------
{
  const qr = buildQrPayload({ serverBaseUrl: "https://lily.example/", token: "mpt_x", desktopDeviceId: "dtop" });
  assert.deepEqual(qr, { v: 1, url: "https://lily.example", token: "mpt_x", desktopDeviceId: "dtop" });
}

// --- createChallenge → QR ----------------------------------------------------
{
  const { mgr, calls } = makeManager({
    serviceFetch: async (pathname) => pathname.endsWith("/challenge")
      ? { ok: true, json: { ok: true, challengeId: "mpc_1", token: "mpt_raw", expiresAt: "2026-07-12T12:05:00Z" } }
      : { ok: true, json: { ok: true } },
  });
  const res = await mgr.createChallenge();
  assert.equal(res.ok, true);
  assert.equal(res.challengeId, "mpc_1");
  assert.equal(res.qr.token, "mpt_raw", "the raw token goes into the QR");
  assert.equal(res.qr.url, "https://lily.example");
}

// --- account not logged in → challenge fails cleanly -------------------------
{
  const { mgr } = makeManager({ getAccountToken: async () => ({ ok: false }) });
  const res = await mgr.createChallenge();
  assert.equal(res.ok, false);
  assert.equal(res.code, "ACCOUNT_LOGIN_REQUIRED");
}

// --- pollPending returns the desktop's pending grants -----------------------
{
  const seen = [];
  const { mgr } = makeManager({
    serviceFetch: async (pathname, opts) => {
      seen.push({ pathname, body: JSON.parse(opts.body), headers: opts.headers });
      return pathname.endsWith("/pending")
        ? { ok: true, json: { ok: true, grants: [{ grantId: "mpg_1", mobileDeviceId: "dmob" }] } }
        : { ok: true, json: { ok: true } };
    },
  });
  const res = await mgr.pollPending();
  assert.equal(res.ok, true);
  assert.equal(res.grants.length, 1);
  assert.equal(res.grants[0].grantId, "mpg_1");
  // desktop device id + account token are always sent on the signed request
  assert.equal(seen.at(-1).body.deviceId, "dtop");
  assert.equal(seen.at(-1).headers.Authorization, "Bearer acc_tok");
}

// --- approve → grant active AND relay bridge started for that grant ----------
{
  const { mgr, bridges } = makeManager();
  const res = await mgr.approve("mpg_1");
  assert.equal(res.ok, true);
  assert.equal(res.bridged, true, "approval brings the relay bridge online");
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].grantId, "mpg_1");
  assert.equal(bridges[0].started, true, "the bridge is started");
  assert.match(bridges[0].relayUrl, /\/api\/mobile\/relay$/, "relay path is appended");
  assert.equal(mgr.isBridged(), true);
}

// --- approve rejected by server → no bridge ---------------------------------
{
  const { mgr, bridges } = makeManager({
    serviceFetch: async (pathname) => pathname.endsWith("/approve")
      ? { ok: true, json: { ok: false, code: "PAIRING_NOT_PENDING" } }
      : { ok: true, json: { ok: true } },
  });
  const res = await mgr.approve("mpg_late");
  assert.equal(res.ok, false);
  assert.equal(res.code, "PAIRING_NOT_PENDING", "a lost compare-and-set surfaces");
  assert.equal(bridges.length, 0, "no bridge on a failed approval");
}

// --- revoke of the active grant tears the bridge down -----------------------
{
  const { mgr } = makeManager();
  await mgr.approve("mpg_1");
  assert.equal(mgr.isBridged(), true);
  const res = await mgr.revoke("mpg_1", "user_action");
  assert.equal(res.ok, true);
  assert.equal(mgr.isBridged(), false, "revoking the active grant stops the bridge");
}

console.log("mobile-pairing-manager: ok");
