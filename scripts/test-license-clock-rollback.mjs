#!/usr/bin/env node
// Clock-rollback resilience: a backwards-moving clock (CMOS/NTP/travel) must
// not brick an ACTIVATED user whose signed token is still valid — a rollback
// cannot extend an expired token, so valid tokens heal the marker instead of
// showing a bogus "please log in" until real time overtakes it.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-clock-rollback-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => tmp, getVersion: () => "0.1.0" }, safeStorage: { isEncryptionAvailable: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const serviceClientPath = require.resolve("../src/main/service-client.js");
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    setLicenseIdProvider: () => {},
    verifyLicense: async () => ({ ok: false, error: "NO_SERVICE_URL" }),
    registerDevice: async () => ({ ok: false, error: "NO_SERVICE_URL" }),
    getServiceSettings: () => ({ ok: false }),
  },
};

const {
  activateLicense,
  clearLicense,
  createLicenseToken,
  getLicenseStatus,
  requireValidLicense,
} = require("../src/main/license-manager.js");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.LILY_LICENSE_PUBLIC_KEY = publicKey;

function stateFile() {
  return path.join(tmp, "license-state.json");
}

function pushLastSeenTimeIntoFuture() {
  const state = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  state.lastSeenTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h in the "future"
  fs.writeFileSync(stateFile(), JSON.stringify(state));
}

// 1. Valid token + clock rollback → healed, still usable.
{
  clearLicense();
  const token = createLicenseToken({
    licenseId: "LIC-CLOCK-1",
    customer: "ACME",
    plan: "pro",
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    features: ["workspace"],
  }, privateKey);
  const activated = await activateLicense(token);
  assert.equal(activated.ok, true, `activation failed: ${JSON.stringify(activated)}`);
  pushLastSeenTimeIntoFuture();
  const status = getLicenseStatus();
  assert.equal(status.valid, true, "valid token must survive a clock rollback");
  assert.equal(status.clockAdjusted, true, "heal is marked for telemetry");
  assert.notEqual(status.error, "CLOCK_ROLLBACK");
  const required = requireValidLicense();
  assert.equal(required.ok, true, "send gate must stay open for a healed token");
  // Marker was healed — next read is a plain valid status.
  const after = getLicenseStatus();
  assert.equal(after.valid, true);
  assert.equal(after.clockAdjusted, undefined);
}

// 2. EXPIRED token + clock rollback → still blocked (rollback buys nothing).
{
  clearLicense();
  const expiredToken = createLicenseToken({
    licenseId: "LIC-CLOCK-2",
    customer: "ACME",
    plan: "pro",
    issuedAt: "2020-01-01T00:00:00Z",
    expiresAt: "2021-01-01T00:00:00Z",
    features: ["workspace"],
  }, privateKey);
  // activateLicense may reject expired tokens; write the state directly.
  const state = JSON.parse(fs.readFileSync(stateFile(), "utf8") || "{}");
  state.license = { encrypted: false, data: Buffer.from(expiredToken, "utf8").toString("base64") };
  state.lastSeenTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  fs.writeFileSync(stateFile(), JSON.stringify(state));
  const status = getLicenseStatus();
  assert.equal(status.valid, false, "expired token stays blocked even with a rollback");
  const required = requireValidLicense();
  assert.equal(required.ok, false);
}

console.log("license-clock-rollback: ok");
