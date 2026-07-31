#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-character-binding-isolation-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_ENABLE_STEER = "1";
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const { MessageStore } = require("../src/main/store/message-store.js");
const SessionManager = require("../src/main/session-manager.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  CHARACTER_COMPATIBILITY_PROFILE,
  MAX_CHARACTER_BINDING_BYTES,
} = require("../src/main/character-worlds/constants.js");
const {
  createTurnRecoveryRuntime,
} = require("../src/main/turn-recovery-runtime.js");
const {
  normalizeSnapshot,
} = require("../src/main/character-worlds/turn-binding-snapshot.js");
const {
  createQueueRecoveryEnvelope,
} = require("../src/main/turn-queue-recovery-envelope.js");
const {
  resolveCharacterOwnerScope,
  scopeHash,
} = require("../src/main/character-worlds/owner-scope.js");

const OWNER_A = "profile:binding-owner-a";
const OWNER_B = "profile:binding-owner-b";
const SESSION_A = "binding-session-a";
const SESSION_B = "binding-session-b";
const SESSION_FOREIGN = "binding-session-foreign";
const SESSION_MISSING = "binding-session-missing";
const SESSION_CORRUPT = "binding-session-corrupt";
const SESSION_NATIVE = "binding-session-native";
const SESSION_INTERLEAVE = "binding-session-interleave";

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function source(name) {
  return {
    kind: "created",
    format: "lily",
    container: "json",
    originalFileName: `${name}.json`,
  };
}

function bindingEnvelope({
  bindingVersion,
  mode = "character",
  characterRevisionId = null,
  compatibilityProfile = CHARACTER_COMPATIBILITY_PROFILE,
}) {
  return JSON.stringify({
    schemaVersion: 1,
    bindingVersion,
    compatibilityProfileVersion: 1,
    compatibilityProfile,
    mode,
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

function expectedReady(bindingVersion, revisionId, compatibilityProfile = CHARACTER_COMPATIBILITY_PROFILE) {
  return {
    schemaVersion: 1,
    mode: "character",
    bindingVersion,
    characterRevisionId: revisionId,
    personaRevisionId: null,
    compatibilityProfile,
    snapshotStatus: "ready",
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function assertFallback(snapshot, message) {
  assert.equal(snapshot?.schemaVersion, 1, message);
  assert.equal(snapshot?.mode, "native", message);
  assert.equal(snapshot?.snapshotStatus, "fallback", message);
  assert.equal(snapshot?.characterRevisionId, null, message);
  assert.equal(snapshot?.personaRevisionId, null, message);
  assert.equal(snapshot?.compatibilityProfile, null, message);
  assert.equal(snapshot?.bindingVersion, 0, message);
}

function fakeProjectManager() {
  return {
    projects: [{ id: "project-binding", path: tmp }],
    activeProjectId: "project-binding",
    getActive() {
      return this.projects[0];
    },
    find(id) {
      return this.projects.find((project) => project.id === id) || null;
    },
  };
}

function makeSession(id, ownerScope) {
  return {
    id,
    projectId: "project-binding",
    title: id,
    ownerScopeForTest: ownerScope,
    messages: [],
    messageCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    status: "idle",
  };
}

function makeOrchestrator(sessionManager, sessions, overrides = {}) {
  const runners = new Map();
  const committedUserMessages = [];
  const emittedEvents = [];
  for (const session of sessions) {
    runners.set(session.id, {
      busy: true,
      isBusy() {
        return this.busy;
      },
      isAlive() {
        return true;
      },
      async steer() {
        return true;
      },
      interrupt() {
        this.busy = false;
      },
      sentPayloads: [],
      sendUserMessage(payload) {
        this.busy = true;
        this.sentPayloads.push(payload);
        return true;
      },
    });
  }
  const eventBus = {
    emit(sessionId, event) {
      emittedEvents.push({ sessionId, event });
      return [];
    },
    snapshot() {
      return {};
    },
  };
  const ctx = {
    eventBus,
    sessionManager,
    projectManager: fakeProjectManager(),
    runnerPool: {
      get: (sessionId) => runners.get(sessionId) || null,
    },
    transcriptStore: {
      commitUserMessage(sessionId, message) {
        committedUserMessages.push({ sessionId, message });
      },
      removeLastAssistantMessage() {},
    },
    turnArchive: {},
    scheduledTaskManager: {
      canStartRun: () => true,
    },
    ...overrides,
  };
  const orchestrator = new TurnOrchestrator(ctx);
  ctx.turnOrchestrator = orchestrator;
  return { committedUserMessages, ctx, emittedEvents, orchestrator, runners };
}

const dbPath = path.join(tmp, "messages.db");
const blobDir = path.join(tmp, "blobs");
let store = new MessageStore(dbPath, blobDir);
const repository = new CharacterWorldsRepository(store);
const firstCharacter = repository.createCharacter({
  ownerScope: OWNER_A,
  canonical: { schemaVersion: 1, name: "First" },
  source: source("first"),
});
const secondCharacter = repository.createCharacter({
  ownerScope: OWNER_A,
  canonical: { schemaVersion: 1, name: "Second" },
  source: source("second"),
});
const otherOwnerCharacter = repository.createCharacter({
  ownerScope: OWNER_B,
  canonical: { schemaVersion: 1, name: "Other owner" },
  source: source("other-owner"),
});

repository.setBinding({
  sessionId: SESSION_A,
  ownerScope: OWNER_A,
  expectedBindingVersion: 0,
  next: {
    mode: "character",
    characterRevisionId: firstCharacter.revision.id,
    compatibilityProfile: "profile-first",
  },
});
repository.setBinding({
  sessionId: SESSION_B,
  ownerScope: OWNER_B,
  expectedBindingVersion: 0,
  next: {
    mode: "character",
    characterRevisionId: otherOwnerCharacter.revision.id,
    compatibilityProfile: "profile-owner-b",
  },
});
repository.setBinding({
  sessionId: SESSION_FOREIGN,
  ownerScope: OWNER_B,
  expectedBindingVersion: 0,
  next: {
    mode: "character",
    characterRevisionId: otherOwnerCharacter.revision.id,
  },
});
repository.setBinding({
  sessionId: SESSION_INTERLEAVE,
  ownerScope: OWNER_A,
  expectedBindingVersion: 0,
  next: {
    mode: "character",
    characterRevisionId: firstCharacter.revision.id,
    compatibilityProfile: "profile-before-interleave",
  },
});

store.db.exec("PRAGMA foreign_keys = OFF");
store.db.run(
  `INSERT INTO character_session_bindings
     (session_id, owner_scope, binding_version, mode, character_revision_id,
      compatibility_profile, binding_json, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  SESSION_MISSING,
  OWNER_A,
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
store.db.run(
  `INSERT INTO character_session_bindings
     (session_id, owner_scope, binding_version, mode, character_revision_id,
      compatibility_profile, binding_json, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  SESSION_CORRUPT,
  OWNER_A,
  5,
  "character",
  firstCharacter.revision.id,
  CHARACTER_COMPATIBILITY_PROFILE,
  "{malformed",
  Date.now(),
);
store.db.exec("PRAGMA foreign_keys = ON");

const sessions = [
  makeSession(SESSION_A, OWNER_A),
  makeSession(SESSION_B, OWNER_B),
  makeSession(SESSION_FOREIGN, OWNER_A),
  makeSession(SESSION_MISSING, OWNER_A),
  makeSession(SESSION_CORRUPT, OWNER_A),
  makeSession(SESSION_NATIVE, OWNER_A),
  makeSession(SESSION_INTERLEAVE, OWNER_A),
];
const manager = new SessionManager(fakeProjectManager(), {
  resolveCharacterOwnerScope: (session) => session.ownerScopeForTest,
});
manager.sessions = { "project-binding": sessions };
manager.activeSessionId = SESSION_A;
manager._messageStore = store;
manager._ensureImported = () => {};

await check("owner resolution fails closed except for explicit unauthenticated device scope", () => {
  assert.equal(
    resolveCharacterOwnerScope({
      accountStatus() {
        throw new Error("account provider unavailable");
      },
      getDeviceId: () => "device-should-not-be-used",
    }),
    null,
  );
  assert.equal(
    resolveCharacterOwnerScope({
      accountStatus: () => ({ ok: true, loggedIn: true, user: null }),
      getDeviceId: () => "device-should-not-be-used",
    }),
    null,
  );
  assert.equal(
    resolveCharacterOwnerScope({
      accountStatus: () => ({ ok: true, loggedIn: false, user: null }),
      getDeviceId: () => "explicit-anonymous-device",
    }),
    scopeHash("device", "explicit-anonymous-device"),
  );
});

let firstAdmission;
await check("send/switch/send snapshots exact immutable binding versions", () => {
  const importedMetadata = {
    source: "renderer",
    characterWorlds: {
      bindingVersion: 999,
      characterRevisionId: otherOwnerCharacter.revision.id,
      snapshotStatus: "ready",
    },
  };
  firstAdmission = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-before-switch",
    userText: "before switch",
    metadata: importedMetadata,
  });
  assert.deepEqual(
    firstAdmission.metadata.characterWorlds,
    expectedReady(1, firstCharacter.revision.id, "profile-first"),
  );

  repository.setBinding({
    sessionId: SESSION_A,
    ownerScope: OWNER_A,
    expectedBindingVersion: 1,
    next: {
      mode: "character",
      characterRevisionId: secondCharacter.revision.id,
      compatibilityProfile: "profile-second",
    },
  });
  const secondAdmission = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-after-switch",
    userText: "after switch",
    metadata: {},
  });
  assert.deepEqual(
    secondAdmission.metadata.characterWorlds,
    expectedReady(2, secondCharacter.revision.id, "profile-second"),
  );
  assert.deepEqual(
    firstAdmission.metadata.characterWorlds,
    expectedReady(1, firstCharacter.revision.id, "profile-first"),
    "the first admitted turn must not change after a binding switch",
  );
});

await check("only an internal source turn id can inherit a persisted snapshot", () => {
  const forgedRaw = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-forged-raw-snapshot",
    userText: "forged raw snapshot",
    metadata: {},
  }, {
    characterWorldsSnapshot: expectedReady(
      999,
      firstCharacter.revision.id,
      "forged-profile",
    ),
  });
  assert.deepEqual(
    forgedRaw.metadata.characterWorlds,
    expectedReady(2, secondCharacter.revision.id, "profile-second"),
    "the public admission API must ignore a caller-provided raw snapshot",
  );

  assert.equal(typeof manager.admitTurnInputFromSource, "function");
  const inherited = manager.admitTurnInputFromSource(SESSION_A, {
    turnId: "turn-inherit-valid-source",
    userText: "inherit valid source",
    metadata: {},
  }, firstAdmission.turnId);
  assert.deepEqual(
    inherited.metadata.characterWorlds,
    expectedReady(1, firstCharacter.revision.id, "profile-first"),
  );

  const otherSessionSource = manager.admitTurnInput(SESSION_B, {
    turnId: "turn-other-session-source",
    userText: "other session source",
    metadata: {},
  });
  const crossSession = manager.admitTurnInputFromSource(SESSION_A, {
    turnId: "turn-inherit-cross-session",
    userText: "cross session",
    metadata: {},
  }, otherSessionSource.turnId);
  assertFallback(crossSession.metadata.characterWorlds, "cross-session source fallback");

  const foreignOwnerSource = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-foreign-owner-source",
    userText: "foreign owner source",
    metadata: {},
  });
  store.db.run(
    "UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?",
    JSON.stringify({
      characterWorlds: expectedReady(
        1,
        otherOwnerCharacter.revision.id,
        "profile-owner-b",
      ),
    }),
    foreignOwnerSource.turnId,
  );
  const crossOwner = manager.admitTurnInputFromSource(SESSION_A, {
    turnId: "turn-inherit-cross-owner",
    userText: "cross owner",
    metadata: {},
  }, foreignOwnerSource.turnId);
  assertFallback(crossOwner.metadata.characterWorlds, "cross-owner source fallback");
  assert.equal(
    JSON.stringify(crossOwner).includes(otherOwnerCharacter.revision.id),
    false,
  );

  const missing = manager.admitTurnInputFromSource(SESSION_A, {
    turnId: "turn-inherit-missing-source",
    userText: "missing source",
    metadata: {},
  }, "missing-source-turn");
  assertFallback(missing.metadata.characterWorlds, "missing source fallback");

  const invalidStatusSource = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-invalid-status-source",
    userText: "invalid status source",
    metadata: {},
  });
  store.db.run(
    "UPDATE turn_inputs SET status = ? WHERE turn_id = ?",
    "untrusted-status",
    invalidStatusSource.turnId,
  );
  const invalidStatus = manager.admitTurnInputFromSource(SESSION_A, {
    turnId: "turn-inherit-invalid-status",
    userText: "invalid status",
    metadata: {},
  }, invalidStatusSource.turnId);
  assertFallback(invalidStatus.metadata.characterWorlds, "invalid source status fallback");
});

