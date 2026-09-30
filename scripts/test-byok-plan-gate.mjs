#!/usr/bin/env node
// BYOK (自配置模型) plan gate: blocked ONLY when the signed-in account's
// entitlements explicitly say byokAllowed === false; everything else — field
// missing, signed out, licence-authorized, a failed fetch — is today's
// behaviour (allowed). One decision module; enforcement and view model read it.
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-byok-gate-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_HOME = tmp;
process.env.LILY_DOCUMENTS_DIR = tmp;

// ── 1. The pure decision ────────────────────────────────────────────────────
const { decideByok, isByokLocked, PRICING_URL } = require(path.join(ROOT, "src/main/byok-policy.js"));
assert.equal(decideByok().allowed, true, "no inputs (fetch failed, nothing cached) → allowed");
assert.equal(decideByok({ loggedIn: true, entitlements: null }).allowed, true, "entitlement fetch failed → allowed");
assert.equal(decideByok({ loggedIn: true, entitlements: { tokenBalance: 5 } }).allowed, true, "field missing (older server) → allowed");
assert.equal(decideByok({ loggedIn: true, entitlements: { byokAllowed: undefined } }).allowed, true);
assert.equal(decideByok({ loggedIn: true, entitlements: { byokAllowed: null } }).allowed, true, "only an explicit false blocks");
assert.equal(decideByok({ loggedIn: true, entitlements: { byokAllowed: 0 } }).allowed, true, "falsy is not false");
assert.equal(decideByok({ loggedIn: false, entitlements: { byokAllowed: false } }).allowed, true, "signed out → allowed");
assert.equal(decideByok({ loggedIn: true, licenseValid: true, entitlements: { byokAllowed: false } }).allowed, true, "licence-authorized → allowed");
assert.equal(decideByok({ loggedIn: true, entitlements: { byokAllowed: true, byokReason: "organization" } }).reason, "organization");
const blocked = decideByok({ loggedIn: true, entitlements: { byokAllowed: false, byokReason: "plan_required" } });
assert.deepEqual(blocked, { allowed: false, reason: "plan_required", pricingUrl: PRICING_URL });
assert.equal(PRICING_URL, "https://lilywb.cn/pricing");
assert.equal(isByokLocked({ custom: true }, blocked), true);
assert.equal(isByokLocked({ custom: false }, blocked), false, "platform models are never locked");
assert.equal(isByokLocked({ custom: true }, decideByok()), false);

// ── 2. Real main-process enforcement (model-presets + account-manager) ─────
let serverEntitlements = { tokenBalance: 10 };
let entitlementsFetchOk = true;
let licenseValid = false;
let probeCalls = 0;
const remoteCatalog = {
  activePresetId: "platform",
  presets: [{ id: "platform", label: "Platform", env: { LILY_MODEL: "platform-model", LILY_GATEWAY_PROVIDER: "lily" } }],
};
const remoteStub = {
  getRemoteModelCatalogSync: () => remoteCatalog,
  hasRemoteModelCatalogSync: () => true,
  getRemoteModelIdentityAliasesSync: () => ({}),
  getRemoteProviderCatalogSync: () => [],
  getRemoteRuntimeEnvSync: () => ({}),
  onRemoteConfigRefreshed() {},
  reloadRemoteConfigCache() {},
};
const serviceStub = {
  loginWithSms: async () => ({ ok: true, json: { user: { id: "u1", phoneE164: "+8613800000000" }, entitlements: serverEntitlements, refreshToken: "refresh-1", accessToken: "access-1", expiresIn: 3600 } }),
  refreshAccountAccessToken: async () => ({ ok: true, json: { accessToken: "access-2", expiresIn: 3600 } }),
  fetchAccountEntitlements: async () => entitlementsFetchOk
    ? { ok: true, json: { entitlements: serverEntitlements } }
    : { ok: false, error: "SERVICE_REQUEST_FAILED" },
  logoutAccount: async () => ({ ok: true }),
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => tmp, isPackaged: false },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
        decryptString: (buffer) => Buffer.from(buffer).toString("utf8").replace(/^protected:/, ""),
      },
    };
  }
  if (request === "./remote-config") return remoteStub;
  if (request === "./service-client") return serviceStub;
  if (request === "./model-compatibility-probe") return { probeCustomModelProfile: async () => { probeCalls += 1; return { ok: true, profile: null } } };
  if (request === "./license-manager") return { getLicenseStatus: () => ({ activated: licenseValid, valid: licenseValid }) };
  return originalLoad.call(this, request, parent, isMain);
};

