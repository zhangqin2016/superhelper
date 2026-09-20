#!/usr/bin/env node
/**
 * An API key is never written as plain Base64 by accident. When the OS secure
 * storage is unavailable, saving a NEW key is refused with a named error; the
 * operator can opt in explicitly (LILY_ALLOW_PLAINTEXT_SECRETS=1); and
 * operations that merely re-serialize an already stored key (switching the
 * active preset, editing a label) keep working — they reuse the stored record.
 *
 * 2026-09-19: that rule had been fixed in two of eight copies of the same
 * helper; the device signing key, account refresh token, remote-config cache,
 * license and web credentials kept the silent Base64 fallback. secret-storage.js
 * is now the only module that touches safeStorage, and this test scans for a
 * second one. [gate: secret-storage-no-silent-plaintext]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "secret-guard-"));
process.env.LILY_USER_DATA_DIR = tmp; process.env.LILY_HOME = os.homedir(); process.env.LILY_DOCUMENTS_DIR = tmp;
delete process.env.LILY_ALLOW_PLAINTEXT_SECRETS;
const electronPath = require.resolve("electron");
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
  app: { getPath: () => tmp, isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error("must not be called"); }, decryptString: () => "" },
} };
const presets = require("../src/main/model-presets.js");
const key = "sk-brand-new-secret-1234567890";
const settingsFile = () => fs.readdirSync(tmp, { recursive: true }).map(String).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(tmp, f), "utf8")).join("\n");

// 1. No secure storage, no opt-in → refused by name, nothing leaks to disk.
const refused = presets.saveCustomPreset({ label: "Guarded", model: "gpt-x", baseUrl: "https://api.example/v1", apiKey: key, protocol: "openai" });
assert.equal(refused.ok, false); assert.equal(refused.error, "SECRET_STORAGE_UNAVAILABLE");
assert.doesNotMatch(settingsFile(), new RegExp(Buffer.from(key).toString("base64").slice(0, 16)), "the key was not written in Base64 either");
assert.doesNotMatch(settingsFile(), /brand-new-secret/);

// 2. Explicit opt-in → stored, marked as NOT encrypted (honest about what it is).
process.env.LILY_ALLOW_PLAINTEXT_SECRETS = "1";
const saved = presets.saveCustomPreset({ label: "Guarded", model: "gpt-x", baseUrl: "https://api.example/v1", apiKey: key, protocol: "openai" });
assert.equal(saved.ok, true, JSON.stringify(saved));
const presetId = saved.activePresetId || saved.presets?.find((p) => p.custom)?.id || saved.id;
assert.ok(presetId, "saved preset id");
const written = JSON.parse(fs.readFileSync(path.join(tmp, fs.readdirSync(tmp, { recursive: true }).map(String).find((f) => f.endsWith(".json") && fs.readFileSync(path.join(tmp, f), "utf8").includes("apiKeyProtected"))), "utf8"));
const record = (written.customPresets || []).find((p) => p.id === presetId)?.apiKeyProtected;
assert.equal(record?.encrypted, false, "opt-in record is labelled encrypted:false");
delete process.env.LILY_ALLOW_PLAINTEXT_SECRETS;

// 3. Storage still unavailable: re-serializing the EXISTING key must not break
//    ordinary operations — the stored record is reused.
const relabelled = presets.updateCustomPreset(presetId, { label: "Guarded (renamed)", model: "gpt-x", baseUrl: "https://api.example/v1", protocol: "openai" });
assert.equal(relabelled.ok, true, `relabel keeps working: ${JSON.stringify(relabelled)}`);
const switched = presets.setActivePreset(presetId);
assert.equal(switched.ok, true, `switching presets keeps working: ${JSON.stringify(switched)}`);
assert.equal(presets.getUserApiEnv().LILY_API_KEY, key, "the existing key still hydrates");

// 4. …but a NEW key still has nowhere safe to go.
const rekeyed = presets.updateCustomPreset(presetId, { label: "Guarded", model: "gpt-x", baseUrl: "https://api.example/v1", protocol: "openai", apiKey: "sk-another-new-secret-0987654321" });
assert.equal(rekeyed.ok, false); assert.equal(rekeyed.error, "SECRET_STORAGE_UNAVAILABLE");
const gateway = presets.setApiGateway({ mode: "custom", baseUrl: "https://gw.example/v1", apiKey: "sk-gateway-new-secret-1234567890", protocol: "openai" });
assert.equal(gateway.ok, false); assert.equal(gateway.error, "SECRET_STORAGE_UNAVAILABLE");

// 5. The rule has one home. Nothing else may touch safeStorage or define its
//    own protect/unprotect — that is how six copies kept the old behaviour.
{
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const allowed = new Set(["src/main/secret-storage.js", "src/main/collaboration/local-keyring.js"]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (allowed.has(rel)) continue;
      const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      if (/encryptString|decryptString|isEncryptionAvailable|\.safeStorage\b/.test(code)) offenders.push(`${rel}: touches safeStorage`);
      if (/^(?:async )?function (?:protectText|unprotectText|protectSecret|unprotectSecret|getSafeStorage|electronSafeStorage)\(/m.test(code)) offenders.push(`${rel}: defines its own secret helper`);
    }
  };
  walk(path.join(ROOT, "src/main"));
  assert.deepEqual(offenders, [], `secrets are protected in secret-storage.js only:\n${offenders.join("\n")}`);
}

// 6. The writers that used to fall back silently now refuse — without breaking
//    what the user is doing. Storage still unavailable, no opt-in.
await (async () => {
  const serviceClient = require("../src/main/service-client.js");
  const first = serviceClient.devicePayload();
  assert.ok(first?.publicKey, "a device identity still exists for this run");
  assert.equal(serviceClient.devicePayload().publicKey, first.publicKey, "and is stable within the process");
  const deviceFile = path.join(tmp, "device-state.json");
  const onDisk = fs.existsSync(deviceFile) ? fs.readFileSync(deviceFile, "utf8") : "";
  assert.ok(!/privateKey/.test(onDisk), `the private key is not on disk under any encoding: ${onDisk.slice(0, 200)}`);

  // The remote-config cache carries gateway credentials. A refused cache write
  // is not an error: the refreshed config is served from memory for this run
  // and nothing lands on disk in Base64.
  const remoteConfig = require("../src/main/remote-config.js");
  const accountManager = require("../src/main/account-manager.js");
  const { stableStringify } = require("../src/main/crypto-signing.js");
  const crypto = require("node:crypto");
  const config = {
    schemaVersion: 1, configVersion: "guard", expiresAt: new Date(Date.now() + 3600000).toISOString(),
    effectiveConfig: { models: { source: "service", activePresetId: "guard-p", presets: [{ id: "guard-p", label: "Guard", env: {
      LILY_MODEL: "m", LILY_OPENCODE_PROTOCOL: "openai", LILY_OPENCODE_PROVIDER_ID: "lily", LILY_API_BASE_URL: "https://fixture.test/v1", LILY_API_KEY: "guard-gateway-key-9f8e7d",
    } }] } },
  };
  const signed = { ...config, signature: `dev.${crypto.createHash("sha256").update(stableStringify(config)).digest("hex")}` };
  const originalFetch = serviceClient.fetchClientConfig;
  const originalToken = accountManager.accessTokenForService;
  serviceClient.fetchClientConfig = async () => ({ ok: true, json: signed });
  accountManager.accessTokenForService = async () => ({ ok: false });
  try {
    const refreshed = await remoteConfig.refreshRemoteConfig();
    assert.equal(refreshed.ok, true, `refresh succeeds without a keyring: ${JSON.stringify(refreshed)}`);
    // Preset ids are canonicalised on the way in, so assert on the payload
    // itself: one preset, and its gateway key reachable — from memory only.
    // model-presets reloads the cache after every refresh; the memory copy must survive that.
    remoteConfig.reloadRemoteConfigCache();
    const served = remoteConfig.getRemoteEffectiveConfigSync();
    assert.equal(served?.models?.presets?.length, 1, `the config is served from memory: ${JSON.stringify(served)?.slice(0, 200)}`);
    assert.equal(served.models.presets[0].env.LILY_API_KEY, "guard-gateway-key-9f8e7d");
    const cacheFile = path.join(tmp, "remote-config-cache.json");
    const cached = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, "utf8") : "";
    assert.doesNotMatch(cached, /guard-gateway-key/, "the gateway key is not on disk");
    assert.doesNotMatch(cached, new RegExp(Buffer.from("guard-gateway-key").toString("base64").slice(0, 16)), "not in Base64 either");
  } finally {
    serviceClient.fetchClientConfig = originalFetch;
    accountManager.accessTokenForService = originalToken;
  }

  const licenseStore = require("../src/main/license-state-store.js");
  assert.throws(() => licenseStore.protectText("license-token"), (error) => error?.code === "SECRET_STORAGE_UNAVAILABLE", "a license token is refused by name");
})();

fs.rmSync(tmp, { recursive: true, force: true });
console.log("secret storage guard: ok");