await check("native admission stays byte-equivalent and allocates no Character Worlds metadata", () => {
  const metadata = { source: "legacy", nested: { enabled: true } };
  const admitted = manager.admitTurnInput(SESSION_NATIVE, {
    turnId: "turn-native",
    userText: "native",
    metadata,
  });
  assert.deepEqual(admitted.metadata, metadata);
  assert.equal(Object.hasOwn(admitted.metadata, "characterWorlds"), false);
  assert.equal(Object.isFrozen(admitted.metadata), true);
  assert.equal(Object.isFrozen(admitted.metadata.nested), true);
  assert.throws(() => {
    admitted.metadata.nested.enabled = false;
  }, TypeError);
  const row = store.db.get(
    "SELECT metadata_json FROM turn_inputs WHERE turn_id = ?",
    "turn-native",
  );
  assert.equal(row.metadata_json, JSON.stringify(metadata));
});

await check("owner scope is host-derived and foreign bindings fail open without leaking IDs", () => {
  const admitted = manager.admitTurnInput(SESSION_FOREIGN, {
    turnId: "turn-foreign-owner",
    userText: "foreign",
    ownerScope: OWNER_B,
    metadata: {
      ownerScope: OWNER_B,
      characterWorlds: {
        characterRevisionId: otherOwnerCharacter.revision.id,
        compatibilityProfile: "renderer-forged",
      },
    },
  });
  assertFallback(admitted.metadata.characterWorlds, "foreign binding must fail open");
  const serialized = JSON.stringify(admitted);
  assert.equal(serialized.includes(OWNER_B), false);
  assert.equal(serialized.includes(otherOwnerCharacter.revision.id), false);
  assert.equal(serialized.includes("renderer-forged"), false);
});

await check("missing and corrupt revisions fail open without dropping the user turn", () => {
  const missing = manager.admitTurnInput(SESSION_MISSING, {
    turnId: "turn-missing-revision",
    userText: "still admitted",
    metadata: {},
  });
  const corrupt = manager.admitTurnInput(SESSION_CORRUPT, {
    turnId: "turn-corrupt-binding",
    userText: "still admitted too",
    metadata: {},
  });
  assertFallback(missing.metadata.characterWorlds, "missing revision fallback");
  assertFallback(corrupt.metadata.characterWorlds, "corrupt binding fallback");
  assert.equal(missing.userText, "still admitted");
  assert.equal(corrupt.userText, "still admitted too");
  assert.equal(JSON.stringify(missing).includes("foreign-revision-secret-id"), false);
  assert.equal(JSON.stringify(missing).includes("profile-missing-secret"), false);
});

await check("invalid file metadata fails open without dropping the admitted turn", () => {
  const cyclicFiles = [];
  cyclicFiles.push(cyclicFiles);
  const admitted = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-cyclic-files",
    userText: "keep this message",
    files: cyclicFiles,
    metadata: {},
  });
  assert.equal(admitted.userText, "keep this message");
  assert.deepEqual(admitted.files, []);
});

await check("metadata is bounded, inert, cloned, and cannot overwrite the system snapshot", () => {
  let getterCalls = 0;
  const accessorMetadata = {};
  Object.defineProperty(accessorMetadata, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  accessorMetadata.characterWorlds = { characterRevisionId: "forged" };
  const accessorAdmission = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-accessor-metadata",
    userText: "accessor metadata",
    metadata: accessorMetadata,
  });
  assert.equal(getterCalls, 0);
  assert.deepEqual(
    accessorAdmission.metadata.characterWorlds,
    expectedReady(2, secondCharacter.revision.id, "profile-second"),
  );

  const dangerous = JSON.parse(
    `{"safe":{"value":"before"},"__proto__":{"polluted":true},`
      + `"constructor":{"prototype":{"polluted":true}},`
      + `"characterWorlds":{"characterRevisionId":"forged"},`
      + `"oversized":"${"x".repeat(MAX_CHARACTER_BINDING_BYTES * 2)}"}`,
  );
  const bounded = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-bounded-metadata",
    delivery: "direct",
    userText: "bounded metadata",
    metadata: dangerous,
  });
  dangerous.safe.value = "after";
  dangerous.characterWorlds.characterRevisionId = "mutated";
  assert.equal(Object.isFrozen(bounded), true);
  assert.equal(Object.isFrozen(bounded.metadata), true);
  assert.equal(Object.isFrozen(bounded.metadata.characterWorlds), true);
  const dispatchClaim = store.claimTurnInputDispatch(
    SESSION_A,
    "turn-bounded-metadata",
    {
      attemptId: "dispatch-bounded-metadata",
      ownerScope: OWNER_A,
    },
  );
  assert.equal(dispatchClaim.ok, true);
  const promoted = store.markTurnInputPromoted("turn-bounded-metadata", {
    dispatchAttemptId: dispatchClaim.attemptId,
    metadata: {
      characterWorlds: {
        bindingVersion: 999,
        characterRevisionId: "forged-on-promotion",
      },
      promotedSafely: true,
    },
  });
  const persisted = store.getTurnInputByTurnId("turn-bounded-metadata");
  assert.equal(promoted.metadata.promotedSafely, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(persisted.metadata), "utf8") <= MAX_CHARACTER_BINDING_BYTES,
  );
  assert.equal(JSON.stringify(persisted.metadata).includes("__proto__"), false);
  assert.equal(JSON.stringify(persisted.metadata).includes("constructor"), false);
  assert.deepEqual(
    persisted.metadata.characterWorlds,
    expectedReady(2, secondCharacter.revision.id, "profile-second"),
  );
  assert.equal(JSON.stringify(persisted).includes("forged-on-promotion"), false);
  assert.notEqual(persisted.metadata?.safe?.value, "after");
  assert.equal({}.polluted, undefined);
});

await check("persisted metadata is bounded before parse, structurally revalidated, and deep frozen", () => {
  const admitted = manager.admitTurnInput(SESSION_NATIVE, {
    turnId: "turn-hostile-persisted-metadata",
    userText: "hostile persisted metadata",
    metadata: { nested: { values: [{ safe: true }] } },
  });
  assert.equal(Object.isFrozen(admitted.metadata.nested), true);
  assert.equal(Object.isFrozen(admitted.metadata.nested.values), true);
  assert.equal(Object.isFrozen(admitted.metadata.nested.values[0]), true);

  const oversizedJson = JSON.stringify({
    oversized: "x".repeat(MAX_CHARACTER_BINDING_BYTES + 1),
  });
  store.db.run(
    "UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?",
    oversizedJson,
    admitted.turnId,
  );
  const originalParse = JSON.parse;
  let oversizedParseCalls = 0;
  JSON.parse = (text, ...args) => {
    if (text === oversizedJson) oversizedParseCalls += 1;
    return originalParse(text, ...args);
  };
  try {
    const oversized = store.getTurnInputByTurnId(admitted.turnId);
    assert.deepEqual(oversized.metadata, {});
    assert.equal(Object.isFrozen(oversized.metadata), true);
    assert.equal(oversizedParseCalls, 0);
  } finally {
    JSON.parse = originalParse;
  }

  const dangerousJson = JSON.stringify({
    safe: true,
    constructor: { prototype: { polluted: true } },
  });
  store.db.run(
    "UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?",
    dangerousJson,
    admitted.turnId,
  );
  assert.deepEqual(store.getTurnInputByTurnId(admitted.turnId).metadata, {});

  const tooDeep = {};
  let cursor = tooDeep;
  for (let index = 0; index < 20; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  store.db.run(
    "UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?",
    JSON.stringify(tooDeep),
    admitted.turnId,
  );
  assert.deepEqual(store.getTurnInputByTurnId(admitted.turnId).metadata, {});

  const corruptSource = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-oversized-source-metadata",
    userText: "oversized source",
    metadata: {},
  });
  store.db.run(
    "UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?",
    oversizedJson,
    corruptSource.turnId,
  );
  const inherited = manager.admitTurnInputFromSource(SESSION_A, {
    turnId: "turn-inherit-oversized-source",
    userText: "inherit oversized source",
    metadata: {},
  }, corruptSource.turnId);
  assertFallback(inherited.metadata.characterWorlds, "oversized source fallback");
});