const presets = require(path.join(ROOT, "src/main/model-presets.js"));
const account = require(path.join(ROOT, "src/main/account-manager.js"));

// Signed out: adding and selecting a custom model work exactly as today.
const saved = presets.saveCustomPreset({ label: "My Key", model: "my-model", baseUrl: "https://llm.example.com/v1", apiKey: "sk-byok-test-123456", protocol: "openai" });
assert.equal(saved.ok, true, `signed out → add allowed: ${JSON.stringify(saved)}`);
const customId = saved.preset?.id || presets.listPresetsPublic().presets.find((p) => p.custom).id;
assert.equal(presets.setActivePreset(customId).ok, true);
assert.equal(presets.getActivePresetId(), customId);
assert.equal(presets.listPresetsPublic().byok.allowed, true);
assert.equal(presets.takeByokSwitchNotice(), null, "no lock → no notice");

// Signed in, server omits the field → allowed.
await account.loginWithSms({ phone: "13800000000", code: "123456" });
assert.equal(account.byokDecision().allowed, true, "field missing → allowed");
assert.equal(presets.getActivePresetId(), customId);

// Signed in, entitlement fetch fails → never blocks.
entitlementsFetchOk = false;
assert.equal((await account.refreshEntitlements()).ok, false);
assert.equal(account.byokDecision().allowed, true, "failed fetch → allowed");
entitlementsFetchOk = true;

// Server explicitly says false (operator switched the plan requirement on).
serverEntitlements = { tokenBalance: 10, byokAllowed: false, byokReason: "plan_required", plan: null };
assert.equal((await account.refreshEntitlements()).ok, true);
assert.equal(account.byokDecision().allowed, false, "explicit false → blocked");

const refusedAdd = await presets.saveCustomPresetWithProbe({ label: "Another", model: "other-model", baseUrl: "https://llm.example.com/v1", apiKey: "sk-byok-test-654321", protocol: "openai" });
assert.equal(refusedAdd.ok, false);
assert.equal(refusedAdd.error, "BYOK_PLAN_REQUIRED", "add flow refused before any probe");
assert.equal(refusedAdd.byok.pricingUrl, PRICING_URL);
assert.equal(probeCalls, 0, "no probe spent on a refused add");
assert.equal(presets.saveCustomPreset({ label: "Another", model: "other-model", baseUrl: "https://llm.example.com/v1", apiKey: "sk-byok-test-654321" }).error, "BYOK_PLAN_REQUIRED");
assert.notEqual(presets.setApiGateway({ mode: "custom", baseUrl: "https://llm.example.com/v1", apiKey: "sk-byok-test-654321" }).error, "BYOK_PLAN_REQUIRED", "the custom API gateway stays open to everyone (only own-key models are gated)");

const listed = presets.listPresetsPublic();
const lockedRow = listed.presets.find((p) => p.id === customId);
assert.ok(lockedRow, "existing custom models stay listed");
assert.equal(lockedRow.locked, true, "…but locked");
assert.equal(listed.presets.find((p) => p.id === "platform").locked, false);
assert.equal(listed.byok.allowed, false);
assert.equal(presets.setActivePreset(customId).error, "BYOK_PLAN_REQUIRED", "locked model cannot be selected");
assert.equal(presets.setActivePreset("platform").ok, true, "platform models stay selectable");
presets.reloadPresets();

