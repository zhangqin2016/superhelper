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
 * Phase 2A (WB-6) adds the world-book failure modes
 *   [world_book_missing, world_book_corrupt, world_book_resolver_error,
 *    world_book_over_budget]
 * where a character IS bound and the pinned book fails. Per §16 "character
 * without world entries" semantics these do NOT fall back to native: the
 * character context still compiles and the prompt body must be byte-identical
 * to the SAME character's no-book compiled body (single dispatch, unchanged
 * engine surface, metadata-only trace). A world-book positive control proves
 * the loop is not vacuous: a working book DOES change the compiled body.
 *
 * Phase 2B (P2B-6) adds the persona failure modes
 *   [persona_missing, persona_corrupt, persona_over_budget]
 * where a character with a working pinned book IS bound and the pinned persona
 * revision fails. Per §16 the character+book context still compiles and the
 * prompt body must be byte-identical to the SAME character+book no-persona
 * compiled body. A persona positive control proves the loop is not vacuous: a
 * working persona DOES change the compiled body. The authoring-isolation proof
 * closes the phase: editing a character/persona/world book through the REAL
 * CharacterAuthoringService (new immutable revisions) never alters an
 * already-admitted turn — the durable snapshot bytes are unchanged, a later
 * turn on the unchanged binding recompiles the byte-identical prompt body,
 * and the edited revision text never leaks into the pinned turn.
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