await check("snapshot normalization rejects hostile objects without triggering traps", () => {
  let proxyTraps = 0;
  const hostileProxy = new Proxy({}, {
    get() {
      proxyTraps += 1;
      throw new Error("proxy get must not run");
    },
    getOwnPropertyDescriptor() {
      proxyTraps += 1;
      throw new Error("proxy descriptor must not run");
    },
    getPrototypeOf() {
      proxyTraps += 1;
      throw new Error("proxy prototype must not run");
    },
    ownKeys() {
      proxyTraps += 1;
      throw new Error("proxy ownKeys must not run");
    },
  });
  assert.equal(normalizeSnapshot(hostileProxy), null);
  assert.equal(proxyTraps, 0);

  let getterCalls = 0;
  const accessor = {
    mode: "character",
    bindingVersion: 3,
    characterRevisionId: firstCharacter.revision.id,
    compatibilityProfile: "profile-third",
    snapshotStatus: "ready",
  };
  Object.defineProperty(accessor, "schemaVersion", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  assert.equal(normalizeSnapshot(accessor), null);
  assert.equal(getterCalls, 0);

  const symbolSnapshot = expectedReady(
    3,
    firstCharacter.revision.id,
    "profile-third",
  );
  symbolSnapshot[Symbol("hidden")] = true;
  assert.equal(normalizeSnapshot(symbolSnapshot), null);

  const nonPlain = Object.assign(
    Object.create({ inherited: true }),
    expectedReady(3, firstCharacter.revision.id, "profile-third"),
  );
  assert.equal(normalizeSnapshot(nonPlain), null);
  assert.deepEqual(normalizeSnapshot({
    schemaVersion: 1,
    mode: "native",
    bindingVersion: 0,
    characterRevisionId: null,
    compatibilityProfile: null,
    snapshotStatus: "fallback",
  }), {
    schemaVersion: 1,
    mode: "native",
    bindingVersion: 0,
    characterRevisionId: null,
    personaRevisionId: null,
    compatibilityProfile: null,
    snapshotStatus: "fallback",
  });
});

await check("binding switch interleaved after the transactional read yields one complete old snapshot", () => {
  const originalGet = store.db.get.bind(store.db);
  let switched = false;
  store.db.get = (sql, ...params) => {
    if (
      !switched
      && /character_session_bindings/.test(String(sql))
      && params[0] === SESSION_INTERLEAVE
      && params[1] === OWNER_A
    ) {
      const row = originalGet(sql, ...params);
      switched = true;
      repository.setBinding({
        sessionId: SESSION_INTERLEAVE,
        ownerScope: OWNER_A,
        expectedBindingVersion: 1,
        next: {
          mode: "character",
          characterRevisionId: secondCharacter.revision.id,
          compatibilityProfile: "profile-after-interleave",
        },
      });
      return row;
    }
    return originalGet(sql, ...params);
  };
  try {
    const admitted = manager.admitTurnInput(SESSION_INTERLEAVE, {
      turnId: "turn-interleaved-old",
      userText: "linearized before switch",
      metadata: {},
    });
    assert.equal(switched, true);
    assert.deepEqual(
      admitted.metadata.characterWorlds,
      expectedReady(1, firstCharacter.revision.id, "profile-before-interleave"),
    );
  } finally {
    store.db.get = originalGet;
  }
  const after = manager.admitTurnInput(SESSION_INTERLEAVE, {
    turnId: "turn-interleaved-new",
    userText: "linearized after switch",
    metadata: {},
  });
  assert.deepEqual(
    after.metadata.characterWorlds,
    expectedReady(2, secondCharacter.revision.id, "profile-after-interleave"),
  );
});

const {
  committedUserMessages,
  emittedEvents,
  orchestrator,
  runners,
} = makeOrchestrator(manager, sessions);

await check("queued sends snapshot at enqueue and queue promotion never re-reads the binding", async () => {
  const state = orchestrator._state(SESSION_A);
  state.phase = "running";
  state.turnId = "active-turn";
  state.characterWorldsSnapshot = Object.freeze(
    expectedReady(2, secondCharacter.revision.id, "profile-second"),
  );
  const queued = await orchestrator.sendUserMessage(SESSION_A, "queued before switch", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(queued.queued, true);
  const item = state.queue.at(-1);
  assert.ok(item.admittedTurnInput?.turnId);
  assert.equal(Object.isFrozen(item.admittedTurnInput.metadata.queueRecovery), true);
  assert.equal(
    Object.isFrozen(item.admittedTurnInput.metadata.queueRecovery.options),
    true,
  );
  assert.notEqual(
    item.admittedTurnInput.metadata.queueRecovery.options,
    item.options,
    "persisted queue recovery options must be an immutable clone",
  );
  assert.deepEqual(
    item.admittedTurnInput.metadata.characterWorlds,
    expectedReady(2, secondCharacter.revision.id, "profile-second"),
  );

  repository.setBinding({
    sessionId: SESSION_A,
    ownerScope: OWNER_A,
    expectedBindingVersion: 2,
    next: {
      mode: "character",
      characterRevisionId: firstCharacter.revision.id,
      compatibilityProfile: "profile-third",
    },
  });
  runners.get(SESSION_A).busy = false;
  let promotedOptions = null;
  const originalStartTurn = orchestrator._startTurn;
  orchestrator._startTurn = async (_session, _text, _files, options) => {
    promotedOptions = options;
    return { ok: true, turnId: options.admittedTurnInput.turnId };
  };
  try {
    const promoted = await orchestrator._tryStartQueuedItem(SESSION_A, item);
    assert.equal(promoted.ok, true);
  } finally {
    orchestrator._startTurn = originalStartTurn;
  }
  assert.equal(promotedOptions.admittedTurnInput.turnId, item.admittedTurnInput.turnId);
  assert.deepEqual(
    promotedOptions.admittedTurnInput.metadata.characterWorlds,
    expectedReady(2, secondCharacter.revision.id, "profile-second"),
  );
  state.queue = [];
});

await check("promoted turns reuse the frozen snapshot without reusing queue admission time", async () => {
  const session = sessions.find((entry) => entry.id === SESSION_A);
  const admitted = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-old-queue-timestamp",
    userText: "queued long ago",
    metadata: {},
    createdAt: 1,
  });
  const runner = runners.get(SESSION_A);
  const originalFinalize = orchestrator._finalize;
  runners.delete(SESSION_A);
  orchestrator._finalize = () => {};
  const startedAfter = Date.now();
  try {
    const result = await orchestrator._startTurn(session, "queued long ago", [], {
      admittedTurnInput: admitted,
      fromQueue: true,
      skipDocument: true,
      skipPreflight: true,
      skipVision: true,
    });
    assert.equal(result.error, "RUNNER_ERROR");
    const state = orchestrator._state(SESSION_A);
    assert.ok(state.startedAt >= startedAfter);
    assert.equal(state.characterWorldsSnapshot, admitted.metadata.characterWorlds);
  } finally {
    orchestrator._finalize = originalFinalize;
    runners.set(SESSION_A, runner);
    orchestrator._state(SESSION_A).phase = "idle";
  }
});

await check("a pre-echoed local turn keeps its original turn id and snapshot when later queued", async () => {
  const state = orchestrator._state(SESSION_INTERLEAVE);
  state.phase = "idle";
  const echoedTurnId = orchestrator.echoUserMessage(
    SESSION_INTERLEAVE,
    "schedule after slow parse",
    [],
    [],
  );
  const echoed = store.getTurnInputByTurnId(echoedTurnId);
  assert.deepEqual(
    echoed.metadata.characterWorlds,
    expectedReady(2, secondCharacter.revision.id, "profile-after-interleave"),
  );
  repository.setBinding({
    sessionId: SESSION_INTERLEAVE,
    ownerScope: OWNER_A,
    expectedBindingVersion: 2,
    next: {
      mode: "character",
      characterRevisionId: firstCharacter.revision.id,
      compatibilityProfile: "profile-after-echo",
    },
  });
  state.phase = "running";
  state.turnId = "active-while-local-turn-queues";
  const queued = await orchestrator.completeLocalAssistantTurn(
    SESSION_INTERLEAVE,
    "schedule after slow parse",
    [],
    {
      turnId: echoedTurnId,
      recordUser: false,
      assistant: "confirm schedule",
    },
  );
  assert.equal(queued.queued, true);
  const item = state.queue.at(-1);
  assert.equal(item.admittedTurnInput.turnId, echoedTurnId);
  assert.deepEqual(
    item.admittedTurnInput.metadata.characterWorlds,
    expectedReady(2, secondCharacter.revision.id, "profile-after-interleave"),
  );
  state.queue = [];
});

