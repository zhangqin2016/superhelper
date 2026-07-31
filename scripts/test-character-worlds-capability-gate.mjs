#!/usr/bin/env node
/**
 * Character Worlds capability gate (Task 11, spec §10/§16/§18; plan Task 11
 * Step 1). Closed-loop proof that every Phase 1 failure mode degrades to the
 * NATIVE Lily turn — never to a changed, weaker, or double-dispatched one.
 *
 * For each failure mode
 *   [disabled, missing_binding, missing_revision, parser_error, macro_error,
 *    compiler_error, over_budget, provider_unsupported]
 * a turn is dispatched through the REAL TurnOrchestrator + REAL SessionManager
 * admission + REAL MessageStore/CharacterWorldsRepository and the REAL
 * OpencodeServerManager.sendPrompt -> buildOpencodePromptBody path, and the
 * resulting prompt body must be byte-identical to the native baseline (same
 * session/snapshot mode "native"): byte-equal system + parts, exactly one
 * dispatch. Tools, skill IDs, model, permission mode, files, evidence/context
 * layers, subagent surface, current user text, and output reserve must be
 * identical to native Lily.
 *
 * Positive controls at the end prove the test is not vacuous: a compiled
 * context on a supported provider DOES change the system suffix (only), so a
 * regression that leaks character state into any failure mode is detected.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-character-capability-gate-"));
process.env.LILY_USER_DATA_DIR = tmp;
// Failure-path retries would occupy the fake runner and queue later sends;
// each retry loop has its own closed loop elsewhere.
process.env.LILY_TOOL_CALL_RESCUE = "0";
process.env.LILY_EMPTY_COMPLETION_RETRY = "0";
process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY = "0";
process.env.LILY_MODEL_CONNECTION_RETRY = "0";
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// Deterministic wall-clock context: the native baseline and every failure-mode
// turn must compose the identical engine text, so the per-turn clock line is
// pinned to a fixed instant (the real formatter, a fixed Date).
const clockPath = require.resolve("../src/main/turn-clock-context.js");
const FIXED_CLOCK_LINE = require(clockPath).currentDateTimeLine(new Date(2026, 6, 30, 12, 0, 0));
require.cache[clockPath] = {
  id: clockPath,
  filename: clockPath,
  loaded: true,
  exports: { currentDateTimeLine: () => FIXED_CLOCK_LINE },
};
// Usage/diagnostic uploads are irrelevant to the prompt body; stub the
// service client exactly like test-turn-orchestrator.mjs.
const serviceClientPath = require.resolve("../src/main/service-client.js");
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    reportUsage: async () => ({ ok: true }),
    reportRuntimeDiagnostic: async () => ({ ok: true, json: { id: "diag_test" } }),
  },
};
// Count policy resolution and remote-config reads so the native path can be
// pinned to ZERO Character Worlds work per turn (review 3a: the native
// early-return in turn-orchestrator._compileTurnCharacterContext must run
// before any policy resolution). Two counters:
// - remoteConfigReads wraps remote-config.getRemoteEffectiveConfigSync. NOTE:
//   task-contract classification reads remote config once per turn as
//   pre-existing baseline behavior, so the pin is RELATIVE: a character
//   failure-mode turn must add ZERO reads beyond the native baseline delta.
// - characterPolicyResolutions wraps the character-worlds/constants.js
//   characterWorldsPolicy resolver used by the real (non-ctx-override) path.
const remoteConfigPath = require.resolve("../src/main/remote-config.js");
const realRemoteConfig = require(remoteConfigPath);
let remoteConfigReads = 0;
const countingRemoteConfig = Object.create(realRemoteConfig);
countingRemoteConfig.getRemoteEffectiveConfigSync = (...args) => {
  remoteConfigReads += 1;
  return realRemoteConfig.getRemoteEffectiveConfigSync(...args);
};
require.cache[remoteConfigPath] = {
  id: remoteConfigPath,
  filename: remoteConfigPath,
  loaded: true,
  exports: countingRemoteConfig,
};
const characterConstantsPath = require.resolve("../src/main/character-worlds/constants.js");
const realCharacterConstants = require(characterConstantsPath);
let characterPolicyResolutions = 0;
const countingCharacterConstants = Object.create(realCharacterConstants);
countingCharacterConstants.characterWorldsPolicy = (...args) => {
  characterPolicyResolutions += 1;
  return realCharacterConstants.characterWorldsPolicy(...args);
};
require.cache[characterConstantsPath] = {
  id: characterConstantsPath,
  filename: characterConstantsPath,
  loaded: true,
  exports: countingCharacterConstants,
};

const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");
const { MessageStore } = require("../src/main/store/message-store.js");
const SessionManager = require("../src/main/session-manager.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  CHARACTER_COMPATIBILITY_PROFILE,
} = require("../src/main/character-worlds/constants.js");
const { OpencodeServerManager } = require("../src/main/runtime/opencode-server-manager.js");
const { buildOpencodePromptBody } = require("../src/main/runtime/opencode-message-parts.js");

const OWNER = "profile:cw-gate-owner";
const PROJECT = "project-cw-gate";
const USER_TEXT = "hello there, how are you today";

// The native engine surface a dispatch must never mutate: tools, skill IDs,
// model, permission mode, guidance, and output reserve.
function freshSpawnOptions() {
  return {
    guidance: "LILY PROTECTED GUIDANCE\n- keep every tool and permission rule",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    permissionMode: "workspace-write",
    tools: ["Read", "Edit", "Bash", "WebSearch"],
    skillIds: ["lily-docx", "lily-pdf"],
    outputReserveTokens: 8192,
  };
}
const SERVER_ENV = Object.freeze({
  LILY_MODEL_CAPABILITY_GRADE: "standard",
  LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS: "200000",
  LILY_OUTPUT_TOKEN_RESERVE: "8192",
});

class FakeRunner extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.busy = false;
    this.sentPayloads = [];
    this.spawnOptions = freshSpawnOptions();
  }
  isBusy() {
    return this.busy;
  }
  isAlive() {
    return true;
  }
  sendUserMessage(payload) {
    if (this.busy) return false;
    this.busy = true;
    this.sentPayloads.push(payload);
    return true;
  }
  respondPermission() {
    return true;
  }
  respondUserQuestion() {
    return true;
  }
  respondHook() {
    return true;
  }
  interrupt() {
    this.busy = false;
  }
  compactContext() {
    return Promise.resolve({ ok: true });
  }
  diagnostics() {
    return { sessionId: this.sessionId, busy: this.busy };
  }
}

function fakeProjectManager() {
  return {
    projects: [{ id: PROJECT, path: tmp }],
    activeProjectId: PROJECT,
    getActive() {
      return this.projects[0];
    },
    find(id) {
      return this.projects.find((project) => project.id === id) || null;
    },
  };
}

function makeSession(id) {
  return {
    id,
    projectId: PROJECT,
    title: id,
    messages: [],
    messageCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    status: "idle",
  };
}

function sourceOf(name) {
  return {
    kind: "created",
    format: "lily",
    container: "json",
    originalFileName: `${name}.json`,
  };
}

function bindingEnvelope({ bindingVersion, characterRevisionId, compatibilityProfile }) {
  return JSON.stringify({
    schemaVersion: 1,
    bindingVersion,
    compatibilityProfileVersion: 1,
    compatibilityProfile,
    mode: "character",
    activeCharacterRevisionId: characterRevisionId,
    activePersonaRevisionId: null,
    activeGreetingIndex: null,
    worldBookBindings: [],
    worldResolutionPolicy: { sourceMergeStrategy: "sorted_evenly" },
    groupSceneId: null,
    effectiveAfterTurnId: null,
    updatedAt: new Date(0).toISOString(),
  });
}

// --- real persistence + admission stack --------------------------------------
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = new CharacterWorldsRepository(store);
const aria = repository.createCharacter({
  ownerScope: OWNER,
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
  source: sourceOf("aria"),
});

const SESSION_IDS = {
  native: "s-native",
  nativeRealPolicyPath: "s-native-real-policy-path",
  disabled: "s-disabled",
  missing_binding: "s-missing-binding",
  missing_revision: "s-missing-revision",
  parser_error: "s-parser-error",
  macro_error: "s-macro-error",
  compiler_error: "s-compiler-error",
  over_budget: "s-over-budget",
  provider_unsupported: "s-provider-unsupported",
  control: "s-control",
};
const sessions = Object.values(SESSION_IDS).map(makeSession);
const manager = new SessionManager(fakeProjectManager(), {
  resolveCharacterOwnerScope: () => OWNER,
});
manager.sessions = { [PROJECT]: sessions };
manager.activeSessionId = SESSION_IDS.native;
manager._messageStore = store;
manager._ensureImported = () => {};

function bindCharacter(sessionId) {
  repository.setBinding({
    sessionId,
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: {
      mode: "character",
      characterRevisionId: aria.revision.id,
      compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE,
    },
  });
}

// missing_revision: a binding row that names a revision id which does not
// exist (mirrors the SESSION_MISSING fixture in test-character-binding-isolation).
store.db.exec("PRAGMA foreign_keys = OFF");
store.db.run(
  `INSERT INTO character_session_bindings
     (session_id, owner_scope, binding_version, mode, character_revision_id,
      compatibility_profile, binding_json, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  SESSION_IDS.missing_revision,
  OWNER,
  9,
  "character",
  "foreign-revision-secret-id",
  "profile-missing-secret",
  bindingEnvelope({
    bindingVersion: 9,
    characterRevisionId: "foreign-revision-secret-id",
    compatibilityProfile: "profile-missing-secret",
  }),
  Date.now(),
);
store.db.exec("PRAGMA foreign_keys = ON");

for (const id of [
  SESSION_IDS.disabled,
  SESSION_IDS.macro_error,
  SESSION_IDS.compiler_error,
  SESSION_IDS.over_budget,
  SESSION_IDS.provider_unsupported,
  SESSION_IDS.control,
]) {
  bindCharacter(id);
}
// parser_error: the stored card payload no longer parses (corrupt packed
// canonical JSON). Revisions are immutable, so the corrupt row is inserted
// directly (as a crash/quarantine leftover would appear); admission still
// pins a ready snapshot, and the read must fail open at compile time without
// touching the native turn.
const zlib = require("node:zlib");
const corruptRevisionId = "corrupt-revision-parser-error";
store.db.exec("PRAGMA foreign_keys = OFF");
store.db.run(
  `INSERT INTO character_entities
     (id, owner_scope, display_name, current_revision_id, archived_at,
      created_at, updated_at)
   VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  "corrupt-entity-parser-error",
  OWNER,
  "Corrupt",
  corruptRevisionId,
  Date.now(),
  Date.now(),
);
store.db.run(
  `INSERT INTO character_revisions
     (id, entity_id, owner_scope, parent_revision_id, revision_number,
      display_name, source_kind, source_format, source_container,
      canonical_json, source_json, canonical_hash, original_hash,
      revision_hash, created_at)
   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  corruptRevisionId,
  "corrupt-entity-parser-error",
  OWNER,
  1,
  "Corrupt",
  "created",
  "lily",
  "json",
  Buffer.from("corrupt-not-a-gzip-payload"),
  zlib.gzipSync(Buffer.from(JSON.stringify({ kind: "created", format: "lily", container: "json" }), "utf8")),
  "c".repeat(64),
  "d".repeat(64),
  "e".repeat(64),
  Date.now(),
);
store.db.exec("PRAGMA foreign_keys = ON");
repository.setBinding({
  sessionId: SESSION_IDS.parser_error,
  ownerScope: OWNER,
  expectedBindingVersion: 0,
  next: {
    mode: "character",
    characterRevisionId: corruptRevisionId,
    compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE,
  },
});
// Keep the clean revision for the wrapper repositories used by the other
// failure modes (the real repository only serves the corrupt row above).
const cleanRevision = aria.revision;
const cleanRepository = {
  getRevision: () => cleanRevision,
};

// --- orchestrator harness (mirrors test-turn-orchestrator.mjs) ----------------
const runners = new Map(sessions.map((session) => [session.id, new FakeRunner(session.id)]));
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send() {} },
};
let activePolicy = { enabled: true, compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE };
let characterPolicyCalls = 0;
const ctx = {
  get mainWindow() {
    return fakeWindow;
  },
  eventBus: new RuntimeEventBus(() => fakeWindow),
  sessionManager: manager,
  projectManager: fakeProjectManager(),
  runnerPool: {
    get: (sessionId) => runners.get(sessionId) || null,
    ensure: () => runners.get(SESSION_IDS.native),
    terminateSession: () => {},
    getSessionIds: () => [...runners.keys()],
  },
  scheduledTaskManager: {
    canStartRun: () => true,
    markRunStarted: () => true,
    completeQueuedRun: () => true,
  },
  characterWorldsPolicy: () => {
    characterPolicyCalls += 1;
    return activePolicy;
  },
  characterWorldsRepository: null,
};
ctx.transcriptStore = new TranscriptStore(manager);
ctx.turnArchive = new TurnArchive(manager, { eventBus: ctx.eventBus });
ctx.turnOrchestrator = new TurnOrchestrator(ctx);

// --- real prompt-body path (mirrors opencode-agent-session.sendUserMessage) ---
async function promptBodyFor(payload, { grade } = {}) {
  const server = new OpencodeServerManager({
    serverCommand: "/bin/true",
    cwd: tmp,
    dataDir: ":memory:",
    env: { ...SERVER_ENV, ...(grade ? { LILY_MODEL_CAPABILITY_GRADE: grade } : {}) },
  });
  server.sessionID = "ses_capability_gate";
  server.agent = "build";
  server.model = freshSpawnOptions().model;
  const bodies = [];
  server._sdkSession = {
    promptAsync: async (_sessionId, body) => {
      bodies.push(body);
    },
  };
  await server.sendPrompt({
    text: payload.text,
    files: payload.files,
    guidance: freshSpawnOptions().guidance,
    allowImageFileParts: payload.allowImageFileParts === true,
    characterContext: payload.characterContext || null,
  });
  assert.equal(bodies.length, 1, "exactly one engine prompt body per dispatch");
  return bodies[0];
}

let dispatchedTurns = 0;
async function dispatchTurn(sessionId, label) {
  const runner = runners.get(sessionId);
  const before = runner.sentPayloads.length;
  const result = await ctx.turnOrchestrator.sendUserMessage(sessionId, USER_TEXT, [], {
    spawnEngine: false,
    skipPreflight: true,
    skipVision: true,
    skipDocument: true,
  });
  assert.equal(result.ok, true, `${label}: turn dispatched: ${JSON.stringify(result)}`);
  assert.equal(runner.sentPayloads.length, before + 1, `${label}: exactly one dispatch`);
  dispatchedTurns += 1;
  // The character pipeline must never mutate the configured engine surface.
  assert.deepEqual(
    runner.spawnOptions,
    freshSpawnOptions(),
    `${label}: tools/skill IDs/model/permission mode/output reserve unchanged`,
  );
  return runner.sentPayloads.at(-1);
}

function stripCharacterTrace(trace) {
  const { characterContext, ...rest } = trace || {};
  return rest;
}

// Trace-shape guards (review 3b): trace.characterContext is metadata-only.
const CARD_TEXT_SNIPPETS = [
  "Aria",
  "meticulous archivist",
  "great library",
  "precise",
  "Imported narrator prompt",
  "Stay in character",
  "{{user}}",
  "Hello.",
];
const COMPILED_TRACE_KEYS = new Set([
  "status",
  "fingerprint",
  "revisionId",
  "expressionProfile",
  "activatedFields",
  "omitted",
  "warnings",
  "tokenEstimate",
  "policyReason",
]);
const NATIVE_TRACE_KEYS = new Set(["status", "revisionId", "policyReason"]);

function assertNoCardText(serialized, label) {
  for (const snippet of CARD_TEXT_SNIPPETS) {
    assert.equal(
      serialized.includes(snippet),
      false,
      `${label}: card text never enters the trace (${JSON.stringify(snippet)})`,
    );
  }
}

function assertStringsBounded(value, label, path = "trace.characterContext") {
  if (typeof value === "string") {
    assert.ok(value.length <= 512, `${label}: ${path} is bounded (${value.length} chars)`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStringsBounded(entry, label, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertStringsBounded(entry, label, `${path}.${key}`);
    }
  }
}

function assertTraceMetadataOnly(trace, label, allowedKeys) {
  assert.ok(trace && typeof trace === "object", `${label}: trace.characterContext present`);
  for (const key of Object.keys(trace)) {
    assert.ok(allowedKeys.has(key), `${label}: unexpected trace key ${key}`);
  }
  const serialized = JSON.stringify(trace);
  assertNoCardText(serialized, label);
  assertStringsBounded(trace, label);
}

let baselinePayload;
let baselineBody;

function assertNativeEquivalent(payload, body, label) {
  assert.equal(
    payload.characterContext,
    null,
    `${label}: no character context reaches the engine payload`,
  );
  assert.deepEqual(body, baselineBody, `${label}: prompt body identical to native baseline`);
  assert.equal(body.system, baselineBody.system, `${label}: system bytes identical`);
  assert.equal(
    JSON.stringify(body.parts),
    JSON.stringify(baselineBody.parts),
    `${label}: parts bytes identical`,
  );
  // Current user text and every composed context/evidence/subagent layer.
  assert.equal(payload.text, baselinePayload.text, `${label}: engine text identical`);
  assert.equal(payload.rawText, baselinePayload.rawText, `${label}: current user text identical`);
  assert.deepEqual(payload.files, baselinePayload.files, `${label}: files identical`);
  assert.deepEqual(payload.displayFiles, baselinePayload.displayFiles, `${label}: display files identical`);
  assert.equal(
    payload.allowImageFileParts,
    baselinePayload.allowImageFileParts,
    `${label}: file-part surface identical`,
  );
  assert.equal(payload.nonInteractive, baselinePayload.nonInteractive, `${label}: interactivity identical`);
  assert.deepEqual(payload.taskContract, baselinePayload.taskContract, `${label}: task contract identical`);
  assert.deepEqual(payload.turnPolicy, baselinePayload.turnPolicy, `${label}: turn policy identical`);
  assert.deepEqual(
    stripCharacterTrace(payload.trace),
    stripCharacterTrace(baselinePayload.trace),
    `${label}: dispatch trace (minus metadata-only character record) identical`,
  );
}

const enabledPolicy = { enabled: true, compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE };

// --- native baseline: same session/snapshot mode "native", policy enabled ----
// Side-effect pin (review 3a): the native path resolves ZERO Character Worlds
// policies per turn — this guards the native early-return in
// turn-orchestrator._compileTurnCharacterContext against any hoisting of
// policy resolution above it. Remote-config reads are pinned RELATIVE to this
// native delta: task-contract classification reads remote config once per turn
// as pre-existing behavior unrelated to Character Worlds, so failure-mode
// turns must add ZERO reads beyond it.
activePolicy = enabledPolicy;
ctx.characterWorldsRepository = null;
let policyCallsBefore = characterPolicyCalls;
let remoteReadsBefore = remoteConfigReads;
baselinePayload = await dispatchTurn(SESSION_IDS.native, "native baseline");
assert.equal(characterPolicyCalls, policyCallsBefore, "native turn resolves no Character Worlds policy");
const nativeRemoteReadDelta = remoteConfigReads - remoteReadsBefore;
baselineBody = await promptBodyFor(baselinePayload);
assert.equal(baselinePayload.characterContext, null, "native baseline carries no character context");
{
  const nativeTurnId = ctx.turnOrchestrator._state(SESSION_IDS.native).turnId;
  const admitted = store.getTurnInputByTurnId(nativeTurnId);
  assert.equal(
    Object.hasOwn(admitted.metadata, "characterWorlds"),
    false,
    "native admission allocates no Character Worlds metadata",
  );
}
{
  // Same pin through the REAL policy-resolution path (no ctx override): the
  // native snapshot must short-circuit before the characterWorldsPolicy
  // resolver (and its remote-config read) ever runs.
  const override = ctx.characterWorldsPolicy;
  ctx.characterWorldsPolicy = undefined;
  try {
    const resolutionsBefore = characterPolicyResolutions;
    remoteReadsBefore = remoteConfigReads;
    const payload = await dispatchTurn(SESSION_IDS.nativeRealPolicyPath, "native (real policy path)");
    assert.equal(
      characterPolicyResolutions,
      resolutionsBefore,
      "native turn never reaches the real Character Worlds policy resolver",
    );
    assert.equal(
      remoteConfigReads - remoteReadsBefore,
      nativeRemoteReadDelta,
      "real policy path adds zero remote-config reads on a native turn",
    );
    const body = await promptBodyFor(payload);
    assertNativeEquivalent(payload, body, "native (real policy path)");
  } finally {
    ctx.characterWorldsPolicy = override;
  }
}

// --- failure mode matrix ------------------------------------------------------
const failures = [
  {
    name: "disabled",
    sessionId: SESSION_IDS.disabled,
    policy: { enabled: false, reason: "kill_switch" },
    repository: cleanRepository,
    expectedTrace: { status: "native", revisionId: aria.revision.id, policyReason: "kill_switch" },
    expectedPolicyCalls: 1,
  },
  {
    name: "missing_binding",
    sessionId: SESSION_IDS.missing_binding,
    policy: enabledPolicy,
    repository: cleanRepository,
    expectedTrace: null,
    expectedPolicyCalls: 0,
  },
  {
    name: "missing_revision",
    sessionId: SESSION_IDS.missing_revision,
    policy: enabledPolicy,
    repository: cleanRepository,
    expectedTrace: null,
    expectedAdmissionSnapshot: "fallback",
    expectedPolicyCalls: 0,
  },
  {
    name: "parser_error",
    sessionId: SESSION_IDS.parser_error,
    policy: enabledPolicy,
    repository: null, // real repository, corrupt stored payload
    expectedTrace: { status: "native", revisionId: corruptRevisionId },
    expectedPolicyCalls: 1,
  },
  {
    name: "macro_error",
    sessionId: SESSION_IDS.macro_error,
    policy: enabledPolicy,
    repository: {
      getRevision: () => ({
        ...cleanRevision,
        // Lone surrogate: the safe-macro engine rejects ill-formed UTF-16 and
        // expands to an empty identity, which must fail open to native.
        canonical: { ...cleanRevision.canonical, name: "\uD800{{char}}" },
      }),
    },
    expectedTrace: { status: "native", revisionId: aria.revision.id },
    expectedPolicyCalls: 1,
  },
  {
    name: "compiler_error",
    sessionId: SESSION_IDS.compiler_error,
    policy: enabledPolicy,
    repository: {
      getRevision: () => {
        throw new Error("injected repository read failure");
      },
    },
    expectedTrace: { status: "native", revisionId: aria.revision.id },
    expectedPolicyCalls: 1,
  },
  {
    name: "over_budget",
    sessionId: SESSION_IDS.over_budget,
    policy: enabledPolicy,
    repository: {
      getRevision: () => ({
        ...cleanRevision,
        canonical: { ...cleanRevision.canonical, name: "x".repeat(200_000) },
      }),
    },
    expectedTrace: { status: "native", revisionId: aria.revision.id },
    expectedPolicyCalls: 1,
  },
];

const failurePayloads = new Map();
for (const failure of failures) {
  activePolicy = failure.policy;
  ctx.characterWorldsRepository = failure.repository;
  const policyCallsBeforeTurn = characterPolicyCalls;
  const remoteReadsBeforeTurn = remoteConfigReads;
  const payload = await dispatchTurn(failure.sessionId, failure.name);
  failurePayloads.set(failure.name, payload);
  assert.equal(
    characterPolicyCalls - policyCallsBeforeTurn,
    failure.expectedPolicyCalls,
    `${failure.name}: policy resolved exactly when a ready snapshot requires it`,
  );
  assert.equal(
    remoteConfigReads - remoteReadsBeforeTurn,
    nativeRemoteReadDelta,
    `${failure.name}: failure turn adds zero remote-config reads beyond native`,
  );
  const state = ctx.turnOrchestrator._state(failure.sessionId);
  const admitted = store.getTurnInputByTurnId(state.turnId);
  if (failure.expectedAdmissionSnapshot === "fallback") {
    assert.equal(
      admitted.metadata.characterWorlds?.snapshotStatus,
      "fallback",
      `${failure.name}: admission pinned the native fallback snapshot`,
    );
    assert.equal(
      JSON.stringify(admitted).includes("foreign-revision-secret-id"),
      false,
      `${failure.name}: the missing revision id never leaks into the admission`,
    );
  } else if (failure.expectedTrace) {
    assert.equal(
      admitted.metadata.characterWorlds?.mode,
      "character",
      `${failure.name}: admission pinned a ready character snapshot (failure engaged downstream)`,
    );
  } else {
    assert.equal(
      Object.hasOwn(admitted.metadata, "characterWorlds"),
      false,
      `${failure.name}: native admission allocates no Character Worlds metadata`,
    );
  }
  assert.deepEqual(
    payload.trace.characterContext ?? null,
    failure.expectedTrace,
    `${failure.name}: metadata-only trace records the native outcome`,
  );
  if (payload.trace.characterContext) {
    assertTraceMetadataOnly(payload.trace.characterContext, failure.name, NATIVE_TRACE_KEYS);
  }
  const body = await promptBodyFor(payload);
  assertNativeEquivalent(payload, body, failure.name);
}

// --- provider_unsupported: the context compiles, but a provider that cannot --
// --- safely carry per-request system context receives the native body. --------
{
  activePolicy = enabledPolicy;
  ctx.characterWorldsRepository = cleanRepository;
  const payload = await dispatchTurn(SESSION_IDS.provider_unsupported, "provider_unsupported");
  assert.equal(
    payload.characterContext?.status,
    "compiled",
    "provider_unsupported: context compiled (failure must be exercised at the provider layer)",
  );
  const liteBody = await promptBodyFor(payload, { grade: "lite" });
  assert.deepEqual(
    liteBody,
    baselineBody,
    "provider_unsupported: lite-grade provider receives the byte-identical native body",
  );
  const directNative = buildOpencodePromptBody({
    text: payload.text,
    guidance: freshSpawnOptions().guidance,
    agent: "build",
    model: freshSpawnOptions().model,
  });
  const directOptOut = buildOpencodePromptBody({
    text: payload.text,
    guidance: freshSpawnOptions().guidance,
    agent: "build",
    model: freshSpawnOptions().model,
    characterContext: payload.characterContext,
    providerCapabilities: { safeSystemContext: false },
  });
  assert.deepEqual(
    directOptOut,
    directNative,
    "provider_unsupported: capability metadata opt-out receives the native body",
  );
}

// --- positive controls: the loop is not vacuous --------------------------------
let controlPayload;
{
  activePolicy = enabledPolicy;
  ctx.characterWorldsRepository = cleanRepository;
  const payload = await dispatchTurn(SESSION_IDS.control, "positive control");
  controlPayload = payload;
  assert.equal(payload.characterContext?.status, "compiled", "control: context compiled");
  // The compiled trace stays metadata-only (review 3b): documented keys only,
  // bounded strings, and never a byte of card field text.
  assertTraceMetadataOnly(payload.trace.characterContext, "positive control", COMPILED_TRACE_KEYS);
  const body = await promptBodyFor(payload);
  assert.notDeepEqual(body, baselineBody, "control: a compiled context DOES change the body");
  assert.ok(
    body.system.startsWith(baselineBody.system),
    "control: the Lily protected prefix stays byte-stable at the head of system",
  );
  assert.match(body.system, /CHARACTER WORLDS CONTEXT/);
  assert.equal(
    JSON.stringify(body.parts),
    JSON.stringify(baselineBody.parts),
    "control: parts stay byte-identical even when the context compiles",
  );
}

// --- OpencodeAgentSession mapping (review 3c) -----------------------------------
// Drive the baseline, one failure mode, and the positive control through a REAL
// OpencodeAgentSession with a fake server manager (pattern mirrors
// scripts/test-opencode-agent-session.mjs): the session must forward
// characterContext only in the compiled case, and never touch text/files/
// guidance.
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");

async function throughAgentSession(enginePayload, label) {
  const prompts = [];
  const fakeServer = new EventEmitter();
  fakeServer.process = { killed: false };
  fakeServer.sessionID = null;
  fakeServer.start = async () => ({ host: "127.0.0.1", port: 4096 });
  fakeServer.createSession = async () => {
    fakeServer.sessionID = "ses_cw_gate";
    return fakeServer.sessionID;
  };
  fakeServer.subscribe = () => {};
  fakeServer.sendPrompt = async (payload) => {
    prompts.push(payload);
  };
  fakeServer.checkHealth = async () => true;
  fakeServer.isSessionIdle = async () => true;
  fakeServer.diagnostics = () => ({ fake: true, sessionID: fakeServer.sessionID || "" });
  fakeServer.terminate = () => {
    fakeServer.process = null;
  };
  const session = new OpencodeAgentSession(`cw-gate-${label}`, { createServer: () => fakeServer });
  session.bindOrchestrator({
    ingest: () => {},
    notifyRunnerDone: () => {},
    notifyRunnerError: () => {},
  });
  session.ensureProcess(tmp, { agentCommand: "/bin/true", ...freshSpawnOptions() }, { lazy: true });
  assert.equal(session.sendUserMessage(enginePayload), true, `${label}: send accepted`);
  const deadline = Date.now() + 2_000;
  while (prompts.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(prompts.length, 1, `${label}: exactly one prompt reaches the server`);
  session.terminate();
  return prompts[0];
}

{
  const baselineMapped = await throughAgentSession(baselinePayload, "baseline");
  assert.equal(baselineMapped.characterContext, null, "agent session: baseline carries no character context");
  assert.equal(baselineMapped.text, baselinePayload.text, "agent session: baseline text untouched");
  assert.deepEqual(baselineMapped.files, baselinePayload.files, "agent session: baseline files untouched");
  assert.equal(
    baselineMapped.guidance,
    freshSpawnOptions().guidance,
    "agent session: guidance comes from spawn options, never the card",
  );
}
{
  const failureMapped = await throughAgentSession(failurePayloads.get("over_budget"), "over_budget");
  assert.equal(failureMapped.characterContext, null, "agent session: failure mode carries no character context");
  assert.equal(failureMapped.text, baselinePayload.text, "agent session: failure text identical to native");
  assert.deepEqual(failureMapped.files, baselinePayload.files, "agent session: failure files identical to native");
  assert.equal(failureMapped.guidance, freshSpawnOptions().guidance, "agent session: failure guidance untouched");
}
{
  const controlMapped = await throughAgentSession(controlPayload, "control");
  assert.equal(
    controlMapped.characterContext?.status,
    "compiled",
    "agent session: compiled context is forwarded to the server",
  );
  assert.deepEqual(
    controlMapped.characterContext,
    controlPayload.characterContext,
    "agent session: compiled context forwarded unchanged",
  );
  assert.equal(controlMapped.text, controlPayload.text, "agent session: control text untouched");
  assert.deepEqual(controlMapped.files, controlPayload.files, "agent session: control files untouched");
  assert.equal(controlMapped.guidance, freshSpawnOptions().guidance, "agent session: control guidance untouched");
}

const totalDispatches = [...runners.values()].reduce((sum, runner) => sum + runner.sentPayloads.length, 0);
assert.equal(
  totalDispatches,
  dispatchedTurns,
  "every scenario dispatched exactly once — no retries, no double sends",
);

store.close();
console.log(`character-worlds-capability-gate: ok (${failures.length + 1} failure modes, byte-equal native baseline)`);
