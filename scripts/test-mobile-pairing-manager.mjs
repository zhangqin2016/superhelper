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
    ...(overrides.makeQrImage ? { makeQrImage: overrides.makeQrImage } : {}),
  });
  return { mgr, calls, bridges };
}

// --- QR payload: carries reach + token, versioned, + scannable deep link -----
{
  const qr = buildQrPayload({ serverBaseUrl: "https://lily.example/", token: "mpt_x", desktopDeviceId: "dtop" });
  assert.equal(qr.v, 1);
  assert.equal(qr.url, "https://lily.example");
  assert.equal(qr.token, "mpt_x");
  assert.equal(qr.desktopDeviceId, "dtop");
  // The scan link opens the mobile page with API base (u) + one-time token (t).
  assert.equal(qr.scanUrl, "https://lily.example/m/pair#u=https%3A%2F%2Flily.example&t=mpt_x", "scanUrl is a deep link into /m/pair");
  // No server base → no scan link (paste-only), never a broken URL.
  assert.equal(buildQrPayload({ serverBaseUrl: "", token: "t", desktopDeviceId: "d" }).scanUrl, "");
}

// --- createChallenge → QR (image rendered from the scan link) -----------------
{
  const rendered = [];
  const { mgr } = makeManager({
    serviceFetch: async (pathname) => pathname.endsWith("/challenge")
      ? { ok: true, json: { ok: true, challengeId: "mpc_1", token: "mpt_raw", expiresAt: "2026-07-12T12:05:00Z" } }
      : { ok: true, json: { ok: true } },
    makeQrImage: async (text) => { rendered.push(text); return "data:image/png;base64,QQ=="; },
  });
  const res = await mgr.createChallenge();
  assert.equal(res.ok, true);
  assert.equal(res.challengeId, "mpc_1");
  assert.equal(res.qr.token, "mpt_raw", "the raw token goes into the QR");
  assert.equal(res.qr.url, "https://lily.example");
  assert.equal(res.qr.image, "data:image/png;base64,QQ==", "the rendered QR image rides the result");
  assert.equal(rendered[0], res.qr.scanUrl, "the QR image is rendered from the scan deep link");
}

// --- createChallenge is fail-open when QR rendering throws (text code only) ---
{
  const { mgr } = makeManager({
    serviceFetch: async (pathname) => pathname.endsWith("/challenge")
      ? { ok: true, json: { ok: true, challengeId: "mpc_2", token: "mpt_raw2", expiresAt: "2026-07-12T12:05:00Z" } }
      : { ok: true, json: { ok: true } },
    makeQrImage: async () => { throw new Error("no qr lib"); },
  });
  const res = await mgr.createChallenge();
  assert.equal(res.ok, true, "challenge still succeeds when QR rendering fails");
  assert.equal(res.qr.image, "", "image is empty; the text code carries pairing");
  assert.ok(res.qr.token, "the token is still present for manual paste");
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