await check("scheduled and external command turns snapshot their exact target session", async () => {
  const scheduledState = orchestrator._state(SESSION_B);
  scheduledState.phase = "running";
  scheduledState.turnId = "active-owner-b";
  const scheduled = await orchestrator.sendUserMessage(SESSION_B, "scheduled owner B", [], {
    scheduledTaskId: "task-owner-b",
    scheduledTaskRunId: "run-owner-b",
    queueOrigin: "scheduled_task",
    queueVisibility: "background",
  });
  assert.equal(scheduled.queued, true);
  const scheduledItem = scheduledState.queue.at(-1);
  assert.deepEqual(
    scheduledItem.admittedTurnInput.metadata.characterWorlds,
    expectedReady(1, otherOwnerCharacter.revision.id, "profile-owner-b"),
  );
  assert.equal(
    JSON.stringify(scheduledItem.admittedTurnInput).includes(secondCharacter.revision.id),
    false,
  );

  const externalState = orchestrator._state(SESSION_A);
  externalState.phase = "running";
  externalState.turnId = "active-owner-a";
  const external = await orchestrator.admitExternalCommand({
    commandId: "command-binding-a",
    idempotencyKey: "idempotency-binding-a",
    payloadHash: "payload-binding-a",
    lilySessionId: SESSION_A,
    desktopDeviceId: "desktop-binding-a",
    mobileDeviceId: "mobile-binding-a",
    text: "mobile queued",
    mode: "queue",
  }, {
    sessionExists: true,
    sessionOwned: true,
  });
  assert.equal(external.ok, true);
  const externalItem = externalState.queue.at(-1);
  assert.deepEqual(
    externalItem.admittedTurnInput.metadata.characterWorlds,
    expectedReady(3, firstCharacter.revision.id, "profile-third"),
  );
  scheduledState.queue = [];
  externalState.queue = [];
});

await check("steering inherits the active turn snapshot and performs no new admission", async () => {
  const state = orchestrator._state(SESSION_A);
  const activeSnapshot = Object.freeze(
    expectedReady(2, secondCharacter.revision.id, "profile-second"),
  );
  state.phase = "running";
  state.turnId = "active-steer-turn";
  state.turnGeneration = (state.turnGeneration || 0) + 1;
  state.admittedTurnInput = {
    turnId: state.turnId,
    ownerScope: OWNER_A,
  };
  state.dispatchAttemptId = "dispatch-active-steer-turn";
  state.characterWorldsSnapshot = activeSnapshot;
  runners.get(SESSION_A).busy = true;
  const before = store.db.get(
    "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
    SESSION_A,
  ).count;
  const result = await orchestrator.sendUserMessage(SESSION_A, "steer now", [], {
    mode: "steer",
  });
  const after = store.db.get(
    "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
    SESSION_A,
  ).count;
  assert.equal(result.steered, true);
  assert.equal(state.characterWorldsSnapshot, activeSnapshot);
  assert.equal(after, before);
});

await check("a delayed accepted steer cannot write into a replacement turn", async () => {
  const state = orchestrator._state(SESSION_A);
  const oldTurnId = "active-steer-race-old";
  const newTurnId = "active-steer-race-new";
  const oldSnapshot = Object.freeze(
    expectedReady(2, secondCharacter.revision.id, "profile-second"),
  );
  const newSnapshot = Object.freeze(
    expectedReady(3, firstCharacter.revision.id, "profile-third"),
  );
  const oldRunner = runners.get(SESSION_A);
  const oldSteer = oldRunner.steer;
  const pending = deferred();
  oldRunner.steer = () => pending.promise;
  state.phase = "running";
  state.turnId = oldTurnId;
  state.turnGeneration = (state.turnGeneration || 0) + 1;
  state.admittedTurnInput = {
    turnId: oldTurnId,
    ownerScope: OWNER_A,
  };
  state.dispatchAttemptId = "dispatch-active-steer-race-old";
  state.terminalEmitted = false;
  state.characterWorldsSnapshot = oldSnapshot;
  committedUserMessages.length = 0;
  emittedEvents.length = 0;

  const steering = orchestrator.sendUserMessage(SESSION_A, "late old steer", [], {
    mode: "steer",
  });
  await Promise.resolve();

  const replacementRunner = {
    busy: true,
    isBusy() {
      return this.busy;
    },
    isAlive() {
      return true;
    },
    async steer() {
      return true;
    },
  };
  runners.set(SESSION_A, replacementRunner);
  state.phase = "running";
  state.turnId = newTurnId;
  state.turnGeneration = (state.turnGeneration || 0) + 1;
  state.admittedTurnInput = {
    turnId: newTurnId,
    ownerScope: OWNER_A,
  };
  state.dispatchAttemptId = "dispatch-active-steer-race-new";
  state.terminalEmitted = false;
  state.characterWorldsSnapshot = newSnapshot;
  state.steerCount = 0;
  pending.resolve(true);

  try {
    const result = await steering;
    assert.equal(result.ok, true);
    assert.equal(result.steered, true);
    assert.equal(result.steerOrphaned, true);
    assert.equal(result.turnId, oldTurnId);
    assert.equal(
      committedUserMessages.some((entry) => entry.message.turnId === newTurnId),
      false,
    );
    assert.equal(
      emittedEvents.some((entry) => (
        entry.event.type === "user.committed" && entry.event.turnId === newTurnId
      )),
      false,
    );
    assert.equal(state.steerCount, 0);
    assert.equal(state.characterWorldsSnapshot, newSnapshot);
  } finally {
    oldRunner.steer = oldSteer;
    runners.set(SESSION_A, oldRunner);
  }
});

await check("retry, model self-heal, and evidence recovery inherit the original persisted snapshot", async () => {
  const sends = [];
  const recovery = createTurnRecoveryRuntime({
    ctx: {
      sessionManager: {
        findById: () => sessions[0],
        getLastUserMessage: () => ({
          content: "retry original",
          files: [],
          turnId: firstAdmission.turnId,
        }),
        getTurnInputByTurnId: (_sessionId, turnId) => store.getTurnInputByTurnId(turnId),
      },
      runnerPool: { get: () => null },
    },
    transcriptStore: {
      removeLastAssistantMessage() {},
    },
    getState: () => ({
      turnId: null,
      queue: [],
      tools: new Map(),
    }),
    sendUserMessage: async (...args) => {
      sends.push(args);
      return { ok: true };
    },
  });
  const result = await recovery.retryLastMessage(SESSION_A);
  assert.equal(result.ok, true);
  assert.equal(sends[0][3].sourceTurnId, firstAdmission.turnId);
  assert.equal(Object.hasOwn(sends[0][3], "characterWorldsSnapshot"), false);
});

await check("admitted snapshots survive serialization and restart without mutation", () => {
  const queuedBeforeRestart = manager.admitTurnInput(SESSION_A, {
    turnId: "turn-restart-recovery",
    userText: "restart me",
    metadata: {},
  });
  const before = JSON.stringify(queuedBeforeRestart.metadata.characterWorlds);
  store.close();
  manager._messageStore = null;
  store = new MessageStore(dbPath, blobDir);
  const recovered = store.getTurnInputByTurnId("turn-restart-recovery");
  assert.equal(JSON.stringify(recovered.metadata.characterWorlds), before);
  assert.equal(Object.isFrozen(recovered.metadata.characterWorlds), true);
  assert.throws(() => {
    recovered.metadata.characterWorlds.bindingVersion = 999;
  }, TypeError);
  assert.equal(
    store.getTurnInputByTurnId("turn-restart-recovery").metadata.characterWorlds.bindingVersion,
    3,
  );
  manager._messageStore = store;
});

await check("automatic recovery rejects forged, invalid, direct, and promoted inputs", async () => {
  const forgedTurnId = "turn-forged-queue-recovery";
  manager.admitTurnInput(SESSION_NATIVE, {
    turnId: forgedTurnId,
    delivery: "queue",
    userText: "forged recovery",
    metadata: {
      queueRecovery: {
        schemaVersion: 1,
        kind: "durable_queue",
        queueItemId: "forged-item",
        displayFiles: [],
        options: { queueOrigin: "renderer-forged" },
      },
    },
  });
  assert.equal(
    manager.pendingTurnInputs(SESSION_NATIVE).some((turn) => turn.turnId === forgedTurnId),
    false,
    "caller metadata must not mint a recoverable queue turn",
  );

  const directTurnId = "turn-direct-existing-bubble";
  manager.admitTurnInput(SESSION_NATIVE, {
    turnId: directTurnId,
    delivery: "direct",
    userText: "already visible",
    metadata: {},
  });
  store.append(SESSION_NATIVE, {
    id: "message-direct-existing-bubble",
    role: "user",
    content: "already visible",
    turnId: directTurnId,
  });
  assert.equal(
    manager.pendingTurnInputs(SESSION_NATIVE).some((turn) => turn.turnId === directTurnId),
    false,
    "direct turns with an existing user bubble must never become recovered queue items",
  );

  const invalidTurnId = "turn-invalid-queue-recovery";
  manager.admitTurnInput(SESSION_NATIVE, {
    turnId: invalidTurnId,
    delivery: "queue",
    userText: "invalid recovery",
    metadata: {},
  });
  store.db.run(
    "UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?",
    JSON.stringify({
      queueRecovery: {
        schemaVersion: 999,
        queueItemId: "invalid-item",
        displayFiles: [],
        options: {},
      },
    }),
    invalidTurnId,
  );
  assert.equal(
    manager.pendingTurnInputs(SESSION_NATIVE).some((turn) => turn.turnId === invalidTurnId),
    false,
    "invalid persisted envelopes must not be auto-recovered",
  );

  const promotedState = orchestrator._state(SESSION_NATIVE);
  promotedState.phase = "running";
  promotedState.turnId = "active-before-promoted-queue";
  const queued = await orchestrator.sendUserMessage(
    SESSION_NATIVE,
    "promoted must pause",
    [],
    { skipPreflight: true, spawnEngine: false },
  );
  const promotedItem = promotedState.queue.find(
    (item) => item.admittedTurnInput?.turnId === queued.turnId
      || item.id === queued.itemId,
  );
  assert.ok(promotedItem?.admittedTurnInput);
  const promotedClaim = store.claimTurnInputDispatch(
    SESSION_NATIVE,
    promotedItem.admittedTurnInput.turnId,
    {
      attemptId: "dispatch-promoted-recovery-test",
      ownerScope: OWNER_A,
    },
  );
  assert.equal(promotedClaim.ok, true);
  store.markTurnInputPromoted(promotedItem.admittedTurnInput.turnId, {
    status: "promoted",
    dispatchAttemptId: promotedClaim.attemptId,
  });
  assert.equal(
    manager.pendingTurnInputs(SESSION_NATIVE).some(
      (turn) => turn.turnId === promotedItem.admittedTurnInput.turnId,
    ),
    false,
    "promoted is outcome-unknown and must never auto-replay",
  );
  promotedState.queue = [];
});

