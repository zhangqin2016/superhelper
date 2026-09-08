#!/usr/bin/env node
/**
 * An API key is never written as plain Base64 by accident. When the OS secure
 * storage is unavailable, saving a NEW key is refused with a named error; the
 * operator can opt in explicitly (LILY_ALLOW_PLAINTEXT_SECRETS=1); and
 * operations that merely re-serialize an already stored key (switching the
 * active preset, editing a label) keep working — they reuse the stored record.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("secret storage guard: ok");