// Re-select the custom model while allowed, then lock: effective model switches to the platform default.
licenseValid = true;
// A licence-authorized user is allowed: force a re-read by an account write.
await account.refreshEntitlements();
assert.equal(account.byokDecision().allowed, true, "licence-authorized → allowed");
assert.equal(presets.setActivePreset(customId).ok, true);
licenseValid = false;
await account.refreshEntitlements();
assert.equal(account.byokDecision().allowed, false);
assert.equal(presets.getActivePresetId(), "platform", "active custom model → platform default");
assert.equal(presets.getActivePreset().custom, false);
assert.equal(presets.getUserApiEnv().LILY_API_KEY, undefined, "the locked key never reaches a turn");
const notice = presets.takeByokSwitchNotice();
assert.deepEqual(notice?.models, ["My Key"], "the user is told why, naming the model");
assert.equal(notice.pricingUrl, PRICING_URL);
assert.equal(presets.takeByokSwitchNotice(), null, "…exactly once");
presets.reloadPresets();
assert.equal(presets.takeByokSwitchNotice(), null, "…even after a reload");

// Plan bought: entitlement refresh lifts the lock with no restart.
serverEntitlements = { tokenBalance: 10, byokAllowed: true, byokReason: "plan", plan: { tier: "pro", expiresAt: "2027-01-01T00:00:00.000Z" } };
await account.refreshEntitlements();
assert.equal(account.byokDecision().allowed, true);
assert.equal(presets.getActivePresetId(), customId, "the user's own choice comes back");
assert.equal(presets.listPresetsPublic().presets.find((p) => p.id === customId).locked, false);
assert.equal(presets.getUserApiEnv().LILY_API_KEY, "sk-byok-test-123456");
assert.equal(presets.takeByokSwitchNotice(), null);
assert.equal(fs.existsSync(path.join(tmp, "byok-lock-notice.json")), false, "the lock episode record clears");

// Signed out with a cached refusal → allowed.
serverEntitlements = { byokAllowed: false };
await account.refreshEntitlements();
assert.equal(account.byokDecision().allowed, false);
await account.logout();
assert.equal(account.byokDecision().allowed, true, "signed out → allowed");
Module._load = originalLoad;

// ── 3. Per-turn picker routing never fails a turn on a locked model ────────
function catalogFixture({ locked, stored }) {
  const platformEnv = { LILY_MODEL: "platform-model", LILY_API_BASE_URL: "https://one.test/v1", LILY_OPENCODE_PROTOCOL: "openai" };
  const customEnv = { LILY_MODEL: "my-model", LILY_API_BASE_URL: "https://mine.test/v1", LILY_OPENCODE_PROTOCOL: "openai", LILY_API_KEY: "sk-mine" };
  const list = [
    { id: "platform", label: "Platform", model: "platform-model", custom: false, locked: false, env: platformEnv },
    { id: "custom-mine", label: "Mine", model: "my-model", custom: true, locked, env: customEnv },
  ];
  let saved = stored;
  const mocks = {
    "node:fs": { readFileSync: () => JSON.stringify(saved), mkdirSync() {}, writeFileSync() {}, renameSync() {}, unlinkSync() {} },
    "./json-file": { writeJson: (_file, value) => { saved = value; } },
    "./config": { userDataPath: () => "/virtual/selection.json" },
    "./model-presets": {
      listPresetsPublic: () => ({ activePresetId: "platform", presets: list, byok: { allowed: !locked, reason: locked ? "plan_required" : "open", pricingUrl: PRICING_URL } }),
      getPresetRuntimeEnv: () => customEnv,
    },
    "./spawn-env": { resolveLilyEnv: () => platformEnv },
    "./agent-settings": { loadSettingsEnv: () => ({}) },
    "./remote-config": { getRemoteModelCatalogSync: () => ({ presets: [{ id: "platform", env: platformEnv }] }), getRemoteRuntimeEnvSync: () => ({}) },
    "./agent-env": { normalizeToLilyEnv: (value) => value },
    "./model-availability": { annotateModelOptions: (models) => models },
  };
  const file = path.join(ROOT, "src/main/model-selection-catalog.js");
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module: mod, exports: mod.exports, process, Buffer,
    require: (id) => mocks[id] || createRequire(file)(id),
  });
  return mod.exports;
}
const manualCustom = { mode: "manual", manualModelId: "custom-mine", autoPoolMode: "recommended", autoModelIds: [] };
{
  const open = catalogFixture({ locked: false, stored: manualCustom });
  assert.equal(open.resolveTurnModel().model.modelID, "my-model", "allowed → the user's custom pick runs");
  assert.equal(open.listModelSelectionPublic().lockedModels.length, 0);
}
{
  const gated = catalogFixture({ locked: true, stored: manualCustom });
  const listedSel = gated.listModelSelectionPublic();
  assert.deepEqual(JSON.parse(JSON.stringify(listedSel.lockedModels.map((m) => m.id))), ["custom-mine"], "locked model is listed for the picker");
  assert.ok(!listedSel.models.some((m) => m.id === "custom-mine"), "…but not routable");
  assert.equal(listedSel.selection.manualModelId, "platform", "effective selection is the platform default");
  assert.deepEqual(JSON.parse(JSON.stringify(listedSel.lockedChosen.map((m) => m.id))), ["custom-mine"], "the chosen locked model is reported for the notice");
  const route = gated.resolveTurnModel();
  assert.equal(route.ok, true, "a locked manual pick never fails the turn");
  assert.equal(route.model.modelID, "platform-model");
  assert.equal(route.execution.env.LILY_API_KEY, undefined);
  assert.equal(gated.resolveTurnModel({ pinnedModelId: "custom-mine" }).model.modelID, "platform-model", "a pinned replay continues on the default");
  assert.equal(gated.setModelSelectionPreference(manualCustom).error, "BYOK_PLAN_REQUIRED", "picking a locked model is refused");
  assert.equal(gated.isLockedModel("custom-mine"), true);
  const pool = catalogFixture({ locked: true, stored: { mode: "auto", autoPoolMode: "custom", autoModelIds: ["custom-mine"] } });
  assert.equal(pool.resolveTurnModel().model.modelID, "platform-model", "an all-locked auto pool falls back to recommended");
}