await check("restart restores and executes exact durable queues once without binding bleed", async () => {
  const restartSessionA = makeSession("binding-restart-session-a", OWNER_A);
  const restartSessionB = makeSession("binding-restart-session-b", OWNER_B);
  sessions.push(restartSessionA, restartSessionB);
  const restartRepository = new CharacterWorldsRepository(store);
  restartRepository.setBinding({
    sessionId: restartSessionA.id,
    ownerScope: OWNER_A,
    expectedBindingVersion: 0,
    next: {
      mode: "character",
      characterRevisionId: firstCharacter.revision.id,
      compatibilityProfile: "restart-profile-old",
    },
  });
  restartRepository.setBinding({
    sessionId: restartSessionB.id,
    ownerScope: OWNER_B,
    expectedBindingVersion: 0,
    next: {
      mode: "character",
      characterRevisionId: otherOwnerCharacter.revision.id,
      compatibilityProfile: "restart-profile-owner-b",
    },
  });

  const admissionRuntime = makeOrchestrator(manager, [restartSessionA, restartSessionB]);
  const stateA = admissionRuntime.orchestrator._state(restartSessionA.id);
  const stateB = admissionRuntime.orchestrator._state(restartSessionB.id);
  stateA.phase = "running";
  stateA.turnId = "restart-active-a";
  stateB.phase = "running";
  stateB.turnId = "restart-active-b";
  const scheduled = await admissionRuntime.orchestrator.sendUserMessage(
    restartSessionA.id,
    "durable scheduled prompt",
    [{ name: "restart-a.txt" }],
    {
      scheduledTaskId: "restart-task-a",
      scheduledTaskRunId: "restart-run-a",
      scheduledTaskTitle: "Restart task A",
      queueOrigin: "scheduled_task",
      queueVisibility: "background",
      recordUser: true,
      spawnEngine: false,
      skipDocument: true,
      skipPreflight: true,
      skipVision: true,
    },
  );
  assert.equal(scheduled.queued, true);
  const scheduledItem = stateA.queue[0];

  const externalEnvelope = {
    commandId: "restart-command-b",
    idempotencyKey: "restart-idempotency-b",
    payloadHash: "restart-payload-b",
    lilySessionId: restartSessionB.id,
    desktopDeviceId: "restart-desktop-b",
    mobileDeviceId: "restart-device-b",
    remoteSessionId: "restart-remote-b",
    text: "durable mobile prompt",
    mode: "queue",
  };
  const external = await admissionRuntime.orchestrator.admitExternalCommand(
    externalEnvelope,
    { sessionExists: true, sessionOwned: true },
  );
  assert.equal(external.ok, true);
  const externalItem = stateB.queue[0];

  const completed = manager.admitTurnInput(restartSessionA.id, {
    turnId: "restart-completed-turn",
    userText: "already completed",
    metadata: {},
  });
  manager.markTurnInputTerminal({
    ownerScope: OWNER_A,
    sessionId: restartSessionA.id,
    turnId: completed.turnId,
    dispatchAttemptId: null,
    fromStatuses: ["admitted"],
  }, "turn.completed");
  const assistantCommitted = manager.admitTurnInput(restartSessionA.id, {
    turnId: "restart-assistant-committed-turn",
    userText: "assistant already committed",
    metadata: {},
  });
  store.append(restartSessionA.id, {
    id: "restart-assistant-message",
    role: "assistant",
    content: "already delivered",
    turnId: assistantCommitted.turnId,
  });

  restartRepository.setBinding({
    sessionId: restartSessionA.id,
    ownerScope: OWNER_A,
    expectedBindingVersion: 1,
    next: {
      mode: "character",
      characterRevisionId: secondCharacter.revision.id,
      compatibilityProfile: "restart-profile-new",
    },
  });

  store.close();
  manager._messageStore = null;
  store = new MessageStore(dbPath, blobDir);
  manager._messageStore = store;

  const recoveredRuntime = makeOrchestrator(manager, [restartSessionA, restartSessionB]);
  assert.equal(typeof recoveredRuntime.orchestrator.restorePendingTurns, "function");
  assert.equal(typeof recoveredRuntime.orchestrator.startRecoveredTurns, "function");
  const recoveredStateA = recoveredRuntime.orchestrator._state(restartSessionA.id);
  const recoveredStateB = recoveredRuntime.orchestrator._state(restartSessionB.id);
  recoveredRuntime.orchestrator.restorePendingTurns(restartSessionA.id);
  recoveredRuntime.orchestrator.restorePendingTurns(restartSessionA.id);
  recoveredRuntime.orchestrator.restorePendingTurns(restartSessionB.id);

  assert.equal(
    recoveredStateA.queue.filter(
      (item) => item.admittedTurnInput?.turnId === scheduledItem.admittedTurnInput.turnId,
    ).length,
    1,
  );
  assert.equal(recoveredStateB.queue.length, 1);
  const restoredScheduled = recoveredStateA.queue.find(
    (item) => item.admittedTurnInput?.turnId === scheduledItem.admittedTurnInput.turnId,
  );
  const restoredExternal = recoveredStateB.queue.find(
    (item) => item.admittedTurnInput?.turnId === externalItem.admittedTurnInput.turnId,
  );
  assert.ok(restoredScheduled);
  assert.ok(restoredExternal);
  assert.equal(restoredScheduled.text, "durable scheduled prompt");
  assert.deepEqual(restoredScheduled.displayFiles, [{ name: "restart-a.txt" }]);
  assert.equal(restoredScheduled.admittedTurnInput.delivery, "queue");
  assert.equal(restoredScheduled.options.queueOrigin, "scheduled_task");
  assert.equal(restoredScheduled.options.queueVisibility, "background");
  assert.equal(restoredScheduled.options.scheduledTaskRunId, "restart-run-a");
  assert.deepEqual(
    restoredScheduled.admittedTurnInput.metadata.characterWorlds,
    expectedReady(1, firstCharacter.revision.id, "restart-profile-old"),
  );
  assert.equal(restoredExternal.options.externalCommand.commandId, "restart-command-b");
  assert.deepEqual(
    restoredExternal.admittedTurnInput.metadata.characterWorlds,
    expectedReady(1, otherOwnerCharacter.revision.id, "restart-profile-owner-b"),
  );
  assert.equal(
    recoveredStateA.queue.some(
      (item) => item.admittedTurnInput?.turnId === completed.turnId,
    ),
    false,
  );
  assert.equal(
    recoveredStateA.queue.some(
      (item) => item.admittedTurnInput?.turnId === assistantCommitted.turnId,
    ),
    false,
  );

  const scheduledReplay = await recoveredRuntime.orchestrator.sendUserMessage(
    restartSessionA.id,
    "duplicate scheduler delivery",
    [],
    {
      scheduledTaskId: "restart-task-a",
      scheduledTaskRunId: "restart-run-a",
      queueOrigin: "scheduled_task",
    },
  );
  assert.equal(scheduledReplay.duplicate, true);
  assert.equal(recoveredStateA.queue.length, 1);
  const externalReplay = await recoveredRuntime.orchestrator.admitExternalCommand(
    externalEnvelope,
    { sessionExists: true, sessionOwned: true },
  );
  assert.equal(externalReplay.ok, true);
  assert.equal(recoveredStateB.queue.length, 1);

  const runnerA = recoveredRuntime.runners.get(restartSessionA.id);
  runnerA.busy = false;
  await recoveredRuntime.orchestrator.startRecoveredTurns(restartSessionA.id);
  assert.equal(recoveredStateA.queue.length, 0);
  assert.equal(recoveredStateA.turnId, scheduledItem.admittedTurnInput.turnId);
  assert.deepEqual(
    recoveredStateA.characterWorldsSnapshot,
    expectedReady(1, firstCharacter.revision.id, "restart-profile-old"),
  );
  assert.equal(
    store.getTurnInputByTurnId(scheduledItem.admittedTurnInput.turnId).status,
    "promoted",
  );
  assert.equal(recoveredStateB.queue.length, 1, "another session remains isolated");
});

