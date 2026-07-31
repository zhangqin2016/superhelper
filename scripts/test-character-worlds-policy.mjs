#!/usr/bin/env node
// Character Worlds signed rollout policy (Phase 1, Task 10; spec §16/§18/§14.3).
//
// The server emits a bounded, validated `characterWorlds` block inside the
// EXISTING signed client-config payload — no character CRUD endpoints, no
// private content upload, no card analytics, no server-side user libraries.
//
// Invariants proven here:
//   - conservative default is DISABLED
//   - invalid/unsigned/stale policy disables compilation/selection but local
//     data and bindings stay readable (list/get/binding-read/export work)
//   - LILY_CHARACTER_WORLDS=0 always wins (kill switch)
//   - no remote field can enable executable imports or weaken hard limits
//   - minimumClientVersion gate disables older clients at delivery time
//
// Run: node scripts/test-character-worlds-policy.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-character-worlds-policy-"));
const tempUserData = path.join(tempRoot, "user-data");
fs.mkdirSync(tempUserData);
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempRoot, { recursive: true, force: true }));

import {
  buildEnvManagedClientConfig,
  DEFAULT_EFFECTIVE_CONFIG,
  withGatewayRuntimeConfig,
} from "../server/src/services/client-config.js";
import { resolveCharacterWorldsPolicy } from "../server/src/services/character-worlds-policy.js";

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}

const EXPECTED_DEFAULT_POLICY = {
  enabled: false,
  compatibilityProfile: "lily-character-compat-1",
  minimumClientVersion: "0.1.145",
};

// --- server: conservative defaults -------------------------------------------

await check("server config emits a disabled characterWorlds policy by default", async () => {
  assert.deepEqual(
    DEFAULT_EFFECTIVE_CONFIG.characterWorlds,
    EXPECTED_DEFAULT_POLICY,
    "packaged effective-config defaults must carry the conservative disabled policy",
  );
  assert.deepEqual(
    resolveCharacterWorldsPolicy({}),
    EXPECTED_DEFAULT_POLICY,
    "an unconfigured server must resolve to the conservative disabled policy",
  );
});

await check("env-managed client config carries the policy in the signed payload", async () => {
  const built = buildEnvManagedClientConfig(
    { modelGatewayDefaultProvider: "deepseek", dashscopeApiKey: "sk-test-dashscope" },
    {},
  );
  assert.deepEqual(
    built.characterWorlds,
    EXPECTED_DEFAULT_POLICY,
    "the existing signed payload must include the bounded policy block",
  );
});

await check("validated server config can enable the rollout", async () => {
  assert.deepEqual(
    resolveCharacterWorldsPolicy({ characterWorldsEnabled: true }),
    { ...EXPECTED_DEFAULT_POLICY, enabled: true },
  );
  const built = buildEnvManagedClientConfig(
    {
      modelGatewayDefaultProvider: "deepseek",
      dashscopeApiKey: "sk-test-dashscope",
      characterWorldsEnabled: true,
    },
    {},
  );
  assert.equal(built.characterWorlds.enabled, true);
});

await check("invalid policy fields fall back to bounded defaults", async () => {
  const resolved = resolveCharacterWorldsPolicy({
    characterWorldsEnabled: true,
    characterWorldsCompatibilityProfile: '"; DROP TABLE users; --',
    characterWorldsMinimumClientVersion: "not.a.version",
  });
  assert.equal(resolved.enabled, true, "the boolean gate itself is honored");
  assert.equal(
    resolved.compatibilityProfile,
    "lily-character-compat-1",
    "an invalid profile string must not cross the trust boundary",
  );
  assert.equal(
    resolved.minimumClientVersion,
    "0.1.145",
    "an invalid version string must not cross the trust boundary",
  );
});