// ── 4. Single source of truth (source scan) ────────────────────────────────
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const presetsSrc = read("src/main/model-presets.js");
const accountSrc = read("src/main/account-manager.js");
assert.match(accountSrc, /require\("\.\/byok-policy"\)/, "account-manager decides through byok-policy");
assert.match(presetsSrc, /require\("\.\/account-manager"\)\.byokDecision\(\)/, "enforcement reads the account verdict");
assert.match(presetsSrc, /require\("\.\/byok-policy"\)\.isByokLocked/, "the view model's locked flag comes from byok-policy");
assert.match(read("src/main/model-selection-catalog.js"), /preset\.locked/, "picker routing consumes the same flag");
const byokFieldReaders = [];
for (const dir of ["src/main", "src/renderer/modules"]) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    if (!/\.(m?js|cjs)$/.test(name) || name === "byok-policy.js") continue;
    const text = read(`${dir}/${name}`);
    // Anything other than the policy module interpreting the raw server fields
    // would be a second source of truth. account-manager may only look at the
    // field to skip the costly checks — it still calls decideByok.
    if (/\bbyokAllowed\b|\bbyokReason\b/.test(text) && !(dir === "src/main" && name === "account-manager.js")) byokFieldReaders.push(`${dir}/${name}`);
  }
}
assert.deepEqual(byokFieldReaders, [], "no second interpreter of byokAllowed/byokReason");
for (const rel of ["src/renderer/modules/model-settings.js", "src/renderer/modules/model-picker.js"]) {
  assert.match(read(rel), /from "\.\/byok-gate\.js"/, `${rel} renders the gate through byok-gate`);
}

// ── 5. Localized copy exists in every locale ───────────────────────────────
for (const locale of ["zh-CN", "en", "ar"]) {
  const messages = JSON.parse(read(`src/renderer/i18n/locales/${locale}.json`));
  for (const key of ["byok.planRequired", "byok.viewPlans", "byok.lockedBadge", "byok.switchedNotice", "settings.accountPlanWeekRemaining", "settings.accountPlanResetsAt", "settings.accountPlanExpiresAt"]) {
    assert.ok(messages[key], `${locale} has ${key}`);
  }
  assert.match(messages["byok.switchedNotice"], /\{model\}/);
}
assert.equal(JSON.parse(read("src/renderer/i18n/locales/zh-CN.json"))["byok.planRequired"], "自配置模型需要 Pro 或 Max 套餐（企业成员可直接使用）");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("byok-plan-gate: ok");