await check("durable dispatch crash matrix is at-most-once and ledger-deduplicated", async () => {
  const addSession = (id, ownerScope, revisionId, profile) => {
    const session = makeSession(id, ownerScope);
    sessions.push(session);
    new CharacterWorldsRepository(store).setBinding({
      sessionId: id,
      ownerScope,
      expectedBindingVersion: 0,
      next: {
        mode: "character",
        characterRevisionId: revisionId,
        compatibilityProfile: profile,
      },
    });
    return session;
  };
  const reopenStore = () => {
    store.close();
    manager._messageStore = null;
    store = new MessageStore(dbPath, blobDir);
    manager._messageStore = store;
  };

  const beforeCasSession = addSession(
    "dispatch-crash-before-cas",
    OWNER_A,
    firstCharacter.revision.id,
    "dispatch-profile-before-cas",
  );
  const beforeCasRuntime = makeOrchestrator(manager, [beforeCasSession]);
  const beforeCasState = beforeCasRuntime.orchestrator._state(beforeCasSession.id);
  beforeCasState.phase = "running";
  beforeCasState.turnId = "dispatch-active-before-cas";
  const beforeCasQueued = await beforeCasRuntime.orchestrator.sendUserMessage(
    beforeCasSession.id,
    "recover exactly once before CAS",
    [],
    { skipDocument: true, skipPreflight: true, skipVision: true },
  );
  const beforeCasTurnId = beforeCasState.queue.find(
    (item) => item.id === beforeCasQueued.itemId,
  ).admittedTurnInput.turnId;
  new CharacterWorldsRepository(store).setBinding({
    sessionId: beforeCasSession.id,
    ownerScope: OWNER_A,
    expectedBindingVersion: 1,
    next: {
      mode: "character",
      characterRevisionId: secondCharacter.revision.id,
      compatibilityProfile: "dispatch-profile-after-cas",
    },
  });
  reopenStore();
  const beforeCasRecovered = makeOrchestrator(manager, [beforeCasSession]);
  const beforeCasRecoveredState = beforeCasRecovered.orchestrator._state(beforeCasSession.id);
  beforeCasRecovered.orchestrator.restorePendingTurns(beforeCasSession.id);
  beforeCasRecovered.orchestrator.restorePendingTurns(beforeCasSession.id);
  assert.equal(
    beforeCasRecoveredState.queue.filter(
      (item) => item.admittedTurnInput?.turnId === beforeCasTurnId,
    ).length,
    1,
    "a crash before dispatch CAS must recover one queue item exactly once",
  );
  assert.deepEqual(
    beforeCasRecoveredState.queue[0].admittedTurnInput.metadata.characterWorlds,
    expectedReady(
      1,
      firstCharacter.revision.id,
      "dispatch-profile-before-cas",
    ),
  );
  manager.markTurnInputTerminal({
    ownerScope: OWNER_A,
    sessionId: beforeCasSession.id,
    turnId: beforeCasTurnId,
    dispatchAttemptId: null,
    fromStatuses: ["admitted"],
  }, "turn.interrupted");
  beforeCasRecoveredState.queue = [];

  const beforeSendSession = addSession(
    "dispatch-crash-after-claim",
    OWNER_A,
    firstCharacter.revision.id,
    "dispatch-profile-after-claim",
  );
  const beforeSendRuntime = makeOrchestrator(manager, [beforeSendSession], {
    turnDispatchFaultInjector(phase) {
      if (phase === "after_dispatch_claim") throw new Error("crash after dispatch claim");
    },
  });
  const beforeSendState = beforeSendRuntime.orchestrator._state(beforeSendSession.id);
  beforeSendState.phase = "running";
  beforeSendState.turnId = "dispatch-active-after-claim";
  const beforeSendQueued = await beforeSendRuntime.orchestrator.sendUserMessage(
    beforeSendSession.id,
    "scheduled crash after claim",
    [],
    {
      scheduledTaskId: "dispatch-task-after-claim",
      scheduledTaskRunId: "dispatch-run-after-claim",
      queueOrigin: "scheduled_task",
      queueVisibility: "background",
      skipDocument: true,
      skipPreflight: true,
      skipVision: true,
    },
  );
  const beforeSendItem = beforeSendState.queue.find(
    (item) => item.id === beforeSendQueued.itemId,
  );
  beforeSendState.phase = "idle";
  beforeSendState.turnId = null;
  beforeSendRuntime.runners.get(beforeSendSession.id).busy = false;
  await beforeSendRuntime.orchestrator._dispatchNext(beforeSendSession.id);
  const beforeSendTurn = store.getTurnInputByTurnId(
    beforeSendItem.admittedTurnInput.turnId,
  );
  assert.equal(beforeSendTurn.status, "dispatching");
  assert.ok(beforeSendTurn.dispatchAttemptId);
  assert.equal(beforeSendRuntime.runners.get(beforeSendSession.id).sentPayloads.length, 0);

  reopenStore();
  const beforeSendRecovered = makeOrchestrator(manager, [beforeSendSession]);
  const beforeSendRecoveredState = beforeSendRecovered.orchestrator._state(
    beforeSendSession.id,
  );
  beforeSendRecovered.orchestrator.restorePendingTurns(beforeSendSession.id);
  beforeSendRecovered.orchestrator.restorePendingTurns(beforeSendSession.id);
  assert.equal(beforeSendRecoveredState.queue.length, 0);
  assert.equal(beforeSendRecoveredState.outcomeUnknownTurns.length, 1);
  assert.equal(
    beforeSendRecovered.emittedEvents.filter(
      ({ sessionId, event }) => (
        sessionId === beforeSendSession.id
        && event.type === "turn.dispatch_outcome_unknown"
      ),
    ).length,
    1,
  );
  const scheduledReplay = await beforeSendRecovered.orchestrator.sendUserMessage(
    beforeSendSession.id,
    "must not replay scheduled dispatch",
    [],
    {
      scheduledTaskId: "dispatch-task-after-claim",
      scheduledTaskRunId: "dispatch-run-after-claim",
      queueOrigin: "scheduled_task",
    },
  );
  assert.equal(scheduledReplay.duplicate, true);
  assert.equal(scheduledReplay.outcomeUnknown, true);
  assert.equal(beforeSendRecoveredState.queue.length, 0);
  manager.markTurnInputTerminal({
    ownerScope: OWNER_A,
    sessionId: beforeSendSession.id,
    turnId: beforeSendTurn.turnId,
    dispatchAttemptId: beforeSendTurn.dispatchAttemptId,
    fromStatuses: ["dispatching"],
  }, "turn.interrupted");

  const acceptedSession = addSession(
    "dispatch-crash-after-engine-accept",
    OWNER_B,
    otherOwnerCharacter.revision.id,
    "dispatch-profile-engine-accept",
  );
  const acceptedRuntime = makeOrchestrator(manager, [acceptedSession], {
    turnDispatchFaultInjector(phase) {
      if (phase === "after_engine_accept") throw new Error("crash after engine accept");
    },
  });
  const acceptedState = acceptedRuntime.orchestrator._state(acceptedSession.id);
  acceptedState.phase = "running";
  acceptedState.turnId = "dispatch-active-engine-accept";
  const commandEnvelope = {
    commandId: "dispatch-command-engine-accept",
    idempotencyKey: "dispatch-idempotency-engine-accept",
    payloadHash: "dispatch-payload-engine-accept",
    lilySessionId: acceptedSession.id,
    desktopDeviceId: "dispatch-desktop-engine-accept",
    mobileDeviceId: "dispatch-device-engine-accept",
    remoteSessionId: "dispatch-remote-engine-accept",
    text: "mobile crash after engine accept",
    mode: "queue",
  };
  const commandAdmission = await acceptedRuntime.orchestrator.admitExternalCommand(
    commandEnvelope,
    { sessionExists: true, sessionOwned: true },
  );
  assert.equal(commandAdmission.ok, true);
  const acceptedItem = acceptedState.queue[0];
  acceptedRuntime.ctx.diagnoseSendBlocker = () => null;
  acceptedRuntime.ctx.ensureSessionRunner = () => ({
    runner: acceptedRuntime.runners.get(acceptedSession.id),
    project: fakeProjectManager().find("project-binding"),
    coldStart: false,
    usedResume: false,
  });
  acceptedState.phase = "idle";
  acceptedState.turnId = null;
  acceptedRuntime.runners.get(acceptedSession.id).busy = false;
  await acceptedRuntime.orchestrator._dispatchNext(acceptedSession.id);
  const acceptedTurn = store.getTurnInputByTurnId(
    acceptedItem.admittedTurnInput.turnId,
  );
  assert.equal(acceptedTurn.status, "dispatching");
  assert.equal(acceptedRuntime.runners.get(acceptedSession.id).sentPayloads.length, 1);

  reopenStore();
  const acceptedRecovered = makeOrchestrator(manager, [acceptedSession]);
  const acceptedRecoveredState = acceptedRecovered.orchestrator._state(acceptedSession.id);
  acceptedRecovered.orchestrator.restorePendingTurns(acceptedSession.id);
  assert.equal(acceptedRecoveredState.queue.length, 0);
  assert.equal(acceptedRecoveredState.outcomeUnknownTurns.length, 1);
  const commandReplay = await acceptedRecovered.orchestrator.admitExternalCommand(
    commandEnvelope,
    { sessionExists: true, sessionOwned: true },
  );
  assert.equal(commandReplay.ok, true);
  assert.equal(acceptedRecoveredState.queue.length, 0);
  manager.markTurnInputTerminal({
    ownerScope: OWNER_B,
    sessionId: acceptedSession.id,
    turnId: acceptedTurn.turnId,
    dispatchAttemptId: acceptedTurn.dispatchAttemptId,
    fromStatuses: ["dispatching"],
  }, "turn.interrupted");

  const promotedSession = addSession(
    "dispatch-crash-after-promoted",
    OWNER_A,
    firstCharacter.revision.id,
    "dispatch-profile-promoted",
  );
  const promotedRuntime = makeOrchestrator(manager, [promotedSession]);
  const promotedState = promotedRuntime.orchestrator._state(promotedSession.id);
  promotedState.phase = "running";
  promotedState.turnId = "dispatch-active-promoted";
  const promotedQueued = await promotedRuntime.orchestrator.sendUserMessage(
    promotedSession.id,
    "crash after promoted",
    [],
    { skipDocument: true, skipPreflight: true, skipVision: true },
  );
  const promotedItem = promotedState.queue.find(
    (item) => item.id === promotedQueued.itemId,
  );
  promotedState.phase = "idle";
  promotedState.turnId = null;
  promotedRuntime.runners.get(promotedSession.id).busy = false;
  await promotedRuntime.orchestrator._dispatchNext(promotedSession.id);
  const promotedTurn = store.getTurnInputByTurnId(
    promotedItem.admittedTurnInput.turnId,
  );
  assert.equal(promotedTurn.status, "promoted");
  assert.ok(promotedTurn.acceptedAt);

  reopenStore();
  const promotedRecovered = makeOrchestrator(manager, [promotedSession]);
  const promotedRecoveredState = promotedRecovered.orchestrator._state(promotedSession.id);
  promotedRecovered.orchestrator.restorePendingTurns(promotedSession.id);
  promotedRecovered.orchestrator.restorePendingTurns(promotedSession.id);
  assert.equal(promotedRecoveredState.queue.length, 0);
  assert.equal(promotedRecoveredState.outcomeUnknownTurns.length, 1);
  assert.equal(promotedRecoveredState.outcomeUnknownTurns[0].turnId, promotedTurn.turnId);
  manager.markTurnInputTerminal({
    ownerScope: OWNER_A,
    sessionId: promotedSession.id,
    turnId: promotedTurn.turnId,
    dispatchAttemptId: promotedTurn.dispatchAttemptId,
    fromStatuses: ["promoted"],
  }, "turn.interrupted");
});