await check("minimumClientVersion gate disables older clients at delivery", async () => {
  const request = { headers: { host: "lily.example.com" }, protocol: "https" };
  const base = {
    characterWorlds: {
      enabled: true,
      compatibilityProfile: "lily-character-compat-1",
      minimumClientVersion: "0.1.145",
    },
  };
  const older = withGatewayRuntimeConfig(
    base,
    request,
    { deviceId: "dev_policy_test", licenseId: "", appVersion: "0.1.100" },
    { publicBaseUrl: "https://lily.example.com" },
  );
  assert.equal(older.characterWorlds.enabled, false, "client older than minimumClientVersion must be disabled");
  const current = withGatewayRuntimeConfig(
    base,
    request,
    { deviceId: "dev_policy_test", licenseId: "", appVersion: "0.1.145" },
    { publicBaseUrl: "https://lily.example.com" },
  );
  assert.equal(current.characterWorlds.enabled, true, "a client at the minimum version stays enabled");
  const unknown = withGatewayRuntimeConfig(
    base,
    request,
    { deviceId: "dev_policy_test", licenseId: "" },
    { publicBaseUrl: "https://lily.example.com" },
  );
  assert.equal(unknown.characterWorlds.enabled, false, "an unreported client version fails closed");
});

// --- client: effective policy resolution --------------------------------------

const C = require("../src/main/character-worlds/constants.js");

await check("kill switch LILY_CHARACTER_WORLDS=0 always wins", async () => {
  const previous = process.env.LILY_CHARACTER_WORLDS;
  process.env.LILY_CHARACTER_WORLDS = "0";
  try {
    assert.deepEqual(
      C.characterWorldsPolicy({
        characterWorlds: { enabled: true, compatibilityProfile: "lily-character-compat-1" },
      }),
      { enabled: false, reason: "kill_switch" },
      "the emergency kill switch beats an enabled signed policy",
    );
    assert.deepEqual(
      C.characterWorldsPolicy(null),
      { enabled: false, reason: "kill_switch" },
      "the kill switch is reported even with no remote config at all",
    );
  } finally {
    if (previous == null) delete process.env.LILY_CHARACTER_WORLDS;
    else process.env.LILY_CHARACTER_WORLDS = previous;
  }
});

await check("absent/disabled remote policy disables with reason remote_disabled", async () => {
  assert.deepEqual(C.characterWorldsPolicy(null), { enabled: false, reason: "remote_disabled" });
  assert.deepEqual(C.characterWorldsPolicy({}), { enabled: false, reason: "remote_disabled" });
  assert.deepEqual(
    C.characterWorldsPolicy({ characterWorlds: { enabled: false } }),
    { enabled: false, reason: "remote_disabled" },
  );
  assert.deepEqual(
    C.characterWorldsPolicy({ characterWorlds: "garbage" }),
    { enabled: false, reason: "remote_disabled" },
  );
});

await check("enabled policy resolves with a validated compatibility profile", async () => {
  assert.deepEqual(
    C.characterWorldsPolicy({
      characterWorlds: { enabled: true, compatibilityProfile: "lily-character-compat-1" },
    }),
    { enabled: true, compatibilityProfile: "lily-character-compat-1" },
  );
  assert.deepEqual(
    C.characterWorldsPolicy({
      characterWorlds: { enabled: true, compatibilityProfile: "evil-experimental-profile" },
    }),
    { enabled: true, compatibilityProfile: C.DEFAULT_COMPATIBILITY_PROFILE },
    "an unsupported profile falls back to the default profile",
  );
});

await check("no remote field can enable executable imports or weaken hard limits", async () => {
  const hostile = {
    characterWorlds: {
      enabled: true,
      compatibilityProfile: "lily-character-compat-1",
      allowExecutableImports: true,
      disableHardLimits: true,
      maxCharacterCanonicalBytes: Number.MAX_SAFE_INTEGER,
      maxOperations: 0,
    },
  };
  const resolved = C.characterWorldsPolicy(hostile);
  assert.deepEqual(
    Object.keys(resolved).sort(),
    ["compatibilityProfile", "enabled"],
    "the resolved policy must carry only the whitelisted fields",
  );
  assert.equal(C.MAX_CHARACTER_CANONICAL_BYTES, 8 * 1024 * 1024, "hard byte limits are code constants");
  assert.equal(
    C.DEFAULT_IMPORT_LIMITS.maxJsonBytes,
    C.MAX_CHARACTER_CANONICAL_BYTES,
    "import limits stay anchored to the code constants",
  );
  assert.equal(C.DEFAULT_MACRO_LIMITS.maxElapsedMs, 1_000, "macro budgets are not remotely tunable");
});

// --- client: staleness / signature failures → absent policy -------------------

const remoteConfig = require("../src/main/remote-config.js");

