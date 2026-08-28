import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { canonicalModelId } from "../src/main/model-identity.js";
import { stableStringify } from "../src/main/crypto-signing.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-model-identity-"));
const config = { userDataPath: file => path.join(root, file), PROJECT_ROOT: root, isPackaged: () => false };
function isolated(name, mocks) {
  const file = new URL(`../src/main/${name}`, import.meta.url), native = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module, exports: module.exports, process, Buffer, console, setTimeout, clearTimeout,
    require: id => id === "./config" ? config : Object.hasOwn(mocks, id) ? mocks[id] : native(id),
  }, { filename: file.pathname });
  return module.exports;
}
const base = "lily-managed:fixture:gateway";
const preset = (id, model) => ({ id, label: model, env: { LILY_MODEL: model, LILY_OPENCODE_PROTOCOL: "openai",
  LILY_OPENCODE_PROVIDER_ID: "lily", LILY_API_BASE_URL: "https://fixture.test/v1", LILY_API_KEY: "fixture-key" } });
const state = presets => ({ schemaVersion: 1, configVersion: "fixture", expiresAt: new Date(Date.now() + 3600000).toISOString(),
  effectiveConfig: { models: { source: "service", activePresetId: presets.at(-1).id, presets } } });
try {
  const old = state([preset(base, "A"), preset(`${base}--B`, "B")]);
  const cache = path.join(root, "remote-config-cache.json");
  fs.writeFileSync(cache, JSON.stringify({ config: { encrypted: false, data: Buffer.from(JSON.stringify(old)).toString("base64") } }));
  fs.writeFileSync(path.join(root, "model-selection.json"), JSON.stringify({ mode: "manual", manualModelId: base }));
  fs.writeFileSync(path.join(root, "model-settings.json"), JSON.stringify({ activePresetId: base }));
  let next = state([preset(canonicalModelId(base, "A"), "A"), preset(canonicalModelId(base, "B"), "B")]);
  const remote = isolated("remote-config.js", {
    electron: { safeStorage: { isEncryptionAvailable: () => false } },
    "./account-manager": { accessTokenForService: async () => ({ ok: false }) },
    "./service-client": { fetchClientConfig: async () => ({ ok: true, json: { ...next,
      signature: `dev.${createHash("sha256").update(stableStringify(next)).digest("hex")}` } }) },
  });
  assert.equal((await remote.refreshRemoteConfig()).ok, true);
  remote.reloadRemoteConfigCache();
  assert.equal(remote.getRemoteModelIdentityAliasesSync()[base].id, canonicalModelId(base, "A"));
  assert.equal(remote.getRemoteModelIdentityAliasesSync()[`${base}--B`].id, canonicalModelId(base, "B"));
  const api = isolated("model-presets.js", { "./remote-config": remote, "./agent-settings": { loadSettingsEnv: () => ({}) } });
  assert.equal(api.getActivePresetId(), canonicalModelId(base, "A"), "legacy global selection retains its original model");
  const catalog = isolated("model-selection-catalog.js", {
    "./remote-config": remote, "./model-presets": api, "./agent-settings": { loadSettingsEnv: () => ({}) },
    "./spawn-env": { resolveLilyEnv: () => api.getActivePresetEnv() },
  });
  assert.equal(catalog.resolveTurnModel({}).model.modelID, "A", "saved manual selection does not become new default B");
  const publicState = catalog.listModelSelectionPublic();
  assert.equal(publicState.selection.manualModelId, canonicalModelId(base, "A"));
  assert.equal(JSON.stringify(publicState).includes("fixture-key"), false);
  assert.equal(JSON.stringify(publicState).includes("https://fixture"), false);
  next = state([preset(canonicalModelId(base, "B"), "B")]);
  await remote.refreshRemoteConfig();
  assert.equal(catalog.resolveTurnModel({}).ok, false, "removed A cannot be migrated to B");
  console.log("model identity cache migration: ok");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