await check("queued admission failures are visible and never create memory-only work", async () => {
  const session = makeSession("queued-admission-failure", OWNER_A);
  sessions.push(session);
  const runtime = makeOrchestrator(manager, [session]);
  const state = runtime.orchestrator._state(session.id);
  state.phase = "running";
  state.turnId = "queued-admission-failure-active";
  const originalAdmitQueued = manager.admitQueuedTurnInput;
  manager.admitQueuedTurnInput = () => null;
  try {
    const ordinary = await runtime.orchestrator.sendUserMessage(
      session.id,
      "ordinary queue admission must fail",
    );
    assert.equal(ordinary.ok, false);
    assert.equal(ordinary.error, "TURN_ADMISSION_FAILED");
    assert.equal(state.queue.length, 0);

    const local = await runtime.orchestrator.completeLocalAssistantTurn(
      session.id,
      "local queue admission must fail",
      [],
      { assistant: "local result" },
    );
    assert.equal(local.ok, false);
    assert.equal(local.error, "TURN_ADMISSION_FAILED");
    assert.equal(state.queue.length, 0);

    const interrupted = await runtime.orchestrator.interruptAndSend(
      session.id,
      "priority queue admission must fail",
    );
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.error, "TURN_ADMISSION_FAILED");
    assert.equal(state.queue.length, 0);
    assert.equal(state.turnId, "queued-admission-failure-active");

    state.phase = "idle";
    state.turnId = null;
    const scheduled = await runtime.orchestrator.sendUserMessage(
      session.id,
      "scheduled admission must fail before execution",
      [],
      {
        scheduledTaskId: "admission-failure-task",
        scheduledTaskRunId: "admission-failure-run",
        queueOrigin: "scheduled_task",
        queueVisibility: "background",
      },
    );
    assert.equal(scheduled.ok, false);
    assert.equal(scheduled.error, "TURN_ADMISSION_FAILED");
    assert.equal(state.queue.length, 0);
    assert.equal(runtime.runners.get(session.id).sentPayloads.length, 0);

    const external = await runtime.orchestrator.admitExternalCommand({
      commandId: "admission-failure-command",
      idempotencyKey: "admission-failure-idempotency",
      payloadHash: "admission-failure-payload",
      lilySessionId: session.id,
      desktopDeviceId: "admission-failure-desktop",
      mobileDeviceId: "admission-failure-device",
      text: "external admission must fail",
      mode: "queue",
    }, { sessionExists: true, sessionOwned: true });
    assert.equal(external.ok, false);
    assert.equal(external.code, "TURN_ADMISSION_FAILED");
    assert.equal(state.queue.length, 0);
    assert.equal(
      runtime.orchestrator.externalCommandRuntime.ledgers
        .get(session.id)
        ?.has("admission-failure-command") || false,
      false,
    );
  } finally {
    manager.admitQueuedTurnInput = originalAdmitQueued;
  }
});

await check("a duplicate local queued turn is reconciled without a second execution", async () => {
  const session = makeSession("local-queue-idempotency", OWNER_A);
  sessions.push(session);
  const runtime = makeOrchestrator(manager, [session]);
  const state = runtime.orchestrator._state(session.id);
  state.phase = "running";
  state.turnId = "local-queue-active";
  const opts = {
    turnId: "local-queue-stable-turn",
    assistant: "local durable result",
  };
  const first = await runtime.orchestrator.completeLocalAssistantTurn(
    session.id,
    "local durable input",
    [],
    opts,
  );
  const replay = await runtime.orchestrator.completeLocalAssistantTurn(
    session.id,
    "local durable input",
    [],
    opts,
  );
  assert.equal(first.queued, true);
  assert.equal(replay.duplicate, true);
  assert.equal(state.queue.length, 1);
  assert.equal(
    store.db.get(
      "SELECT COUNT(*) AS count FROM turn_inputs WHERE turn_id = ?",
      "local-queue-stable-turn",
    ).count,
    1,
  );
});

