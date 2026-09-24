#!/usr/bin/env node
// The user's pairing actions over the signed service client.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createPairingApi, buildQrPayload } = require(path.join(ROOT, "src/main/mobile/pairing-api.js"));

// --- QR payload: reach + one-time token + a camera-openable deep link ---------
{
  const qr = buildQrPayload({ serverBaseUrl: "https://lily.example/", token: "mpt_x", desktopDeviceId: "dtop" });
  assert.deepEqual(qr, { v: 1, url: "https://lily.example", token: "mpt_x", desktopDeviceId: "dtop", scanUrl: "https://lily.example/m/pair#u=https%3A%2F%2Flily.example&t=mpt_x" });
  assert.equal(buildQrPayload({ serverBaseUrl: "", token: "t" }).scanUrl, "", "no base, no broken link");
}

function makeApi({ fetchImpl, token = { ok: true, accessToken: "acc" }, makeQrImage } = {}) {
  const calls = [];
  const api = createPairingApi({
    serviceFetch: async (pathname, opts = {}) => {
      calls.push({ pathname, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization });
      return fetchImpl ? fetchImpl(pathname, opts) : { ok: true, json: { ok: true } };
    },
    getAccountToken: async () => token,
    getDesktopDeviceId: () => "dtop",
    getServerBaseUrl: () => "https://lily.example",
    ...(makeQrImage ? { makeQrImage } : {}),
  });
  return { api, calls };
}

// --- challenge: QR image from the scan link; image failure is not a failure ----
{
  const rendered = [];
  const { api, calls } = makeApi({
    fetchImpl: async () => ({ ok: true, json: { ok: true, challengeId: "mpc_1", token: "mpt_raw", expiresAt: "2026-09-24T10:05:00Z" } }),
    makeQrImage: async (text) => { rendered.push(text); return "data:image/png;base64,QQ=="; },
  });
  const res = await api.createChallenge();
  assert.equal(res.ok, true);
  assert.equal(res.qr.token, "mpt_raw");
  assert.equal(res.qr.image, "data:image/png;base64,QQ==");
  assert.equal(rendered[0], res.qr.scanUrl);
  assert.deepEqual(calls[0], { pathname: "/api/mobile/pairing/challenge", method: "POST", body: { deviceId: "dtop" }, auth: "Bearer acc" }, "signed, with the desktop's device id");

  const broken = makeApi({
    fetchImpl: async () => ({ ok: true, json: { ok: true, challengeId: "mpc_2", token: "t2", expiresAt: "x" } }),
    makeQrImage: async () => { throw new Error("no qr lib"); },
  });
  const res2 = await broken.api.createChallenge();
  assert.equal(res2.ok, true, "the paste code still works without a QR image");
  assert.equal(res2.qr.image, "");
}

// --- signed out: a clear code, no request -------------------------------------
{
  const { api, calls } = makeApi({ token: { ok: false } });
  assert.equal((await api.createChallenge()).code, "ACCOUNT_LOGIN_REQUIRED");
  assert.equal((await api.approve("g1")).code, "ACCOUNT_LOGIN_REQUIRED");
  assert.equal(calls.length, 0);
}

// --- decisions ------------------------------------------------------------------
{
  const { api, calls } = makeApi();
  assert.deepEqual(await api.approve("g1"), { ok: true, grantId: "g1" });
  assert.deepEqual(await api.deny("g2"), { ok: true, grantId: "g2" });
  assert.deepEqual(await api.revoke("g3"), { ok: true, grantId: "g3" });
  assert.deepEqual(calls.map((c) => [c.pathname, c.body.grantId, c.body.reason]), [
    ["/api/mobile/pairing/approve", "g1", undefined],
    ["/api/mobile/pairing/deny", "g2", undefined],
    ["/api/mobile/pairing/revoke", "g3", "user_action"],
  ]);
  assert.equal((await api.approve("")).code, "PAIRING_APPROVE_INVALID");
  const lost = makeApi({ fetchImpl: async () => ({ ok: true, json: { ok: false, code: "PAIRING_NOT_PENDING" } }) });
  assert.equal((await lost.api.approve("g9")).code, "PAIRING_NOT_PENDING", "a lost race surfaces its code");
}

// --- capabilities: including the relay protocol the server speaks -------------
{
  const { api } = makeApi({ fetchImpl: async () => ({ ok: true, json: { ok: true, relay: { controlChannel: 2 }, capabilities: { voice: { enabled: false } } } }) });
  assert.deepEqual(await api.capabilities(), { ok: true, capabilities: { voice: { enabled: false } }, controlChannel: 2 });
  const old = makeApi({ fetchImpl: async () => ({ ok: true, json: { ok: true, capabilities: {} } }) });
  assert.equal((await old.api.capabilities()).controlChannel, 0, "a server without the control channel says so");
}

console.log("mobile-pairing-api: ok");
