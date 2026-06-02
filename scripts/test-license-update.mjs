#!/usr/bin/env node
/**
 * Offline license and signed update manifest checks (no real Electron app).
 */
import { createRequire } from "node:module";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-license-test-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => tmp,
        getVersion: () => "0.1.0",
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
      },
      shell: {
        openExternal: async () => {},
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const {
  activateLicense,
  clearLicense,
  createLicenseToken,
  getLicenseStatus,
  requireValidLicense,
  verifyLicenseToken,
} = require("../src/main/license-manager.js");
const {
  createUpdateManifest,
  compareVersions,
} = require("../src/main/update-manager.js");
const { verifyDetached } = require("../src/main/crypto-signing.js");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const token = createLicenseToken({
  licenseId: "LIC-TEST-1",
  customer: "ACME",
  plan: "pro",
  issuedAt: "2026-01-01T00:00:00Z",
  expiresAt: "2027-01-01T00:00:00Z",
  features: ["workspace"],
}, privateKey);

const ok = verifyLicenseToken(token, publicKey, {
  nowMs: Date.parse("2026-06-01T00:00:00Z"),
});
if (!ok.ok || ok.license.licenseId !== "LIC-TEST-1") {
  throw new Error(`license verification failed: ${JSON.stringify(ok)}`);
}

const expired = verifyLicenseToken(token, publicKey, {
  nowMs: Date.parse("2028-01-01T00:00:00Z"),
});
if (expired.ok || expired.error !== "EXPIRED") {
  throw new Error("expired license should fail");
}

process.env.LILY_LICENSE_PUBLIC_KEY = publicKey;
clearLicense();
const blocked = requireValidLicense();
if (blocked.ok || blocked.error !== "LICENSE_REQUIRED") {
  throw new Error(`missing license should block gated features: ${JSON.stringify(blocked)}`);
}
const activated = activateLicense(token);
if (!activated.ok) {
  throw new Error(`valid license should activate: ${JSON.stringify(activated)}`);
}
const status = getLicenseStatus();
if (!status.activated || !status.valid) {
  throw new Error(`activated license should be valid: ${JSON.stringify(status)}`);
}
const allowed = requireValidLicense();
if (!allowed.ok) {
  throw new Error(`valid license should pass gate: ${JSON.stringify(allowed)}`);
}

const manifest = createUpdateManifest({
  version: "0.2.0",
  force: false,
  platforms: {
    "darwin-arm64": {
      url: "https://cdn.example.com/app.dmg",
      sha256: "abc",
    },
  },
}, privateKey);
const unsigned = { ...manifest };
delete unsigned.signature;
if (!verifyDetached(unsigned, manifest.signature, publicKey)) {
  throw new Error("signed update manifest failed verification");
}

if (compareVersions("0.2.0", "0.1.9") <= 0) {
  throw new Error("compareVersions should detect newer version");
}
if (compareVersions("0.1.0", "0.1.0") !== 0) {
  throw new Error("compareVersions equality failed");
}

console.log("license-update: ok");