await check("durable queue admission strips large display thumbnails but keeps safe file refs", async () => {
  const session = makeSession("durable-thumbnail-stripping", OWNER_A);
  sessions.push(session);
  const runtime = makeOrchestrator(manager, [session]);
  const state = runtime.orchestrator._state(session.id);
  state.phase = "running";
  state.turnId = "durable-thumbnail-active";
  const file = {
    id: "thumbnail-file",
    name: "proof.png",
    path: path.join(tmp, "proof.png"),
    sourcePath: path.join(tmp, "proof.png"),
    staged: true,
    readable: true,
    isImage: true,
    type: "image/png",
    size: 1024,
  };
  const thumbnail = `data:image/png;base64,${"a".repeat(70 * 1024)}`;
  const result = await runtime.orchestrator.sendUserMessage(
    session.id,
    "queue image with a large display-only thumbnail",
    [{ ...file, thumbnail }],
    {
      displayFiles: [{ ...file, thumbnail }],
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(state.queue.length, 1);
  const admitted = state.queue[0].admittedTurnInput;
  assert.ok(admitted?.turnId, "the queue item must have a durable admission");
  const persisted = store.getTurnInputByTurnId(admitted.turnId);
  assert.equal(persisted.metadata.queueRecovery.fileRefs[0].path, file.path);
  assert.equal(
    JSON.stringify(persisted.metadata.queueRecovery).includes("data:image"),
    false,
  );
  assert.equal(
    Object.hasOwn(persisted.metadata.queueRecovery.fileRefs[0], "thumbnail"),
    false,
  );
  assert.equal(Object.hasOwn(persisted.files[0], "thumbnail"), false);
  assert.equal(JSON.stringify(persisted.files).includes("data:image"), false);

  const invalidRequiredRef = {
    ...file,
    path: "x".repeat(9 * 1024),
  };
  const rejected = await runtime.orchestrator.sendUserMessage(
    session.id,
    "reject an oversized execution path",
    [invalidRequiredRef],
    { displayFiles: [invalidRequiredRef] },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "TURN_ADMISSION_FAILED");
  assert.equal(state.queue.length, 1, "failed admission must not add memory-only work");
});

await check("persistent admission keys dedupe the oldest outcome beyond the display window", async () => {
  const session = makeSession("persistent-idempotency-window", OWNER_A);
  sessions.push(session);
  let oldestTurnId = null;
  for (let index = 0; index < 101; index += 1) {
    const runId = index === 0 ? "persistent-oldest-run" : `persistent-run-${index}`;
    const turnId = `persistent-turn-${index}`;
    const envelope = createQueueRecoveryEnvelope({
      item: { id: `persistent-queue-${index}`, displayFiles: [] },
      options: {
        queueOrigin: "scheduled_task",
        queueVisibility: "background",
        scheduledTaskId: "persistent-task",
        scheduledTaskRunId: runId,
      },
    });
    const admissionResult = manager.admitQueuedTurnInput(
      session.id,
      {
        turnId,
        delivery: "queue",
        userText: `persistent ${index}`,
        files: [],
        metadata: {},
      },
      envelope,
    );
    const admitted = admissionResult?.turn || admissionResult;
    assert.ok(admitted?.turnId);
    const claimed = manager.claimTurnInputDispatch(session.id, admitted.turnId, {
      attemptId: `persistent-dispatch-${index}`,
      startedAt: 10_000 + index,
      ownerScope: OWNER_A,
    });
    assert.equal(claimed.ok, true);
    if (index === 0) oldestTurnId = admitted.turnId;
  }

  const runtime = makeOrchestrator(manager, [session]);
  const state = runtime.orchestrator._state(session.id);
  assert.equal(state.outcomeUnknownTurns.length, 100, "display remains bounded");
  assert.equal(
    state.outcomeUnknownTurns.some((turn) => turn.turnId === oldestTurnId),
    false,
    "the oldest outcome is intentionally outside the display window",
  );
  state.phase = "running";
  state.turnId = "persistent-active-turn";
  const beforeCount = Number(store.db.get(
    "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
    session.id,
  ).count);
  const replay = await runtime.orchestrator.sendUserMessage(
    session.id,
    "must not re-admit oldest scheduled run",
    [],
    {
      scheduledTaskId: "persistent-task",
      scheduledTaskRunId: "persistent-oldest-run",
      queueOrigin: "scheduled_task",
      queueVisibility: "background",
    },
  );
  const afterCount = Number(store.db.get(
    "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
    session.id,
  ).count);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.outcomeUnknown, true);
  assert.equal(replay.turnId, oldestTurnId);
  assert.equal(afterCount, beforeCount, "durable duplicate must not insert another turn");
  assert.equal(state.queue.length, 0, "durable duplicate must not enter the in-memory queue");
  assert.equal(runtime.runners.get(session.id).sentPayloads.length, 0);
});

await check("queue removal terminalizes durable admission before memory deletion", async () => {
  const session = makeSession("durable-queue-cancel", OWNER_A);
  sessions.push(session);
  const runtime = makeOrchestrator(manager, [session]);
  const state = runtime.orchestrator._state(session.id);
  state.phase = "running";
  state.turnId = "durable-queue-cancel-active";
  runtime.runners.get(session.id).busy = true;
  const queued = await runtime.orchestrator.sendUserMessage(
    session.id,
    "cancel this queued turn",
    [],
    {
      skipPreflight: true,
      skipVision: true,
      skipDocument: true,
    },
  );
  assert.equal(queued.queued, true);
  const item = state.queue.find((candidate) => candidate.id === queued.itemId);
  assert.equal(item.admittedTurnInput.ownerScope, OWNER_A);
  const cancelled = runtime.orchestrator.cancelQueuedMessage(
    session.id,
    queued.itemId,
  );
  assert.equal(cancelled.ok, true);
  assert.equal(state.queue.length, 0);
  const persisted = store.getTurnInputByTurnId(item.admittedTurnInput.turnId, OWNER_A);
  assert.equal(persisted.status, "interrupted");
  assert.equal(
    manager.pendingTurnInputs(session.id).some(
      (turn) => turn.turnId === item.admittedTurnInput.turnId,
    ),
    false,
  );
});

await check("clear, replace, scheduled cancel, and dispatch races preserve durable truth", async () => {
  const clearSession = makeSession("durable-queue-clear", OWNER_A);
  sessions.push(clearSession);
  const clearRuntime = makeOrchestrator(manager, [clearSession]);
  const clearState = clearRuntime.orchestrator._state(clearSession.id);
  clearState.phase = "running";
  clearState.turnId = "durable-queue-clear-active";
  clearRuntime.runners.get(clearSession.id).busy = true;
  const ordinary = await clearRuntime.orchestrator.sendUserMessage(
    clearSession.id,
    "ordinary queued work",
    [],
    { skipPreflight: true, skipVision: true, skipDocument: true },
  );
  const scheduled = await clearRuntime.orchestrator.sendUserMessage(
    clearSession.id,
    "scheduled queued work",
    [],
    {
      scheduledTaskId: "durable-clear-task",
      scheduledTaskRunId: "durable-clear-run",
      queueOrigin: "scheduled_task",
      queueVisibility: "background",
    },
  );
  const ordinaryItem = clearState.queue.find((item) => item.id === ordinary.itemId);
  const scheduledItem = clearState.queue.find((item) => item.id === scheduled.itemId);
  const scheduledCancelled = clearRuntime.orchestrator.cancelQueuedScheduledRun(
    clearSession.id,
    "durable-clear-run",
  );
  assert.equal(scheduledCancelled.ok, true);
  assert.equal(
    store.getTurnInputByTurnId(
      scheduledItem.admittedTurnInput.turnId,
      OWNER_A,
    ).status,
    "interrupted",
  );
  assert.deepEqual(clearState.queue.map((item) => item.id), [ordinary.itemId]);

  const cleared = clearRuntime.orchestrator.interrupt(clearSession.id);
  assert.equal(cleared.ok, true);
  assert.equal(clearState.queue.length, 0);
  assert.equal(
    store.getTurnInputByTurnId(
      ordinaryItem.admittedTurnInput.turnId,
      OWNER_A,
    ).status,
    "interrupted",
  );

  const replaceSession = makeSession("durable-queue-replace", OWNER_A);
  sessions.push(replaceSession);
  const replaceRuntime = makeOrchestrator(manager, [replaceSession]);
  const replaceState = replaceRuntime.orchestrator._state(replaceSession.id);
  replaceState.phase = "running";
  replaceState.turnId = "durable-queue-replace-active";
  replaceRuntime.runners.get(replaceSession.id).busy = true;
  const replaced = await replaceRuntime.orchestrator.sendUserMessage(
    replaceSession.id,
    "old queued work",
    [],
    { skipPreflight: true, skipVision: true, skipDocument: true },
  );
  const replacedItem = replaceState.queue.find((item) => item.id === replaced.itemId);
  const replacement = await replaceRuntime.orchestrator.interruptAndSend(
    replaceSession.id,
    "new priority work",
    [],
    { skipPreflight: true, skipVision: true, skipDocument: true },
  );
  assert.equal(replacement.ok, true);
  assert.equal(replaceState.queue.length, 1);
  assert.equal(
    store.getTurnInputByTurnId(
      replacedItem.admittedTurnInput.turnId,
      OWNER_A,
    ).status,
    "interrupted",
  );
  assert.ok(
    ["admitted", "dispatching", "promoted"].includes(
      store.getTurnInputByTurnId(
        replaceState.queue[0].admittedTurnInput.turnId,
        OWNER_A,
      ).status,
    ),
    "the replacement remains durably live while only the old item is cancelled",
  );

  const raceSession = makeSession("durable-queue-cancel-race", OWNER_A);
  sessions.push(raceSession);
  const raceRuntime = makeOrchestrator(manager, [raceSession]);
  const raceState = raceRuntime.orchestrator._state(raceSession.id);
  raceState.phase = "running";
  raceState.turnId = "durable-queue-cancel-race-active";
  raceRuntime.runners.get(raceSession.id).busy = true;
  const racing = await raceRuntime.orchestrator.sendUserMessage(
    raceSession.id,
    "dispatch claim races cancellation",
    [],
    { skipPreflight: true, skipVision: true, skipDocument: true },
  );
  const racingItem = raceState.queue.find((item) => item.id === racing.itemId);
  const claim = manager.claimTurnInputDispatch(
    raceSession.id,
    racingItem.admittedTurnInput.turnId,
    {
      ownerScope: OWNER_A,
      attemptId: "dispatch-cancel-integration-race",
    },
  );
  assert.equal(claim.ok, true);
  racingItem.admittedTurnInput = claim.turn;
  racingItem.dispatchAttemptId = claim.attemptId;
  const raceCancel = raceRuntime.orchestrator.cancelQueuedMessage(
    raceSession.id,
    racing.itemId,
  );
  assert.equal(raceCancel.ok, false);
  assert.equal(raceCancel.error, "DISPATCH_OUTCOME_UNKNOWN");
  assert.equal(raceState.queue.length, 1, "unknown dispatch stays visible in memory");
  assert.equal(
    store.getTurnInputByTurnId(
      racingItem.admittedTurnInput.turnId,
      OWNER_A,
    ).status,
    "dispatching",
  );
  const raceClear = raceRuntime.orchestrator.interrupt(raceSession.id);
  assert.equal(raceClear.ok, false);
  assert.equal(raceClear.error, "DISPATCH_OUTCOME_UNKNOWN");
  assert.equal(raceState.queue.length, 1, "clear cannot report success for an unknown dispatch");

  const replaceRaceSession = makeSession(
    "durable-queue-replace-race",
    OWNER_A,
  );
  sessions.push(replaceRaceSession);
  const replaceRaceRuntime = makeOrchestrator(manager, [replaceRaceSession]);
  const replaceRaceState = replaceRaceRuntime.orchestrator._state(
    replaceRaceSession.id,
  );
  replaceRaceState.phase = "running";
  replaceRaceState.turnId = "durable-queue-replace-race-active";
  replaceRaceRuntime.runners.get(replaceRaceSession.id).busy = true;
  const replaceRacing = await replaceRaceRuntime.orchestrator.sendUserMessage(
    replaceRaceSession.id,
    "old dispatching queue work",
    [],
    { skipPreflight: true, skipVision: true, skipDocument: true },
  );
  const replaceRacingItem = replaceRaceState.queue.find(
    (item) => item.id === replaceRacing.itemId,
  );
  const replaceRaceClaim = manager.claimTurnInputDispatch(
    replaceRaceSession.id,
    replaceRacingItem.admittedTurnInput.turnId,
    {
      ownerScope: OWNER_A,
      attemptId: "dispatch-replace-integration-race",
    },
  );
  assert.equal(replaceRaceClaim.ok, true);
  replaceRacingItem.admittedTurnInput = replaceRaceClaim.turn;
  replaceRacingItem.dispatchAttemptId = replaceRaceClaim.attemptId;
  const rowsBeforeRejectedReplace = store.db.get(
    "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
    replaceRaceSession.id,
  ).count;
  const rejectedReplace = await replaceRaceRuntime.orchestrator.interruptAndSend(
    replaceRaceSession.id,
    "must not be admitted behind unknown work",
    [],
    { skipPreflight: true, skipVision: true, skipDocument: true },
  );
  assert.equal(rejectedReplace.ok, false);
  assert.equal(rejectedReplace.error, "DISPATCH_OUTCOME_UNKNOWN");
  assert.equal(
    store.db.get(
      "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
      replaceRaceSession.id,
    ).count,
    rowsBeforeRejectedReplace,
    "a rejected replace must not leave a second recoverable admission",
  );
  assert.deepEqual(
    replaceRaceState.queue.map((item) => item.id),
    [replaceRacing.itemId],
    "the outcome-unknown item remains the sole in-memory queue owner",
  );
  assert.equal(
    replaceRaceState.turnId,
    "durable-queue-replace-race-active",
    "a rejected replace cannot interrupt an unrelated active turn",
  );
});

await check("principal switch pauses foreign queue and restores it once for its owner", async () => {
  const session = makeSession("principal-switch-queue", OWNER_A);
  sessions.push(session);
  const runtime = makeOrchestrator(manager, [session]);
  const state = runtime.orchestrator._state(session.id);
  const runner = runtime.runners.get(session.id);
  state.phase = "running";
  state.turnId = "principal-switch-active";
  runner.busy = true;
  const queued = await runtime.orchestrator.sendUserMessage(
    session.id,
    "execute only for owner A",
    [],
    {
      skipPreflight: true,
      skipVision: true,
      skipDocument: true,
      spawnEngine: false,
    },
  );
  assert.equal(queued.queued, true);
  const queuedTurnId = state.queue[0].admittedTurnInput.turnId;
  assert.equal(state.queue[0].admittedTurnInput.ownerScope, OWNER_A);

  state.phase = "idle";
  state.turnId = null;
  runner.busy = false;
  session.ownerScopeForTest = OWNER_B;
  runtime.orchestrator.handlePrincipalChange();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.queue.length, 0, "foreign item leaves volatile memory");
  assert.equal(runner.sentPayloads.length, 0, "owner B cannot execute owner A work");
  assert.equal(
    store.getTurnInputByTurnId(queuedTurnId, OWNER_A).status,
    "admitted",
    "principal pause preserves the durable admission",
  );

  session.ownerScopeForTest = OWNER_A;
  runtime.orchestrator.handlePrincipalChange();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runner.sentPayloads.length, 1, "owner A restores and executes once");
  assert.equal(
    store.getTurnInputByTurnId(queuedTurnId, OWNER_A).status,
    "promoted",
  );
  runtime.orchestrator.handlePrincipalChange();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runner.sentPayloads.length, 1, "repeated principal notification is idempotent");
});

store.close();
console.log(`character-binding-isolation: ${checks} checks passed`);