function bindingEnvelope({ bindingVersion, characterRevisionId, compatibilityProfile, personaRevisionId = null }) {
  return JSON.stringify({
    schemaVersion: 1,
    bindingVersion,
    compatibilityProfileVersion: 1,
    compatibilityProfile,
    mode: "character",
    activeCharacterRevisionId: characterRevisionId,
    activePersonaRevisionId: personaRevisionId,
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
// Phase 2B persona fixture: the working persona the persona modes pin.
const persona = repository.createPersona({
  ownerScope: OWNER,
  canonical: {
    schemaVersion: 1,
    name: "Qin",
    description: "A harbor cartographer PERSONA-SENTINEL-4471 who speaks in tides.",
  },
  source: sourceOf("qin"),
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
  world_book_missing: "s-world-book-missing",
  world_book_corrupt: "s-world-book-corrupt",
  world_book_resolver_error: "s-world-book-resolver-error",
  world_book_over_budget: "s-world-book-over-budget",
  world_book_control: "s-world-book-control",
  persona_missing: "s-persona-missing",
  persona_corrupt: "s-persona-corrupt",
  persona_over_budget: "s-persona-over-budget",
  persona_control: "s-persona-control",
  persona_book_baseline: "s-persona-book-baseline",
  authoring_isolation: "s-authoring-isolation",
  authoring_isolation_after: "s-authoring-isolation-after",
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
  SESSION_IDS.world_book_missing,
  SESSION_IDS.world_book_corrupt,
  SESSION_IDS.world_book_resolver_error,
  SESSION_IDS.world_book_over_budget,
  SESSION_IDS.world_book_control,
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
// world_book_corrupt: the pinned world-book revision row no longer parses
// (corrupt packed canonical JSON). World-book revisions are immutable, so the
// corrupt row is inserted directly (as a crash/quarantine leftover would
// appear); the compile must fail open to the same character's no-book body.
const corruptBookRevisionId = "corrupt-book-revision-parser-error";
store.db.exec("PRAGMA foreign_keys = OFF");
store.db.run(
  `INSERT INTO world_book_revisions
     (id, entity_id, owner_scope, parent_revision_id, revision_number,
      display_name, source_kind, source_format, source_container,
      canonical_json, source_json, canonical_hash, original_hash,
      revision_hash, created_at)
   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  corruptBookRevisionId,
  "corrupt-book-entity-parser-error",
  OWNER,
  1,
  "CorruptBook",
  "created",
  "lily",
  "json",
  Buffer.from("corrupt-not-a-gzip-payload"),
  zlib.gzipSync(Buffer.from(JSON.stringify({ kind: "created", format: "lily", container: "json" }), "utf8")),
  "f".repeat(64),
  "a".repeat(64),
  "b".repeat(64),
  Date.now(),
);
store.db.exec("PRAGMA foreign_keys = ON");
// persona_corrupt: the pinned persona revision row no longer parses (corrupt
// packed canonical JSON) — a REAL corrupt row read through the REAL
// repository, mirroring the character parser_error and world_book_corrupt
// fixtures. Persona revisions are immutable, so the corrupt row is inserted
// directly (as a crash/quarantine leftover would appear); setBinding only
// checks row existence, so the pin commits normally and the read must fail
// open at compile time to the no-persona compile (§16).
const corruptPersonaRevisionId = "corrupt-persona-revision-parser-error";
store.db.exec("PRAGMA foreign_keys = OFF");
store.db.run(
  `INSERT INTO persona_entities
     (id, owner_scope, display_name, current_revision_id, archived_at,
      created_at, updated_at)
   VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  "corrupt-persona-entity-parser-error",
  OWNER,
  "CorruptPersona",
  corruptPersonaRevisionId,
  Date.now(),
  Date.now(),
);
store.db.run(
  `INSERT INTO persona_revisions
     (id, entity_id, owner_scope, parent_revision_id, revision_number,
      display_name, source_kind, source_format, source_container,
      canonical_json, source_json, canonical_hash, original_hash,
      revision_hash, created_at)
   VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  corruptPersonaRevisionId,
  "corrupt-persona-entity-parser-error",
  OWNER,
  1,
  "CorruptPersona",
  "created",
  "lily",
  "json",
  Buffer.from("corrupt-not-a-gzip-payload"),
  zlib.gzipSync(Buffer.from(JSON.stringify({ kind: "created", format: "lily", container: "json" }), "utf8")),
  "1".repeat(64),
  "2".repeat(64),
  "3".repeat(64),
  Date.now(),
);
store.db.exec("PRAGMA foreign_keys = ON");
// persona_missing: a binding row that pins a persona revision id which does
// not exist (mirrors the missing_revision fixture above); admission pins a
// ready snapshot carrying the dangling persona pin, and the compile must fail
// open to the same character+book no-persona body. bindingVersion 1 matches
// every other session's first bind — the version rides the compiled envelope,
// so cross-session byte-equality requires it.
store.db.exec("PRAGMA foreign_keys = OFF");
store.db.run(
  `INSERT INTO character_session_bindings
     (session_id, owner_scope, binding_version, mode, character_revision_id,
      persona_revision_id, compatibility_profile, binding_json, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  SESSION_IDS.persona_missing,
  OWNER,
  1,
  "character",
  aria.revision.id,
  "persona-revision-gone",
  CHARACTER_COMPATIBILITY_PROFILE,
  bindingEnvelope({
    bindingVersion: 1,
    characterRevisionId: aria.revision.id,
    compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE,
    personaRevisionId: "persona-revision-gone",
  }),
  Date.now(),
);
store.db.exec("PRAGMA foreign_keys = ON");
// Persona sessions with ordinary validated pins (P2B-2): the corrupt pin
// commits because the (corrupt) row exists; the over-budget and control
// sessions pin the working persona; the baseline pins character only.
repository.setBinding({
  sessionId: SESSION_IDS.persona_corrupt,
  ownerScope: OWNER,
  expectedBindingVersion: 0,
  next: {
    mode: "character",
    characterRevisionId: aria.revision.id,
    personaRevisionId: corruptPersonaRevisionId,
    compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE,
  },
});
for (const id of [SESSION_IDS.persona_over_budget, SESSION_IDS.persona_control]) {
  repository.setBinding({
    sessionId: id,
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: {
      mode: "character",
      characterRevisionId: aria.revision.id,
      personaRevisionId: persona.revision.id,
      compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE,
    },
  });
}
bindCharacter(SESSION_IDS.persona_book_baseline);
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
  // Phase 2B persona text: metadata-only traces never carry it either.
  "PERSONA-SENTINEL-4471",
  "harbor cartographer",
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
  "activatedEntryCount",
  "worldBookBindings",
  "compiledAt",
  // Phase 2B: {revisionId, fingerprint} metadata-only persona record.
  "persona",
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
let controlBody;
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
  controlBody = body;
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
  // §20 observability: the compiled trace carries bounded activation counts
  // and world-book pin references (never card text).
  assert.equal(
    typeof payload.trace.characterContext.activatedEntryCount,
    "number",
    "control: activatedEntryCount is a bounded number",
  );
  assert.ok(
    Array.isArray(payload.trace.characterContext.worldBookBindings),
    "control: worldBookBindings is an array",
  );
  for (const pin of payload.trace.characterContext.worldBookBindings) {
    assert.equal(typeof pin.revisionId, "string", "control: book pin revision id");
    assert.equal(pin.scope, "character", "control: book pin scope");
  }
}

// --- world-book failure modes (Phase 2A, WB-6; §16 "character without world ---
// --- entries"): a character IS bound and its pinned book fails. The character ---
// --- context still compiles; the prompt body must be byte-identical to the ------
// --- SAME character's no-book compiled body (the positive control above). --------
const {
  normalizeWorldBookCanonical,
} = require("../src/main/character-worlds/world-book-model.js");

const WORLD_BOOK_SENTINEL = "WB-SENTINEL-6610";
const WORLD_CONTENT_SENTINEL = "WB-HUGE-LORE-9930";

function assertCompiledWithoutWorld(payload, body, label, { expectWorldContract = false } = {}) {
  assert.equal(
    payload.characterContext?.status,
    "compiled",
    `${label}: the character context still compiles (§16, never a native fallback)`,
  );
  if (!expectWorldContract) {
    assert.equal(
      payload.characterContext.worldBook ?? null,
      null,
      `${label}: no world-book contract rides the failed compile`,
    );
  }
  assert.equal(
    payload.characterContext.fingerprint,
    controlPayload.characterContext.fingerprint,
    `${label}: compiled text is byte-identical to the same character's no-book compile`,
  );
  assert.deepEqual(body, controlBody, `${label}: prompt body identical to the no-book compiled body`);
  assert.notDeepEqual(body, baselineBody, `${label}: guard is not vacuous — the character context DID compile`);
  assert.equal(
    JSON.stringify(body.parts),
    JSON.stringify(baselineBody.parts),
    `${label}: parts stay byte-identical`,
  );
  for (const sentinel of [WORLD_BOOK_SENTINEL, WORLD_CONTENT_SENTINEL]) {
    assert.equal(body.system.includes(sentinel), false, `${label}: failed book content never enters the prompt`);
  }
  assertTraceMetadataOnly(payload.trace.characterContext, label, COMPILED_TRACE_KEYS);
}

async function dispatchWorldBookMode({ name, sessionId, repository }) {
  activePolicy = enabledPolicy;
  ctx.characterWorldsRepository = repository;
  const policyCallsBeforeTurn = characterPolicyCalls;
  const remoteReadsBeforeTurn = remoteConfigReads;
  const payload = await dispatchTurn(sessionId, name);
  assert.equal(
    characterPolicyCalls - policyCallsBeforeTurn,
    1,
    `${name}: policy resolved exactly once for the ready snapshot`,
  );
  assert.equal(
    remoteConfigReads - remoteReadsBeforeTurn,
    nativeRemoteReadDelta,
    `${name}: failure turn adds zero remote-config reads beyond native`,
  );
  const state = ctx.turnOrchestrator._state(sessionId);
  const admitted = store.getTurnInputByTurnId(state.turnId);
  assert.equal(
    admitted.metadata.characterWorlds?.mode,
    "character",
    `${name}: admission pinned a ready character snapshot (book failure engages downstream)`,
  );
  const body = await promptBodyFor(payload);
  return { payload, body };
}

// missing: the pinned book revision does not resolve.
{
  let bookReads = 0;
  const { payload, body } = await dispatchWorldBookMode({
    name: "world_book_missing",
    sessionId: SESSION_IDS.world_book_missing,
    repository: {
      getRevision: () => ({ ...cleanRevision, characterBookRevisionId: "wb-missing-revision" }),
      getWorldBookRevision: () => {
        bookReads += 1;
        return null;
      },
    },
  });
  assert.equal(bookReads, 1, "world_book_missing: the pinned book was actually read (not vacuous)");
  assertCompiledWithoutWorld(payload, body, "world_book_missing");
}

// corrupt: the pinned book revision's stored payload no longer parses — driven
// through the REAL repository against the corrupt row inserted above. The
// character revision is pinned to it by fixture surgery on the (otherwise
// immutable) row: the immutability trigger is dropped and immediately
// recreated, and the pin is reverted right after the turn.
const PIN_TRIGGER_DDL = `CREATE TRIGGER character_revisions_no_update
  BEFORE UPDATE ON character_revisions BEGIN
    SELECT RAISE(ABORT, 'character_revisions rows are immutable');
  END`;
{
  store.db.exec("DROP TRIGGER character_revisions_no_update");
  try {
    store.db.run(
      "UPDATE character_revisions SET character_book_revision_id = ? WHERE id = ? AND owner_scope = ?",
      corruptBookRevisionId, cleanRevision.id, OWNER,
    );
  } finally {
    store.db.exec(PIN_TRIGGER_DDL);
  }
  try {
    const { payload, body } = await dispatchWorldBookMode({
      name: "world_book_corrupt",
      sessionId: SESSION_IDS.world_book_corrupt,
      repository: null, // real repository, corrupt stored book payload
    });
    assertCompiledWithoutWorld(payload, body, "world_book_corrupt");
  } finally {
    store.db.exec("DROP TRIGGER character_revisions_no_update");
    try {
      store.db.run(
        "UPDATE character_revisions SET character_book_revision_id = NULL WHERE id = ? AND owner_scope = ?",
        cleanRevision.id, OWNER,
      );
    } finally {
      store.db.exec(PIN_TRIGGER_DDL);
    }
  }
}

// resolver_error: the book revision resolves, but the activation resolver
// throws (hostile entry accessor) — world content drops with a metadata-only
// warning and the character still compiles.
{
  const hostileEntry = new Proxy({}, {
    get() {
      throw new Error("hostile accessor must never run during activation");
    },
  });
  const { payload, body } = await dispatchWorldBookMode({
    name: "world_book_resolver_error",
    sessionId: SESSION_IDS.world_book_resolver_error,
    repository: {
      getRevision: () => ({ ...cleanRevision, characterBookRevisionId: "wb-resolver-error-revision" }),
      getWorldBookRevision: () => ({
        id: "wb-resolver-error-revision",
        revisionHash: null,
        canonical: {
          schemaVersion: 1,
          name: "HostileBook",
          entries: [hostileEntry],
          scanPolicy: {},
        },
      }),
    },
  });
  assert.ok(
    (payload.characterContext.warnings || []).some((warning) => warning.code === "WORLD_BOOK_RESOLVER_FAILED"),
    "world_book_resolver_error: resolver failure recorded as a metadata-only warning",
  );
  assertCompiledWithoutWorld(payload, body, "world_book_resolver_error");
}

// over_budget: the book resolves and activates, but its entries cannot fit the
// character budget share — every world entry is omitted with a budget reason
// and the compiled body equals the no-book compile.
{
  const hugeBook = normalizeWorldBookCanonical({
    schemaVersion: 1,
    name: "HugeBook",
    entries: [{
      id: "e-huge",
      content: `${WORLD_CONTENT_SENTINEL} ${"x".repeat(900_000)}`,
      activation: { constant: true },
      insertion: { position: "before_character" },
    }],
  });
  const { payload, body } = await dispatchWorldBookMode({
    name: "world_book_over_budget",
    sessionId: SESSION_IDS.world_book_over_budget,
    repository: {
      getRevision: () => ({ ...cleanRevision, characterBookRevisionId: "wb-over-budget-revision" }),
      getWorldBookRevision: () => ({
        id: "wb-over-budget-revision",
        revisionHash: null,
        canonical: hugeBook,
      }),
    },
  });
  assert.ok(
    (payload.characterContext.omitted || []).some(
      (entry) => entry.source === "world_entry" && entry.id === "e-huge" && entry.reason.startsWith("budget"),
    ),
    "world_book_over_budget: the oversized world entry is omitted with a budget reason",
  );
  // The resolver ran (world contract present) but every world entry was
  // budget-omitted, so the compiled text is still the no-book compile.
  assertCompiledWithoutWorld(payload, body, "world_book_over_budget", { expectWorldContract: true });
}

// world-book positive control: a working pinned book DOES change the compiled
// body — the failure-mode assertions above are not vacuous.
{
  const workingBook = normalizeWorldBookCanonical({
    schemaVersion: 1,
    name: "WorkingBook",
    entries: [{
      id: "e-lore",
      content: `The sapphire archivist ${WORLD_BOOK_SENTINEL} records every arrival.`,
      activation: { constant: true },
      insertion: { position: "before_character" },
    }],
  });
  const { payload, body } = await dispatchWorldBookMode({
    name: "world_book_control",
    sessionId: SESSION_IDS.world_book_control,
    repository: {
      getRevision: () => ({ ...cleanRevision, characterBookRevisionId: "wb-working-revision" }),
      getWorldBookRevision: () => ({
        id: "wb-working-revision",
        revisionHash: null,
        canonical: workingBook,
      }),
    },
  });
  assert.equal(payload.characterContext?.status, "compiled", "world_book_control: context compiled");
  assert.equal(
    payload.characterContext.worldBook?.revisionId,
    "wb-working-revision",
    "world_book_control: the compiled contract names the book revision",
  );
  assert.deepEqual(
    (payload.characterContext.activatedWorldEntries || []).map((entry) => entry.entryId),
    ["e-lore"],
    "world_book_control: the constant entry activated",
  );
  assert.notDeepEqual(body, controlBody, "world_book_control: a working book DOES change the compiled body");
  assert.ok(
    body.system.startsWith(baselineBody.system),
    "world_book_control: the Lily protected prefix stays byte-stable at the head of system",
  );
  assert.ok(
    body.system.includes(WORLD_BOOK_SENTINEL),
    "world_book_control: activated world content lands inside the lower-authority suffix",
  );
  assert.equal(
    JSON.stringify(body.parts),
    JSON.stringify(baselineBody.parts),
    "world_book_control: parts stay byte-identical even with activated world entries",
  );
  assertTraceMetadataOnly(payload.trace.characterContext, "world_book_control", COMPILED_TRACE_KEYS);
  assert.equal(
    JSON.stringify(payload.trace.characterContext).includes(WORLD_BOOK_SENTINEL),
    false,
    "world_book_control: world content never enters the trace",
  );
}

// --- persona failure modes (Phase 2B, P2B-6; §16): a character with a -------
// --- working pinned book IS bound and the pinned persona revision fails. ----
// --- The character+book context still compiles; the prompt body must be -----
// --- byte-identical to the SAME character+book no-persona compiled body. ----
const PERSONA_BOOK_SENTINEL = "WB-PERSONA-SENTINEL-2210";
const personaWorkingBook = normalizeWorldBookCanonical({
  schemaVersion: 1,
  name: "PersonaAtlas",
  entries: [{
    id: "e-persona-lore",
    content: `The tide charts ${PERSONA_BOOK_SENTINEL} mark every harbor.`,
    activation: { constant: true },
    insertion: { position: "before_character" },
  }],
});
// The persona modes pin the same character revision PLUS a working book: the
// no-persona baseline for this section is the character+book compile.
const personaBookPinnedRevision = { ...cleanRevision, characterBookRevisionId: "wb-persona-working" };
const personaWorkingBookRevision = {
  id: "wb-persona-working",
  revisionHash: null,
  canonical: personaWorkingBook,
};

function personaSectionRepository(getPersonaRevision) {
  return {
    getRevision: () => personaBookPinnedRevision,
    getWorldBookRevision: () => personaWorkingBookRevision,
    getPersonaRevision,
  };
}

let personaBaselinePayload;
let personaBaselineBody;

function assertCompiledWithoutPersona(payload, body, label) {
  assert.equal(
    payload.characterContext?.status,
    "compiled",
    `${label}: the character+book context still compiles (§16, never a native fallback)`,
  );
  assert.equal(
    payload.characterContext.persona ?? null,
    null,
    `${label}: no persona record rides the failed compile`,
  );
  assert.equal(
    payload.characterContext.fingerprint,
    personaBaselinePayload.characterContext.fingerprint,
    `${label}: compiled text is byte-identical to the same character+book no-persona compile`,
  );
  assert.deepEqual(body, personaBaselineBody, `${label}: prompt body identical to the no-persona compiled body`);
  assert.notDeepEqual(body, baselineBody, `${label}: guard is not vacuous — the character context DID compile`);
  assert.equal(
    JSON.stringify(body.parts),
    JSON.stringify(baselineBody.parts),
    `${label}: parts stay byte-identical`,
  );
  assert.ok(
    body.system.includes(PERSONA_BOOK_SENTINEL),
    `${label}: the working pinned book still compiles into the envelope`,
  );
  assert.equal(
    body.system.includes("PERSONA-SENTINEL-4471"),
    false,
    `${label}: persona text never enters the prompt`,
  );
  assertTraceMetadataOnly(payload.trace.characterContext, label, COMPILED_TRACE_KEYS);
}

async function dispatchPersonaMode({ name, sessionId, repository, expectedPersonaPin }) {
  activePolicy = enabledPolicy;
  ctx.characterWorldsRepository = repository;
  const policyCallsBeforeTurn = characterPolicyCalls;
  const remoteReadsBeforeTurn = remoteConfigReads;
  const payload = await dispatchTurn(sessionId, name);
  assert.equal(
    characterPolicyCalls - policyCallsBeforeTurn,
    1,
    `${name}: policy resolved exactly once for the ready snapshot`,
  );
  assert.equal(
    remoteConfigReads - remoteReadsBeforeTurn,
    nativeRemoteReadDelta,
    `${name}: failure turn adds zero remote-config reads beyond native`,
  );
  const state = ctx.turnOrchestrator._state(sessionId);
  const admitted = store.getTurnInputByTurnId(state.turnId);
  assert.equal(
    admitted.metadata.characterWorlds?.mode,
    "character",
    `${name}: admission pinned a ready character snapshot (persona failure engages downstream)`,
  );
  assert.equal(
    admitted.metadata.characterWorlds?.personaRevisionId ?? null,
    expectedPersonaPin,
    `${name}: the admitted snapshot carries the exact persona pin`,
  );
  const body = await promptBodyFor(payload);
  return { payload, body };
}

// no-persona baseline: the same character + working pinned book, no persona
// pin. A persona read without a pin would be a wiring bug — it must never run.
{
  const { payload, body } = await dispatchPersonaMode({
    name: "persona_book_baseline",
    sessionId: SESSION_IDS.persona_book_baseline,
    repository: personaSectionRepository(() => {
      throw new Error("persona must never be read without a snapshot pin");
    }),
    expectedPersonaPin: null,
  });
  assert.equal(payload.characterContext?.status, "compiled", "persona baseline: context compiled");
  assert.equal(payload.characterContext.persona ?? null, null, "persona baseline: no persona record");
  assert.ok(body.system.includes(PERSONA_BOOK_SENTINEL), "persona baseline: the book compiled");
  personaBaselinePayload = payload;
  personaBaselineBody = body;
}

// missing: the pinned persona revision does not resolve (dangling pin fixture
// inserted above); the read was actually attempted (not vacuous).
{
  let personaReads = 0;
  const { payload, body } = await dispatchPersonaMode({
    name: "persona_missing",
    sessionId: SESSION_IDS.persona_missing,
    repository: personaSectionRepository(() => {
      personaReads += 1;
      return null;
    }),
    expectedPersonaPin: "persona-revision-gone",
  });
  assert.equal(personaReads, 1, "persona_missing: the pinned persona was actually read (not vacuous)");
  assert.ok(
    (payload.characterContext.warnings || []).some((warning) => warning.code === "PERSONA_REVISION_MISSING"),
    "persona_missing: metadata-only warning recorded",
  );
  assertCompiledWithoutPersona(payload, body, "persona_missing");
}

// corrupt: the pinned persona revision's stored payload no longer parses —
// driven through the REAL repository against the REAL corrupt row inserted
// above (mirrors the world_book_corrupt discipline).
{
  const { payload, body } = await dispatchPersonaMode({
    name: "persona_corrupt",
    sessionId: SESSION_IDS.persona_corrupt,
    repository: personaSectionRepository(
      (owner, revisionId) => repository.getPersonaRevision(owner, revisionId),
    ),
    expectedPersonaPin: corruptPersonaRevisionId,
  });
  assert.ok(
    (payload.characterContext.warnings || []).some((warning) => warning.code === "PERSONA_REVISION_MISSING"),
    "persona_corrupt: metadata-only warning recorded",
  );
  assertCompiledWithoutPersona(payload, body, "persona_corrupt");
}

// over_budget: the persona resolves, but its description cannot fit even a
// single paragraph — the persona block is omitted with a budget reason while
// the character+book content keeps compiling (§10.3 greedy packing, §16).
{
  const { payload, body } = await dispatchPersonaMode({
    name: "persona_over_budget",
    sessionId: SESSION_IDS.persona_over_budget,
    repository: personaSectionRepository(() => ({
      ...persona.revision,
      canonical: {
        ...persona.revision.canonical,
        description: "x".repeat(200_000),
      },
    })),
    expectedPersonaPin: persona.revision.id,
  });
  assert.ok(
    (payload.characterContext.omitted || []).some(
      (entry) => entry.source === "persona_field" && entry.id === "personaDescription" && entry.reason === "budget",
    ),
    "persona_over_budget: the oversized persona is omitted with a budget reason",
  );
  assertCompiledWithoutPersona(payload, body, "persona_over_budget");
}

// persona positive control: a working pinned persona DOES change the compiled
// body — the failure-mode assertions above are not vacuous.
{
  const { payload, body } = await dispatchPersonaMode({
    name: "persona_control",
    sessionId: SESSION_IDS.persona_control,
    repository: personaSectionRepository(
      (owner, revisionId) => repository.getPersonaRevision(owner, revisionId),
    ),
    expectedPersonaPin: persona.revision.id,
  });
  assert.equal(payload.characterContext?.status, "compiled", "persona_control: context compiled");
  assert.equal(
    payload.characterContext.persona?.revisionId,
    persona.revision.id,
    "persona_control: the compiled contract names the pinned persona revision",
  );
  assert.notDeepEqual(body, personaBaselineBody, "persona_control: a working persona DOES change the compiled body");
  assert.ok(
    body.system.startsWith(baselineBody.system),
    "persona_control: the Lily protected prefix stays byte-stable at the head of system",
  );
  assert.ok(
    body.system.includes("PERSONA-SENTINEL-4471"),
    "persona_control: persona narrative lands inside the lower-authority suffix",
  );
  assert.ok(
    body.system.includes(PERSONA_BOOK_SENTINEL),
    "persona_control: the pinned book compiles alongside the persona",
  );
  assert.equal(
    JSON.stringify(body.parts),
    JSON.stringify(baselineBody.parts),
    "persona_control: parts stay byte-identical even with a persona",
  );
  assertTraceMetadataOnly(payload.trace.characterContext, "persona_control", COMPILED_TRACE_KEYS);
  assert.equal(
    JSON.stringify(payload.trace.characterContext).includes("PERSONA-SENTINEL-4471"),
    false,
    "persona_control: persona text never enters the trace",
  );
}

// --- authoring isolation (Phase 2B, P2B-6; §8): editing a character, a ------
// --- persona, or a world book through the REAL CharacterAuthoringService ----
// --- creates new immutable revisions and must never alter an already- --------
// --- admitted turn: the durable snapshot bytes stay unchanged, the binding ---
// --- stays pinned, a later turn recompiles the byte-identical prompt body, ---
// --- and the edited revision text never leaks into the pinned turn. ---------
const {
  CharacterAuthoringService,
} = require("../src/main/character-worlds/authoring-service.js");
const AUTHORING_BOOK_SENTINEL = "WB-AUTHORING-SENTINEL-7741";
const AUTHORING_REWRITE_SENTINEL = "REWRITTEN-AUTHORING-9901";
{
  const authoring = new CharacterAuthoringService({
    repository,
    resolveOwnerScope: async () => OWNER,
  });
  const pinnedBook = repository.createWorldBook({
    ownerScope: OWNER,
    canonical: {
      schemaVersion: 1,
      name: "PinnedAtlas",
      entries: [{
        id: "e-pinned",
        content: `The pinned lore ${AUTHORING_BOOK_SENTINEL} survives every edit.`,
        activation: { constant: true },
        insertion: { position: "before_character" },
      }],
    },
    source: sourceOf("pinned-atlas"),
  });
  const mira = repository.createCharacter({
    ownerScope: OWNER,
    canonical: {
      schemaVersion: 1,
      name: "Mira",
      description: "A tide-locked navigator.",
      personality: "calm",
      scenario: "The flooded archive.",
    },
    source: sourceOf("mira"),
    characterBookRevisionId: pinnedBook.revision.id,
  });
  repository.setBinding({
    sessionId: SESSION_IDS.authoring_isolation,
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: {
      mode: "character",
      characterRevisionId: mira.revision.id,
      personaRevisionId: persona.revision.id,
      compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE,
    },
  });

  // T1: admitted against the REAL repository with the character+book+persona
  // pin; the compiled body is the pre-edit baseline for this proof.
  activePolicy = enabledPolicy;
  ctx.characterWorldsRepository = null; // real repository
  const beforePayload = await dispatchTurn(SESSION_IDS.authoring_isolation, "authoring isolation (before edit)");
  assert.equal(beforePayload.characterContext?.status, "compiled", "authoring isolation: context compiled");
  const beforeBody = await promptBodyFor(beforePayload);
  assert.ok(beforeBody.system.includes(AUTHORING_BOOK_SENTINEL), "authoring isolation: the pinned book compiled");
  assert.ok(beforeBody.system.includes("PERSONA-SENTINEL-4471"), "authoring isolation: the pinned persona compiled");
  const beforeTurnId = ctx.turnOrchestrator._state(SESSION_IDS.authoring_isolation).turnId;
  const beforeAdmission = store.getTurnInputByTurnId(beforeTurnId);
  const beforeSnapshotJson = JSON.stringify(beforeAdmission.metadata.characterWorlds);
  assert.equal(
    beforeAdmission.metadata.characterWorlds?.personaRevisionId,
    persona.revision.id,
    "authoring isolation: the admitted snapshot carries the persona pin",
  );

  // Edits through the validated authoring API: each creates a NEW immutable
  // revision and moves the entity pointer; bindings and snapshots never move.
  const characterEdit = await authoring.editCharacter({
    ownerScope: OWNER,
    entityId: mira.entity.id,
    expectedBaseRevisionId: mira.revision.id,
    canonical: { name: "Mira", description: `A ${AUTHORING_REWRITE_SENTINEL} navigator.` },
  });
  assert.equal(characterEdit.ok, true, "authoring isolation: character edit committed");
  assert.notEqual(characterEdit.revision.id, mira.revision.id, "authoring isolation: edit created a new revision");
  const personaEdit = await authoring.editPersona({
    ownerScope: OWNER,
    entityId: persona.entity.id,
    expectedBaseRevisionId: persona.revision.id,
    canonical: { schemaVersion: 1, name: "Qin", description: `A ${AUTHORING_REWRITE_SENTINEL} persona.` },
  });
  assert.equal(personaEdit.ok, true, "authoring isolation: persona edit committed");
  const bookEdit = await authoring.editWorldBook({
    ownerScope: OWNER,
    entityId: pinnedBook.entity.id,
    expectedBaseRevisionId: pinnedBook.revision.id,
    canonical: {
      schemaVersion: 1,
      name: "PinnedAtlas",
      entries: [{
        id: "e-pinned",
        content: `The ${AUTHORING_REWRITE_SENTINEL} lore must never leak into pinned turns.`,
        activation: { constant: true },
      }],
    },
  });
  assert.equal(bookEdit.ok, true, "authoring isolation: book edit committed");
  assert.equal(
    repository.getCharacter(OWNER, mira.entity.id).currentRevisionId,
    characterEdit.revision.id,
    "authoring isolation: the character entity moved to the new revision",
  );
  assert.equal(
    repository.getPersona(OWNER, persona.entity.id).currentRevisionId,
    personaEdit.revision.id,
    "authoring isolation: the persona entity moved to the new revision",
  );
  assert.equal(
    repository.getWorldBook(OWNER, pinnedBook.entity.id).currentRevisionId,
    bookEdit.revision.id,
    "authoring isolation: the book entity moved to the new revision",
  );

  // The already-admitted turn is untouched: durable snapshot bytes identical,
  // binding pins unchanged, and a duplicate admission replays the same turn.
  const afterAdmission = store.getTurnInputByTurnId(beforeTurnId);
  assert.equal(
    JSON.stringify(afterAdmission.metadata.characterWorlds),
    beforeSnapshotJson,
    "authoring isolation: the admitted snapshot bytes are unchanged after the edits",
  );
  const bindingAfter = repository.getBinding(SESSION_IDS.authoring_isolation, OWNER);
  assert.equal(bindingAfter.characterRevisionId, mira.revision.id, "authoring isolation: binding still pins V1 character");
  assert.equal(bindingAfter.personaRevisionId, persona.revision.id, "authoring isolation: binding still pins V1 persona");
  const duplicate = manager.admitTurnInput(SESSION_IDS.authoring_isolation, {
    turnId: beforeTurnId,
    userText: USER_TEXT,
    metadata: {},
  });
  assert.equal(
    JSON.stringify(duplicate.metadata.characterWorlds),
    beforeSnapshotJson,
    "authoring isolation: a duplicate admission replays the pinned snapshot after the edits",
  );

  // The pinned persona revision still resolves to the PRE-EDIT content
  // (immutable revisions) and the pinned turn recompiles the byte-identical
  // body through the same shell the orchestrator uses.
  const pinnedPersona = repository.getPersonaRevision(OWNER, persona.revision.id);
  assert.equal(
    pinnedPersona.canonical.description.includes(AUTHORING_REWRITE_SENTINEL),
    false,
    "authoring isolation: the pinned persona revision keeps its pre-edit bytes",
  );
  const {
    compileTurnWorldCharacterContext,
  } = require("../src/main/character-worlds/turn-world-book.js");
  const recompiled = compileTurnWorldCharacterContext({
    repository,
    store,
    ownerScope: OWNER,
    sessionId: SESSION_IDS.authoring_isolation,
    turnId: beforeTurnId,
    snapshot: afterAdmission.metadata.characterWorlds,
    revision: repository.getRevision(OWNER, mira.revision.id),
    baseInput: {
      userText: beforePayload.text,
      taskContract: beforePayload.taskContract || null,
      model: freshSpawnOptions().model,
    },
  });
  assert.equal(
    recompiled.compiled?.text,
    beforePayload.characterContext.text,
    "authoring isolation: the admitted turn recompiles the byte-identical context after the edits",
  );

  // T2: a fresh session bound AFTER the edits to the same (still-existing,
  // immutable) V1 pins re-admits the same snapshot shape and compiles the
  // byte-identical prompt body; the edited revision text never leaks into the
  // pinned conversation. (A second dispatch on the SAME session would queue
  // behind T1's still-open turn, so the proof uses a parallel binding —
  // setBinding pins immutable revisions, never the entity's current pointer.)
  repository.setBinding({
    sessionId: SESSION_IDS.authoring_isolation_after,
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: {
      mode: "character",
      characterRevisionId: mira.revision.id,
      personaRevisionId: persona.revision.id,
      compatibilityProfile: CHARACTER_COMPATIBILITY_PROFILE,
    },
  });
  const afterPayload = await dispatchTurn(SESSION_IDS.authoring_isolation_after, "authoring isolation (after edit)");
  assert.equal(afterPayload.characterContext?.status, "compiled", "authoring isolation: T2 compiled");
  const afterBody = await promptBodyFor(afterPayload);
  assert.deepEqual(
    afterBody,
    beforeBody,
    "authoring isolation: prompt body byte-identical before and after the edits",
  );
  assert.equal(
    afterPayload.characterContext.fingerprint,
    beforePayload.characterContext.fingerprint,
    "authoring isolation: compiled fingerprint unchanged by the edits",
  );
  assert.equal(
    afterBody.system.includes(AUTHORING_REWRITE_SENTINEL),
    false,
    "authoring isolation: edited character/persona/book text never leaks into the pinned turn",
  );
  assertTraceMetadataOnly(afterPayload.trace.characterContext, "authoring isolation", COMPILED_TRACE_KEYS);
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
console.log(`character-worlds-capability-gate: ok (${failures.length + 8} failure modes + authoring isolation, byte-equal native baseline / byte-equal no-book / no-persona compiled body)`);
