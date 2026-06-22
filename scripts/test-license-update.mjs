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
        isEncryptionAvailable: () => globalThis.__safeStorageAvailable || false,
        encryptString: (text) => Buffer.from(String(text), "utf8"),
        decryptString: (buf) => {
          if (globalThis.__safeStorageThrow) throw new Error("decrypt failed");
          return Buffer.from(buf).toString("utf8");
        },
      },
      shell: {
        openExternal: async () => {},
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
// Stub service-client BEFORE license-manager loads — it captures the module
// at require time (top-level dependency), not per call.
const serviceClientPath = require.resolve("../src/main/service-client.js");
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    setLicenseIdProvider: () => {},
    verifyLicense: async () => ({ ok: false, error: "NO_SERVICE_URL" }),
    registerDevice: async () => ({
      ok: true,
      json: {
        ok: true,
        trial: {
          enabled: true,
          valid: true,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    }),
    getServiceSettings: () => ({ ok: true, apiBaseUrl: "https://service.example.com" }),
    latestRelease: async () => globalThis.__latestReleaseResponse || ({ ok: false, error: "SERVICE_REQUEST_FAILED" }),
  },
};

const {
  activateLicense,
  clearLicense,
  createLicenseToken,
  getLicenseStatus,
  requireValidLicense,
  refreshServerLicense,
  verifyLicenseToken,
} = require("../src/main/license-manager.js");
const {
  checkForUpdates,
  createUpdateManifest,
  compareVersions,
  defaultManifestUrl,
  defaultAutoUpdateBaseUrl,
  deriveAutoFeedUrl,
  getUpdateSettings,
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

clearLicense();
globalThis.__safeStorageAvailable = true;
globalThis.__safeStorageThrow = true;
fs.writeFileSync(path.join(tmp, "license-state.json"), JSON.stringify({
  license: {
    encrypted: true,
    data: Buffer.from("bad ciphertext").toString("base64"),
  },
}, null, 2));
const corruptStatus = getLicenseStatus();
if (corruptStatus.activated || corruptStatus.error !== "DECRYPT_FAILED") {
  throw new Error(`corrupt encrypted license should not crash: ${JSON.stringify(corruptStatus)}`);
}
globalThis.__safeStorageAvailable = false;
globalThis.__safeStorageThrow = false;

fs.writeFileSync(path.join(tmp, "license-state.json"), JSON.stringify({}, null, 2));
const trialRefresh = await refreshServerLicense();
if (!trialRefresh.ok || !trialRefresh.trial?.valid) {
  throw new Error(`trial refresh should store valid trial: ${JSON.stringify(trialRefresh)}`);
}
const trialAllowed = requireValidLicense();
if (!trialAllowed.ok || trialAllowed.license?.plan !== "trial") {
  throw new Error(`valid trial should pass gate: ${JSON.stringify(trialAllowed)}`);
}

fs.writeFileSync(path.join(tmp, "license-state.json"), JSON.stringify({
  serverLicense: {
    licenseId: "lic_server_1",
    deviceId: "dev_server_1",
    customer: "Server Customer",
    plan: "pro",
    features: ["usage"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
}, null, 2));
const transientRefresh = await refreshServerLicense();
if (transientRefresh.ok || transientRefresh.error !== "NO_SERVICE_URL" || !transientRefresh.transient) {
  throw new Error(`transient refresh should surface but not invalidate: ${JSON.stringify(transientRefresh)}`);
}
const serverStatus = getLicenseStatus();
if (!serverStatus.activated || !serverStatus.valid || serverStatus.error) {
  throw new Error(`transient server refresh should keep stored license valid: ${JSON.stringify(serverStatus)}`);
}

const manifest = createUpdateManifest({
  version: "0.2.0",
  force: false,
  platforms: {
    // Cover every runner arch so checkStaticUpdates() finds the current
    // platform's package regardless of where the suite runs (Windows/mac x64).
    "darwin-arm64": { url: "https://cdn.example.com/app.dmg", sha256: "abc" },
    "darwin-x64": { url: "https://cdn.example.com/app-x64.dmg", sha256: "abc" },
    "win32-x64": { url: "https://cdn.example.com/app.exe", sha256: "abc" },
    "linux-x64": { url: "https://cdn.example.com/app.AppImage", sha256: "abc" },
  },
}, privateKey);
const unsigned = { ...manifest };
delete unsigned.signature;
if (!verifyDetached(unsigned, manifest.signature, publicKey)) {
  throw new Error("signed update manifest failed verification");
}

global.fetch = async () => ({
  ok: true,
  json: async () => manifest,
});
globalThis.__latestReleaseResponse = { ok: false, error: "SERVICE_REQUEST_FAILED" };
const staticFallbackUpdate = await checkForUpdates();
if (!staticFallbackUpdate.ok || staticFallbackUpdate.source !== "static" || staticFallbackUpdate.latestVersion !== "0.2.0") {
  throw new Error(`service failure should fall back to static manifest: ${JSON.stringify(staticFallbackUpdate)}`);
}
globalThis.__latestReleaseResponse = {
  ok: true,
  json: {
    version: "0.1.1",
    url: "https://service.example.com/old.dmg",
    sha256: "service-old",
  },
};
const newerStaticUpdate = await checkForUpdates();
if (!newerStaticUpdate.ok || newerStaticUpdate.source !== "static" || newerStaticUpdate.latestVersion !== "0.2.0") {
  throw new Error(`newer static manifest should win over stale service release: ${JSON.stringify(newerStaticUpdate)}`);
}

if (compareVersions("0.2.0", "0.1.9") <= 0) {
  throw new Error("compareVersions should detect newer version");
}
if (compareVersions("0.1.0", "0.1.0") !== 0) {
  throw new Error("compareVersions equality failed");
}

if (defaultManifestUrl() !== "https://qny.lanrensoft.cn/app/updates/latest.json") {
  throw new Error(`default manifest url mismatch: ${defaultManifestUrl()}`);
}
if (getUpdateSettings().manifestUrl !== defaultManifestUrl()) {
  throw new Error("update settings should expose the built-in manifest URL by default");
}
if (defaultAutoUpdateBaseUrl() !== "https://qny.lanrensoft.cn/app/auto-updates") {
  throw new Error(`default auto update base url mismatch: ${defaultAutoUpdateBaseUrl()}`);
}
if (deriveAutoFeedUrl("darwin-arm64") !== "https://qny.lanrensoft.cn/app/auto-updates/darwin-arm64/stable") {
  throw new Error(`default mac auto feed mismatch: ${deriveAutoFeedUrl("darwin-arm64")}`);
}
if (deriveAutoFeedUrl("win32-x64") !== "https://qny.lanrensoft.cn/app/auto-updates/win32-x64/stable") {
  throw new Error(`default win auto feed mismatch: ${deriveAutoFeedUrl("win32-x64")}`);
}
const updateManagerSource = fs.readFileSync(require.resolve("../src/main/update-manager.js"), "utf8");
if (!updateManagerSource.includes("disableDifferentialDownload = true")) {
  throw new Error("auto updater must avoid Windows differential downloads; missing blockmap metadata breaks silent updates");
}
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
if (packageJson.build?.nsis?.differentialPackage !== false) {
  throw new Error("Windows release builds must keep the stable zip-backed NSIS installer; generate blockmap separately");
}
const releaseOneSource = fs.readFileSync(path.join(process.cwd(), "scripts/release-one-click.mjs"), "utf8");
if (!releaseOneSource.includes("generating Windows blockmap for stable installer")) {
  throw new Error("release script must generate Windows blockmap without switching NSIS to differentialPackage mode");
}
fs.writeFileSync(
  path.join(tmp, "update-settings.json"),
  JSON.stringify({ manifestUrl: "https://user-controlled.example.com/latest.json" }),
);
if (getUpdateSettings().manifestUrl !== defaultManifestUrl()) {
  throw new Error("update settings should ignore user-controlled manifest URL");
}

const ipcHandlersSource = fs.readFileSync(require.resolve("../src/main/ipc-handlers.js"), "utf8");
for (const channel of ["updates:check", "updates:download", "updates:install", "updates:open-download"]) {
  const start = ipcHandlersSource.indexOf(`ipcMain.handle("${channel}"`);
  const end = ipcHandlersSource.indexOf("ipcMain.handle(", start + 1);
  const block = ipcHandlersSource.slice(start, end > start ? end : undefined);
  if (start < 0 || block.includes("requireValidLicense")) {
    throw new Error(`${channel} must remain available before activation`);
  }
}
const schedulerSource = fs.readFileSync(require.resolve("../src/main/update-scheduler.js"), "utf8");
if (schedulerSource.includes("requireValidLicense")) {
  throw new Error("background update checks must remain available before activation");
}
if (!schedulerSource.includes("setInterval") || !schedulerSource.includes("checkForUpdatesState")) {
  throw new Error("main process must own the global background update check loop");
}
if (!schedulerSource.includes("inFlight")) {
  throw new Error("background update checks should be coalesced to avoid overlapping update requests");
}
const updateSettingsSource = fs.readFileSync(
  require.resolve("../src/renderer/modules/license-update-settings.js"),
  "utf8",
);
const startAutoUpdateStart = updateSettingsSource.indexOf("export function startAutoUpdateChecks()");
const startAutoUpdateEnd = updateSettingsSource.indexOf("export function kickAutoUpdateCheck()", startAutoUpdateStart);
const startAutoUpdateBlock = updateSettingsSource.slice(startAutoUpdateStart, startAutoUpdateEnd);
if (startAutoUpdateStart < 0 || startAutoUpdateBlock.includes("checkForUpdates(")) {
  throw new Error("renderer must not own a separate periodic update check; it should consume main-process state");
}
if (updateSettingsSource.includes("getLicenseStatus?.()")) {
  throw new Error("update checks must remain available before activation");
}

console.log("license-update: ok");