function writeRemoteConfigCache(state) {
  fs.writeFileSync(
    path.join(tempUserData, "remote-config-cache.json"),
    JSON.stringify({
      config: {
        encrypted: false,
        data: Buffer.from(JSON.stringify(state), "utf8").toString("base64"),
      },
    }),
    "utf8",
  );
  remoteConfig.reloadRemoteConfigCache();
}

const ENABLED_POLICY_STATE = {
  schemaVersion: 1,
  configVersion: "policy-test",
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  effectiveConfig: {
    characterWorlds: {
      enabled: true,
      compatibilityProfile: "lily-character-compat-1",
      minimumClientVersion: "0.1.145",
    },
  },
};

await check("a fresh signed policy is surfaced to consumers", async () => {
  writeRemoteConfigCache(ENABLED_POLICY_STATE);
  assert.deepEqual(
    remoteConfig.getRemoteCharacterWorldsPolicySync(),
    ENABLED_POLICY_STATE.effectiveConfig.characterWorlds,
  );
  assert.equal(
    C.characterWorldsPolicy(remoteConfig.getRemoteEffectiveConfigSync()).enabled,
    true,
  );
});

await check("a stale policy resolves to absent → remote_disabled", async () => {
  writeRemoteConfigCache({
    ...ENABLED_POLICY_STATE,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(remoteConfig.getRemoteCharacterWorldsPolicySync(), null, "stale config must not surface a policy");
  assert.deepEqual(
    C.characterWorldsPolicy(remoteConfig.getRemoteEffectiveConfigSync()),
    { enabled: false, reason: "remote_disabled" },
    "stale policy disables Character Worlds",
  );
});

await check("no cached (unsigned/never-verified) config means no policy", async () => {
  // refreshRemoteConfig only writes the cache AFTER signature verification, so
  // an unsigned/invalid payload can never produce a policy block; the absence
  // of a cache is exactly the post-rejection state.
  fs.rmSync(path.join(tempUserData, "remote-config-cache.json"), { force: true });
  remoteConfig.reloadRemoteConfigCache();
  assert.equal(remoteConfig.getRemoteCharacterWorldsPolicySync(), null);
  assert.deepEqual(
    C.characterWorldsPolicy(remoteConfig.getRemoteEffectiveConfigSync()),
    { enabled: false, reason: "remote_disabled" },
  );
});

// --- IPC gate: selection/import disabled, data stays readable -----------------

const handlers = new Map();
const trustedWebContents = { id: 7 };
const mainWindow = { webContents: trustedWebContents, isDestroyed: () => false };
let openDialogCalls = 0;

const electronMock = {
  ipcMain: {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  },
  dialog: {
    showOpenDialog: async () => {
      openDialogCalls += 1;
      return { canceled: false, filePaths: ["/tmp/should-not-happen.png"] };
    },
    showSaveDialog: async () => ({ canceled: false, filePath: path.join(tempRoot, "export.json") }),
  },
  app: { getPath: () => tempUserData },
  safeStorage: { isEncryptionAvailable: () => false },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};

const { registerCharacterWorldsHandlers } = require("../src/main/ipc-character-worlds.js");

function trustedEvent() {
  return { sender: trustedWebContents, senderFrame: { url: "file:///app/renderer/index.html" } };
}

let ipcPolicy = { enabled: false, reason: "remote_disabled" };
const setBindingCalls = [];
const ipcCtx = {
  mainWindow,
  characterWorldsPolicy: () => ipcPolicy,
  characterWorldsService: {
    previewImport: async () => {
      throw new Error("previewImport must not run while policy-disabled");
    },
    commitImport: async () => {
      throw new Error("commitImport must not run while policy-disabled");
    },
    destinationWriter: { approve: async () => ({ kind: "test-capability" }) },
    exportCharacter: async () => ({ ok: true, exported: true }),
  },
  characterWorldsRepository: {
    listCharacters: () => [{ id: "char-1", displayName: "Aria" }],
    getCharacter: () => ({ id: "char-1", displayName: "Aria" }),
    getRevision: () => ({
      id: "rev-1",
      displayName: "Aria",
      source: { container: "json" },
    }),
    getBinding: () => ({ mode: "character", characterRevisionId: "rev-1", version: 3 }),
    setBinding: (input) => {
      setBindingCalls.push(input);
      return { mode: input.next.mode, version: input.expectedBindingVersion + 1 };
    },
    getBindingEvents: () => [{ version: 3, mode: "character" }],
  },
  resolveCharacterOwnerScope: () => "profile:local",
  sessionManager: {
    resolveTurnOwnerScope: () => Object.freeze({ ok: true, error: null, ownerScope: "profile:local" }),
  },
};
registerCharacterWorldsHandlers(ipcCtx);

await check("disabled policy blocks selection but keeps data readable over IPC", async () => {
  ipcPolicy = { enabled: false, reason: "remote_disabled" };
  const selectCharacter = await handlers.get("session-character:set-binding")(trustedEvent(), {
    sessionId: "session-a",
    expectedBindingVersion: 3,
    mode: "character",
    characterRevisionId: "rev-1",
  });
  assert.deepEqual(selectCharacter, { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" });
  assert.equal(setBindingCalls.length, 0, "the repository must not be mutated while disabled");

  // Deselecting back to native is always allowed — the policy gates
  // selection/import availability, never the return to native Lily.
  const deselect = await handlers.get("session-character:set-binding")(trustedEvent(), {
    sessionId: "session-a",
    expectedBindingVersion: 3,
    mode: "native",
  });
  assert.equal(deselect.ok, true, "deselection to native bypasses the policy gate");
  assert.equal(setBindingCalls.length, 1);
  assert.equal(setBindingCalls[0].next.mode, "native");
  setBindingCalls.length = 0;

  const importPreview = await handlers.get("character:import-preview")(trustedEvent(), {});
  assert.deepEqual(importPreview, { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" });
  assert.equal(openDialogCalls, 0, "the open dialog must not even appear while disabled");

  const importCommit = await handlers.get("character:import-commit")(trustedEvent(), {
    previewToken: "a".repeat(64),
  });
  assert.deepEqual(importCommit, { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" });

  // Data stays readable: list/get/binding-read/events/export keep working.
  const list = await handlers.get("character:list")(trustedEvent(), {});
  assert.equal(list.ok, true, "listCharacters stays readable");
  assert.equal(list.characters[0].id, "char-1");
  const got = await handlers.get("character:get")(trustedEvent(), { characterId: "char-1" });
  assert.equal(got.ok, true, "getCharacter stays readable");
  const binding = await handlers.get("session-character:get-binding")(trustedEvent(), { sessionId: "session-a" });
  assert.equal(binding.ok, true, "binding reads stay readable");
  assert.equal(binding.binding.characterRevisionId, "rev-1");
  const events = await handlers.get("session-character:get-events")(trustedEvent(), { sessionId: "session-a" });
  assert.equal(events.ok, true, "binding events stay readable");
  const exported = await handlers.get("character:export")(trustedEvent(), { revisionId: "rev-1" });
  assert.equal(exported.ok, true, "export stays allowed under a disabled policy");
});

await check("enabled policy re-enables selection over IPC", async () => {
  ipcPolicy = { enabled: true, compatibilityProfile: "lily-character-compat-1" };
  const setBinding = await handlers.get("session-character:set-binding")(trustedEvent(), {
    sessionId: "session-a",
    expectedBindingVersion: 3,
    mode: "native",
  });
  assert.equal(setBinding.ok, true);
  assert.equal(setBindingCalls.length, 1);
});

await check("policy resolution failure fails closed over IPC", async () => {
  ipcPolicy = null;
  ipcCtx.characterWorldsPolicy = () => {
    throw new Error("resolver exploded");
  };
  const setBinding = await handlers.get("session-character:set-binding")(trustedEvent(), {
    sessionId: "session-a",
    expectedBindingVersion: 4,
    mode: "character",
    characterRevisionId: "rev-1",
  });
  assert.deepEqual(setBinding, { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" });
  assert.equal(setBindingCalls.length, 1, "still no mutation after a resolver failure");
});

await check("default IPC policy path (no override, no remote config) fails closed", async () => {
  delete ipcCtx.characterWorldsPolicy;
  fs.rmSync(path.join(tempUserData, "remote-config-cache.json"), { force: true });
  remoteConfig.reloadRemoteConfigCache();
  const setBinding = await handlers.get("session-character:set-binding")(trustedEvent(), {
    sessionId: "session-a",
    expectedBindingVersion: 4,
    mode: "character",
    characterRevisionId: "rev-1",
  });
  assert.deepEqual(setBinding, { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" });
});

// --- turn orchestrator: compilation gate ---------------------------------------

const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");

const COMPILE_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  mode: "character",
  bindingVersion: 2,
  characterRevisionId: "rev-9",
  compatibilityProfile: "lily-character-worlds-v1",
  snapshotStatus: "ready",
});
const COMPILE_REVISION = {
  schemaVersion: 1,
  id: "rev-9",
  characterId: "char-9",
  revisionNumber: 1,
  contentHash: "sha256:" + "b".repeat(64),
  source: { kind: "imported", format: "character_card_v2", container: "json" },
  canonical: {
    schemaVersion: 1,
    name: "Aria",
    description: "A meticulous archivist.",
    personality: "precise",
    scenario: "The great library.",
    exampleDialogue: "{{user}}: Hi\n{{char}}: Hello.",
    systemPrompt: "Imported narrator prompt.",
    postHistoryInstructions: "Stay in character.",
  },
};

function orchestratorCtx(policy) {
  return {
    characterWorldsPolicy: typeof policy === "function" ? policy : () => policy,
    sessionManager: {
      resolveTurnOwnerScope: () => ({ ok: true, ownerScope: "profile:local" }),
    },
    characterWorldsRepository: {
      getRevision: () => COMPILE_REVISION,
    },
  };
}

function compileWith(fakeCtx, stateOverrides = {}) {
  const instance = Object.create(TurnOrchestrator.prototype);
  instance.ctx = fakeCtx;
  const state = {
    characterWorldsSnapshot: COMPILE_SNAPSHOT,
    enginePayload: { text: "hello" },
    ...stateOverrides,
  };
  const compiled = instance._compileTurnCharacterContext({ id: "session-policy" }, state, null);
  return { compiled, state };
}

await check("disabled policy skips compilation with the reason recorded", async () => {
  const { compiled, state } = compileWith(orchestratorCtx({ enabled: false, reason: "remote_disabled" }));
  assert.equal(compiled, null, "policy-disabled turns run native Lily");
  assert.equal(
    state.characterWorldsPolicyReason,
    "remote_disabled",
    "the metadata-only trace carries the policy reason",
  );
});

await check("kill switch skips compilation even with an enabled remote policy", async () => {
  const previous = process.env.LILY_CHARACTER_WORLDS;
  process.env.LILY_CHARACTER_WORLDS = "0";
  try {
    // No ctx override: resolve through the real remote-config fallback path.
    const ctx = orchestratorCtx(null);
    delete ctx.characterWorldsPolicy;
    writeRemoteConfigCache(ENABLED_POLICY_STATE);
    const { compiled, state } = compileWith(ctx);
    assert.equal(compiled, null);
    assert.equal(state.characterWorldsPolicyReason, "kill_switch");
  } finally {
    if (previous == null) delete process.env.LILY_CHARACTER_WORLDS;
    else process.env.LILY_CHARACTER_WORLDS = previous;
  }
});

await check("enabled policy compiles the admitted snapshot", async () => {
  const { compiled } = compileWith(orchestratorCtx({ enabled: true, compatibilityProfile: "lily-character-compat-1" }));
  assert.equal(compiled?.status, "compiled", "an enabled policy compiles character context");
});

await check("policy resolver failure fails open to native Lily", async () => {
  const { compiled, state } = compileWith(
    orchestratorCtx(() => {
      throw new Error("resolver exploded");
    }),
  );
  assert.equal(compiled, null);
  assert.equal(state.characterWorldsPolicyReason, "policy_error");
});

await check("native-mode snapshots never touch policy resolution", async () => {
  let policyCalls = 0;
  const ctx = orchestratorCtx(() => {
    policyCalls += 1;
    return { enabled: true };
  });
  const { compiled } = compileWith(ctx, {
    characterWorldsSnapshot: { mode: "native" },
  });
  assert.equal(compiled, null);
  assert.equal(policyCalls, 0, "policy is only resolved for admitted character snapshots");
});

console.log(`character-worlds-policy: ok (${checks} checks)`);
