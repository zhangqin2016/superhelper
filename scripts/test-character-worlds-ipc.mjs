#!/usr/bin/env node
// Character Worlds IPC + preload contract (Phase 1, Task 8).
//
// Verifies the narrow bridge invariants from the design spec §15/§16 and
// HANDOFF.md §5/§6:
//   - the complete character-worlds channel contract is exposed through one
//     frozen preload facade
//   - owner scope is derived in main; renderer-supplied owner/account IDs are
//     ignored
//   - the renderer never supplies raw source paths (import source comes from a
//     main-process open dialog) or destination paths (export destination comes
//     from a main-process save dialog + opaque broker reservation)
//   - payloads/IDs are bounded, stale binding CAS returns the current binding,
//     unknown sessions cannot be mutated, and errors are stable and
//     renderer-safe (no stacks, messages, or local paths)
//
// Run: node scripts/test-character-worlds-ipc.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);

const CHANNELS = {
  listCharacters: "character:list",
  listOfficialCharacters: "character:list-official",
  installOfficialCharacter: "character:install-official",
  getCharacter: "character:get",
  previewCharacterImport: "character:import-preview",
  commitCharacterImport: "character:import-commit",
  exportCharacter: "character:export",
  getSessionCharacterBinding: "session-character:get-binding",
  setSessionCharacterBinding: "session-character:set-binding",
  getSessionCharacterEvents: "session-character:get-events",
  // Phase 2A (WB-6): read-only world-book inspection. In-depth book behavior
  // lives in test-character-world-book-ipc.mjs; this contract test tracks the
  // channel/facade surface.
  listWorldBooks: "world-book:list",
  getWorldBook: "world-book:get",
  getWorldBookRevision: "world-book:get-revision",
  // Phase 2B (P2B-2): read-only persona inspection. In-depth persona binding
  // and envelope behavior lives in test-character-persona-context.mjs.
  listPersonas: "persona:list",
  getPersona: "persona:get",
  // Phase 3 (P3-2): group-scene reads + validated mutations.
  getScene: "scene:get",
  getGreetings: "character:greetings",
  updateScene: "scene:update",
  getSceneMemory: "scene:memory",
  getReceiptActions: "character-worlds:receipt-actions",
  getPreview: "character-worlds:preview-get",
  startPreview: "character-worlds:preview-start",
  exitPreview: "character-worlds:preview-exit",
  activatePreview: "character-worlds:preview-activate",
  adjustTarget: "character-worlds:adjust-target",
};
const BRIDGE_METHODS = Object.keys(CHANNELS).sort();
// Official catalog installation is intentionally separate from user authoring:
// it creates a trusted local copy of a reviewed first-party revision.
// Phase 2B (P2B-4): authoring mutations + revision reads, covered in depth by
// test-character-authoring-ipc.mjs; this contract test tracks the facade surface.
const AUTHORING_BRIDGE_METHODS = [
  "createCharacter",
  "updateCharacterRevision",
  "restoreCharacterRevision",
  "duplicateCharacter",
  "archiveCharacter",
  "getCharacterRevision",
  "getCharacterHistory",
  "createPersona",
  "updatePersonaRevision",
  "archivePersona",
  "getPersonaRevision",
  "getPersonaHistory",
  "createWorldBook",
  "archiveWorldBook",
  "getWorldBookHistory",
];
const ALL_BRIDGE_METHODS = [...BRIDGE_METHODS, ...AUTHORING_BRIDGE_METHODS].sort();

// --- electron mock -----------------------------------------------------------

const handlers = new Map();
const exposed = {};
const invokeCalls = [];
const openDialogQueue = [];
const saveDialogQueue = [];
const saveDialogOptions = [];
const trustedWebContents = { id: 7 };
const mainWindow = { webContents: trustedWebContents, isDestroyed: () => false };

const electronMock = {
  ipcMain: {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  },
  dialog: {
    showOpenDialog: async () => openDialogQueue.shift() || { canceled: true, filePaths: [] },
    showSaveDialog: async (_window, options) => {
      saveDialogOptions.push(options || {});
      return saveDialogQueue.shift() || { canceled: true, filePath: "" };
    },
  },
  contextBridge: {
    exposeInMainWorld(key, value) {
      exposed[key] = value;
    },
  },
  ipcRenderer: {
    invoke(channel, payload) {
      invokeCalls.push({ channel, payload });
      return Promise.resolve({ ok: true });
    },
    send() {},
    on() {},
    removeListener() {},
  },
  webUtils: { getPathForFile: () => "" },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};

function trustedEvent() {
  return { sender: trustedWebContents, senderFrame: { url: "file:///app/renderer/index.html" } };
}
function untrustedEvent() {
  return { sender: { id: 999 }, senderFrame: { url: "https://evil.example/pwn" } };
}
function remoteFrameEvent() {
  return { sender: trustedWebContents, senderFrame: { url: "https://evil.example/pwn" } };
}

// --- real domain stack over a temp MessageStore ------------------------------

const OWNER = "profile:local";
const OTHER_OWNER = "profile:other";
const FIXTURES = path.resolve("fixtures/character-worlds");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-worlds-ipc-"));
const sourceRoot = path.join(tmp, "sources");
const exportRoot = path.join(tmp, "exports");
fs.mkdirSync(sourceRoot);
fs.mkdirSync(exportRoot);

const { MessageStore } = require("../src/main/store/message-store.js");
const {
  CharacterWorldsService,
  CharacterSourceAuthority,
  CharacterDestinationWriter,
} = require("../src/main/character-worlds/service.js");
const {
  DialogDestinationBroker,
} = require("../src/main/character-worlds/dialog-destination-broker.js");

const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = store.characterWorlds();
const sourceAuthority = new CharacterSourceAuthority({ roots: [sourceRoot] });
const destinationBroker = new DialogDestinationBroker();
const destinationWriter = new CharacterDestinationWriter({
  broker: destinationBroker,
  ownsBroker: true,
});

function makeService(overrides = {}) {
  return new CharacterWorldsService({
    messageStore: store,
    repository,
    sourceAuthority,
    destinationWriter,
    resolveOwnerScope: async () => OWNER,
    ...overrides,
  });
}

const service = makeService({ ownsDestinationWriter: true });
const sessions = new Map([["session-a", { id: "session-a" }], ["session-b", { id: "session-b" }]]);
const ctx = {
  mainWindow,
  characterWorldsService: service,
  characterWorldsRepository: repository,
  resolveCharacterOwnerScope: () => OWNER,
  // Rollout policy (Task 10): these tests exercise the domain behavior with
  // the feature enabled; the disabled/kill-switch paths have their own
  // coverage in test-character-worlds-policy.mjs.
  characterWorldsPolicy: () => ({ enabled: true, compatibilityProfile: "lily-character-compat-1" }),
  sessionManager: {
    resolveTurnOwnerScope(sessionId) {
      if (!sessions.has(sessionId)) {
        return Object.freeze({ ok: false, error: "NO_SESSION", ownerScope: null });
      }
      return Object.freeze({ ok: true, error: null, ownerScope: OWNER });
    },
  },
};

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}

function copyFixture(name) {
  const target = path.join(sourceRoot, name);
  fs.copyFileSync(path.join(FIXTURES, name), target);
  return target;
}

const { registerCharacterWorldsHandlers } = require("../src/main/ipc-character-worlds.js");

try {
  console.log("character-worlds-ipc:");

  registerCharacterWorldsHandlers(ctx);
  // Load the real preload against the electron mock to capture the bridge.
  require("../src/preload.js");

  await check("exactly the contract channels are registered", async () => {
    assert.deepEqual([...handlers.keys()].sort(), Object.values(CHANNELS).sort());
    for (const channel of Object.values(CHANNELS)) {
      assert.equal(typeof handlers.get(channel), "function", `${channel} handler registered`);
    }
  });

  await check("preload exposes one frozen facade with the complete method set", async () => {
    const api = exposed.assistantClient;
    assert(api, "assistantClient exposed");
    assert(api.characterWorlds, "characterWorlds facade exposed");
    assert(Object.isFrozen(api.characterWorlds), "facade is frozen");
    assert.deepEqual(Object.keys(api.characterWorlds).sort(), ALL_BRIDGE_METHODS);
    assert.equal(typeof api.invoke, "undefined", "no generic invoke leaks");
  });

  await check("preload wrappers invoke the contract channels with whitelisted payloads", async () => {
    const api = exposed.assistantClient.characterWorlds;
    invokeCalls.length = 0;
    await api.listCharacters();
    await api.listOfficialCharacters();
    await api.installOfficialCharacter("lily-companion");
    await api.getCharacter("char-1");
    await api.previewCharacterImport();
    await api.previewCharacterImport({ sourcePath: "/tmp/card.json" });
    await api.commitCharacterImport({ previewToken: "t".repeat(64), duplicateResolution: "create_copy" });
    await api.exportCharacter("rev-1");
    await api.getSessionCharacterBinding("session-a");
    await api.setSessionCharacterBinding({
      sessionId: "session-a", expectedBindingVersion: 0, mode: "native",
    });
    await api.getSessionCharacterEvents("session-a", { afterVersion: 2, limit: 10 });
    await api.listWorldBooks();
    await api.getWorldBook("book-1");
    await api.getWorldBookRevision("book-rev-1");
    await api.listPersonas();
    await api.getPersona("persona-1");
    await api.getScene("session-a");
    await api.getSceneMemory("session-a", "rev-1");
    await api.updateScene({ sessionId: "session-a", participantCharacterRevisionIds: ["rev-1"], replyStrategy: "natural", promptMode: "swap" });
    await api.getReceiptActions("session-a", "receipt-1");
    await api.getPreview("session-a");
    await api.startPreview({ sessionId: "session-a", receiptId: "receipt-1", actionToken: "token", expectedPreviewVersion: 0 });
    await api.exitPreview("session-a", 1);
    await api.activatePreview({ sessionId: "session-a", receiptId: "receipt-1", actionToken: "token", expectedPreviewVersion: 1, expectedBindingVersion: 0 });
    await api.adjustTarget({ sessionId: "session-a", receiptId: "receipt-1", actionToken: "token" });
    assert.deepEqual(
      invokeCalls.map((call) => call.channel),
      [
        "character:list",
        "character:list-official",
        "character:install-official",
        "character:get",
        "character:import-preview",
        "character:import-preview",
        "character:import-commit",
        "character:export",
        "session-character:get-binding",
        "session-character:set-binding",
        "session-character:get-events",
        "world-book:list",
        "world-book:get",
        "world-book:get-revision",
        "persona:list",
        "persona:get",
        "scene:get",
        "scene:memory",
        "scene:update",
        "character-worlds:receipt-actions",
        "character-worlds:preview-get",
        "character-worlds:preview-start",
        "character-worlds:preview-exit",
        "character-worlds:preview-activate",
        "character-worlds:adjust-target",
      ],
    );
    const serialized = JSON.stringify(invokeCalls);
    assert(!serialized.includes("ownerScope"), "bridge never forwards owner scope");
    assert(!/outputPath|destinationPath|filePath/.test(serialized), "bridge never forwards generic paths");
    // §13.2: sourcePath is forwarded ONLY on the character import-preview
    // channel (drag-and-drop / paste / local path), never anywhere else.
    assert.deepEqual(JSON.parse(JSON.stringify(invokeCalls)).filter((c) => c.channel === "character:import-preview").length, 2, "both preview calls carry the preview channel");
    assert.equal(invokeCalls[0].payload, undefined, "listCharacters takes no payload");
    assert.deepEqual(invokeCalls[1].payload, undefined, "listOfficialCharacters takes no payload");
    assert.deepEqual(invokeCalls[2].payload, { officialId: "lily-companion" }, "installOfficialCharacter forwards an official ID");
    assert.deepEqual(invokeCalls[3].payload, { characterId: "char-1" });
    assert.equal(invokeCalls[4].payload, undefined, "previewCharacterImport takes no payload");
    assert.deepEqual(invokeCalls[5].payload, { sourcePath: "/tmp/card.json" }, "previewCharacterImport forwards a validated sourcePath");
    assert.equal(invokeCalls[11].payload, undefined, "listWorldBooks takes no payload");
    assert.equal(invokeCalls[14].payload, undefined, "listPersonas takes no payload");
    assert.deepEqual(invokeCalls[6].payload, { previewToken: "t".repeat(64), duplicateResolution: "create_copy" });
    assert.deepEqual(invokeCalls[7].payload, { revisionId: "rev-1" });
    assert.deepEqual(invokeCalls[12].payload, { worldBookId: "book-1" });
    assert.deepEqual(invokeCalls[13].payload, { revisionId: "book-rev-1" });
    assert.deepEqual(invokeCalls[15].payload, { personaId: "persona-1" });
  });

  await check("untrusted senders and remote frames are rejected on every channel", async () => {
    const before = repository.listCharacters(OWNER).length;
    for (const channel of Object.values(CHANNELS)) {
      const payload = channel === "session-character:set-binding"
        ? { sessionId: "session-a", expectedBindingVersion: 0, mode: "native" }
        : { sessionId: "session-a" };
      const fromStranger = await handlers.get(channel)(untrustedEvent(), payload);
      assert.deepEqual(fromStranger, { ok: false, error: "UNTRUSTED_SENDER" }, `${channel} stranger`);
      const fromRemoteFrame = await handlers.get(channel)(remoteFrameEvent(), payload);
      assert.deepEqual(fromRemoteFrame, { ok: false, error: "UNTRUSTED_SENDER" }, `${channel} remote frame`);
      const noEvent = await handlers.get(channel)(null, payload);
      assert.deepEqual(noEvent, { ok: false, error: "UNTRUSTED_SENDER" }, `${channel} missing event`);
    }
    assert.equal(repository.listCharacters(OWNER).length, before, "no side effects");
    assert.equal(repository.getBinding("session-a", OWNER).bindingVersion, 0, "binding untouched");
  });

  let v2Path;
  let preview;
  let committed;

  await check("import preview honors a user-chosen sourcePath but ignores spoofed authority fields", async () => {
    v2Path = copyFixture("v2-character.json");
    preview = await handlers.get("character:import-preview")(trustedEvent(), {
      sourcePath: v2Path,
      path: "/etc/passwd",
      ownerScope: OTHER_OWNER,
      accountId: "attacker",
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.kind, "characterCard");
    assert.equal(preview.canonical.name, "Luna V2", "parsed the forwarded sourcePath (§13.2), not a spoofed path field");
    assert.match(preview.previewToken, /^[a-f0-9]{64}$/);
    assert(!JSON.stringify(preview).includes(sourceRoot), "preview leaks no local path");
    assert.equal(repository.listCharacters(OWNER).length, 0, "preview is side-effect free");
  });

  await check("open dialog cancel is a stable renderer-safe result", async () => {
    const canceled = await handlers.get("character:import-preview")(trustedEvent(), {});
    assert.deepEqual(canceled, { ok: false, canceled: true });
  });

  await check("non-card files map to NOT_A_CHARACTER_CARD with ordinary attachment fallback", async () => {
    const ordinary = path.join(sourceRoot, "notes.json");
    fs.writeFileSync(ordinary, JSON.stringify({ hello: "world" }));
    openDialogQueue.push({ canceled: false, filePaths: [ordinary] });
    const result = await handlers.get("character:import-preview")(trustedEvent(), {});
    assert.deepEqual(result, { ok: false, error: "NOT_A_CHARACTER_CARD", fallback: "ordinary_attachment" });
  });

  await check("oversized cards map to CARD_TOO_LARGE", async () => {
    const smallAuthority = new CharacterSourceAuthority({ roots: [sourceRoot], maxBytes: 64 });
    const smallService = makeService({ sourceAuthority: smallAuthority });
    ctx.characterWorldsService = smallService;
    try {
      openDialogQueue.push({ canceled: false, filePaths: [v2Path] });
      const result = await handlers.get("character:import-preview")(trustedEvent(), {});
      assert.deepEqual(result, { ok: false, error: "CARD_TOO_LARGE" });
    } finally {
      ctx.characterWorldsService = service;
      await smallService.close();
    }
  });

  await check("import commit ignores renderer owner/account fields and is one-time", async () => {
    committed = await handlers.get("character:import-commit")(trustedEvent(), {
      previewToken: preview.previewToken,
      ownerScope: OTHER_OWNER,
      accountId: "attacker",
      duplicateResolution: "overwrite",
    });
    assert.equal(committed.ok, false, "unsupported duplicateResolution is rejected");
    assert.equal(committed.error, "INVALID_INPUT");

    committed = await handlers.get("character:import-commit")(trustedEvent(), {
      previewToken: preview.previewToken,
      ownerScope: OTHER_OWNER,
      accountId: "attacker",
    });
    assert.equal(committed.ok, true);
    assert.equal(committed.revision.canonical.name, "Luna V2");
    assert(!JSON.stringify(committed).includes(sourceRoot), "commit leaks no local path");

    const replay = await handlers.get("character:import-commit")(trustedEvent(), {
      previewToken: preview.previewToken,
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.error, "IMPORT_PREVIEW_EXPIRED");
    assert(!replay.message && !replay.stack, "no message/stack crosses the bridge");

    const garbage = await handlers.get("character:import-commit")(trustedEvent(), {
      previewToken: "not-a-token",
    });
    assert.deepEqual(garbage, { ok: false, error: "INVALID_INPUT" });
  });

  await check("list/get are owner-derived in main regardless of payload owner fields", async () => {
    const listed = await handlers.get("character:list")(trustedEvent(), {
      ownerScope: OTHER_OWNER,
      accountId: "attacker",
    });
    assert.equal(listed.ok, true);
    assert.equal(listed.characters.length, 1, "payload ownerScope cannot select another owner");
    assert.equal(listed.characters[0].displayName, "Luna V2");

    const fetched = await handlers.get("character:get")(trustedEvent(), {
      characterId: committed.entity.id,
      ownerScope: OTHER_OWNER,
    });
    assert.equal(fetched.ok, true);
    assert.equal(fetched.character.id, committed.entity.id);

    const missing = await handlers.get("character:get")(trustedEvent(), { characterId: crypto.randomUUID() });
    assert.deepEqual(missing, { ok: false, error: "CHARACTER_NOT_FOUND" });
  });

  await check("payload bytes and IDs are bounded", async () => {
    const huge = await handlers.get("character:import-commit")(trustedEvent(), {
      previewToken: "a".repeat(64),
      pad: "x".repeat(32 * 1024),
    });
    assert.deepEqual(huge, { ok: false, error: "INVALID_INPUT" });

    const longId = await handlers.get("character:get")(trustedEvent(), { characterId: "x".repeat(200) });
    assert.deepEqual(longId, { ok: false, error: "INVALID_INPUT" });

    const slashId = await handlers.get("character:get")(trustedEvent(), { characterId: "../secrets" });
    assert.deepEqual(slashId, { ok: false, error: "INVALID_INPUT" });

    const wrongType = await handlers.get("character:get")(trustedEvent(), { characterId: { id: "x" } });
    assert.deepEqual(wrongType, { ok: false, error: "INVALID_INPUT" });
  });

  await check("export goes save dialog -> broker reservation -> service, never a renderer path", async () => {
    const dialogTarget = path.join(exportRoot, "luna-export.json");
    const evilTarget = path.join(tmp, "evil-output.json");
    saveDialogQueue.push({ canceled: false, filePath: dialogTarget });
    const result = await handlers.get("character:export")(trustedEvent(), {
      revisionId: committed.revision.id,
      outputPath: evilTarget,
      destinationPath: evilTarget,
      filePath: evilTarget,
      ownerScope: OTHER_OWNER,
    });
    assert.equal(result.ok, true);
    assert.equal(result.fileName, "luna-export.json");
    assert(fs.existsSync(dialogTarget), "export landed on the dialog-approved path");
    assert(!fs.existsSync(evilTarget), "renderer-supplied path was never used");
    assert(!JSON.stringify(result).includes(exportRoot), "export leaks no absolute path");

    const missing = await handlers.get("character:export")(trustedEvent(), {
      revisionId: crypto.randomUUID(),
    });
    assert.deepEqual(missing, { ok: false, error: "CHARACTER_REVISION_NOT_FOUND" });

    saveDialogQueue.push({ canceled: true, filePath: "" });
    const canceled = await handlers.get("character:export")(trustedEvent(), {
      revisionId: committed.revision.id,
    });
    assert.deepEqual(canceled, { ok: false, canceled: true });

    const badId = await handlers.get("character:export")(trustedEvent(), { revisionId: "../x" });
    assert.deepEqual(badId, { ok: false, error: "INVALID_INPUT" });
  });

  await check("export defaultPath extension follows the source container (json/png/apng)", async () => {
    assert.match(saveDialogOptions.at(-1).defaultPath, /\.json$/, "json container suggests .json");

    const apngPath = copyFixture("v3-character.apng");
    openDialogQueue.push({ canceled: false, filePaths: [apngPath] });
    const apngPreview = await handlers.get("character:import-preview")(trustedEvent(), {});
    assert.equal(apngPreview.ok, true);
    assert.equal(apngPreview.container, "apng");
    const apngCommitted = await handlers.get("character:import-commit")(trustedEvent(), {
      previewToken: apngPreview.previewToken,
    });
    assert.equal(apngCommitted.ok, true);
    assert.equal(apngCommitted.revision.source.container, "apng");

    const apngTarget = path.join(exportRoot, "v3-export.apng");
    saveDialogQueue.push({ canceled: false, filePath: apngTarget });
    const apngExport = await handlers.get("character:export")(trustedEvent(), {
      revisionId: apngCommitted.revision.id,
    });
    assert.equal(apngExport.ok, true);
    assert.match(saveDialogOptions.at(-1).defaultPath, /\.apng$/, "apng container suggests .apng");
    assert.equal(apngExport.fileName, "v3-export.apng");
    assert(fs.existsSync(apngTarget));
  });

  await check("destination broker cache is LRU-capped and eviction closes helper processes", async () => {
    const created = [];
    const lruBroker = new DialogDestinationBroker({
      maxParentBrokers: 2,
      createBroker: ({ approvedParent }) => {
        const broker = {
          approvedParent,
          closed: false,
          ready: async () => {},
          reserve: async ({ fileName }) => ({ fileName }),
          stats: () => ({ reservations: 0 }),
          close: async () => { broker.closed = true; },
        };
        created.push(broker);
        return broker;
      },
    });
    const dirs = ["lru-a", "lru-b", "lru-c", "lru-d"].map((name) => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir);
      return dir;
    });
    await lruBroker.reserve(path.join(dirs[0], "x.json"));
    await lruBroker.reserve(path.join(dirs[1], "x.json"));
    assert.equal(lruBroker.stats().parents, 2);
    await lruBroker.reserve(path.join(dirs[2], "x.json"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lruBroker.stats().parents, 2, "cache stays capped");
    assert.equal(created[0].closed, true, "oldest helper closed on eviction");
    assert.equal(created[1].closed, false);
    await lruBroker.reserve(path.join(dirs[1], "y.json")); // touch b as most-recent
    await lruBroker.reserve(path.join(dirs[3], "x.json"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created[2].closed, true, "least-recently-used entry evicted next");
    assert.equal(created[1].closed, false, "recently used entry survives");
    await lruBroker.close();
    assert(created.every((broker) => broker.closed), "close() closes every cached helper");
  });

  await check("session binding get/set uses main-derived owner and CAS conflicts carry current state", async () => {
    const initial = await handlers.get("session-character:get-binding")(trustedEvent(), {
      sessionId: "session-a",
    });
    assert.equal(initial.ok, true);
    assert.deepEqual([initial.binding.mode, initial.binding.bindingVersion], ["native", 0]);

    const stale = await handlers.get("session-character:set-binding")(trustedEvent(), {
      sessionId: "session-a",
      expectedBindingVersion: 3,
      mode: "native",
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "CHARACTER_BINDING_CONFLICT");
    assert.equal(stale.currentBinding.bindingVersion, 0);

    const bound = await handlers.get("session-character:set-binding")(trustedEvent(), {
      sessionId: "session-a",
      expectedBindingVersion: 0,
      mode: "character",
      characterRevisionId: committed.revision.id,
      compatibilityProfile: "attacker-controlled",
      ownerScope: OTHER_OWNER,
    });
    assert.equal(bound.ok, true);
    assert.equal(bound.binding.bindingVersion, 1);
    assert.equal(bound.binding.characterRevisionId, committed.revision.id);
    assert.notEqual(bound.binding.compatibilityProfile, "attacker-controlled");

    const conflict = await handlers.get("session-character:set-binding")(trustedEvent(), {
      sessionId: "session-a",
      expectedBindingVersion: 0,
      mode: "native",
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "CHARACTER_BINDING_CONFLICT");
    assert.equal(conflict.currentBinding.bindingVersion, 1);

    for (const bad of [-1, 1.5, "0", null]) {
      const invalid = await handlers.get("session-character:set-binding")(trustedEvent(), {
        sessionId: "session-a",
        expectedBindingVersion: bad,
        mode: "native",
      });
      assert.deepEqual(invalid, { ok: false, error: "INVALID_INPUT" }, `version ${String(bad)}`);
    }
    const badMode = await handlers.get("session-character:set-binding")(trustedEvent(), {
      sessionId: "session-a",
      expectedBindingVersion: 1,
      mode: "god",
    });
    assert.deepEqual(badMode, { ok: false, error: "INVALID_INPUT" });
    const missingRevision = await handlers.get("session-character:set-binding")(trustedEvent(), {
      sessionId: "session-a",
      expectedBindingVersion: 1,
      mode: "character",
    });
    assert.deepEqual(missingRevision, { ok: false, error: "INVALID_INPUT" });
    assert.equal(repository.getBinding("session-a", OWNER).bindingVersion, 1, "no mutation on invalid input");
  });

  await check("unknown sessions cannot be read or mutated", async () => {
    const getGhost = await handlers.get("session-character:get-binding")(trustedEvent(), {
      sessionId: "ghost-session",
    });
    assert.deepEqual(getGhost, { ok: false, error: "NO_SESSION" });

    const setGhost = await handlers.get("session-character:set-binding")(trustedEvent(), {
      sessionId: "ghost-session",
      expectedBindingVersion: 0,
      mode: "character",
      characterRevisionId: committed.revision.id,
    });
    assert.deepEqual(setGhost, { ok: false, error: "NO_SESSION" });
    assert.equal(repository.getBinding("ghost-session", OWNER).bindingVersion, 0, "no ghost binding created");

    const eventsGhost = await handlers.get("session-character:get-events")(trustedEvent(), {
      sessionId: "ghost-session",
    });
    assert.deepEqual(eventsGhost, { ok: false, error: "NO_SESSION" });
  });

  await check("binding events are bounded and page by version", async () => {
    const all = await handlers.get("session-character:get-events")(trustedEvent(), {
      sessionId: "session-a",
      limit: 100000,
    });
    assert.equal(all.ok, true);
    assert.equal(all.events.length, 1);
    assert.equal(all.events[0].bindingVersion, 1);
    // Switch notices (Phase 2B, §8): the committed native → character change
    // projects one whitelisted notice with the display name resolved main-side
    // from the pinned revision — never raw card data.
    assert.equal(all.notices.length, 1);
    assert.deepEqual(
      { ...all.notices[0], createdAt: "" },
      { bindingVersion: 1, mode: "character", characterName: "Luna V2", createdAt: "" },
    );

    const after = await handlers.get("session-character:get-events")(trustedEvent(), {
      sessionId: "session-a",
      afterVersion: 1,
    });
    assert.deepEqual(after, { ok: true, events: [], notices: [] });

    const badLimit = await handlers.get("session-character:get-events")(trustedEvent(), {
      sessionId: "session-a",
      limit: -5,
    });
    assert.deepEqual(badLimit, { ok: false, error: "INVALID_INPUT" });
  });

  await check("errors are stable and renderer-safe (no stacks, messages, or secrets)", async () => {
    const leaky = {
      destinationWriter: null,
      previewImport: async () => {
        throw new Error(`boom ${path.join(tmp, "local-secret-path")}`);
      },
    };
    ctx.characterWorldsService = leaky;
    try {
      openDialogQueue.push({ canceled: false, filePaths: [v2Path] });
      const result = await handlers.get("character:import-preview")(trustedEvent(), {});
      assert.deepEqual(result, { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" });
      assert(!JSON.stringify(result).includes("local-secret-path"));
    } finally {
      ctx.characterWorldsService = service;
    }
  });

  await check("official install uses trusted provenance, ignores spoofed tags, and is idempotent", async () => {
    const spoof = repository.createCharacter({
      ownerScope: OWNER,
      canonical: {
        name: "Not Official",
        description: "user content",
        tags: ["official:lily-companion"],
      },
      source: { kind: "created", format: "lily", container: "json" },
    });
    const first = await handlers.get("character:install-official")(trustedEvent(), {
      officialId: "lily-companion",
    });
    assert.equal(first.ok, true);
    assert.notEqual(first.characterId, spoof.entity.id, "editable canonical tags cannot claim official identity");
    const revision = repository.getRevision(OWNER, first.revisionId);
    assert.equal(revision.source.kind, "official");
    assert.equal(revision.source.officialId, "lily-companion");
    assert.equal(revision.source.officialVersion, 1);
    assert.equal(revision.source.officialLocale, "en");

    const again = await handlers.get("character:install-official")(trustedEvent(), {
      officialId: "lily-companion",
    });
    assert.equal(again.characterId, first.characterId);
    assert.equal(again.revisionId, first.revisionId, "same catalog version does not duplicate revisions");

    const listed = await handlers.get("character:list-official")(trustedEvent(), {});
    const companion = listed.characters.find((item) => item.id === "lily-companion");
    assert.equal(companion.installedCharacterId, first.characterId);
    assert.equal(companion.currentRevisionId, first.revisionId);
    assert.equal(companion.updateAvailable, false);
  });

  await check("non-whitelisted error codes collapse; whitelisted domain codes pass through", async () => {
    const sqliteBusy = {
      destinationWriter: null,
      previewImport: async () => {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      },
    };
    ctx.characterWorldsService = sqliteBusy;
    try {
      openDialogQueue.push({ canceled: false, filePaths: [v2Path] });
      const result = await handlers.get("character:import-preview")(trustedEvent(), {});
      assert.deepEqual(result, { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" });
    } finally {
      ctx.characterWorldsService = service;
    }

    const domainCoded = {
      destinationWriter: null,
      previewImport: async () => {
        throw Object.assign(new Error("parse failed"), { code: "IMPORT_PARSE_FAILED" });
      },
    };
    ctx.characterWorldsService = domainCoded;
    try {
      openDialogQueue.push({ canceled: false, filePaths: [v2Path] });
      const result = await handlers.get("character:import-preview")(trustedEvent(), {});
      assert.deepEqual(result, { ok: false, error: "IMPORT_PARSE_FAILED" });
    } finally {
      ctx.characterWorldsService = service;
    }
  });

  await check("startup construction failure (null service/repository) fails closed on every channel", async () => {
    ctx.characterWorldsService = null;
    ctx.characterWorldsRepository = null;
    try {
      const payloads = {
        "character:list": {},
        "character:get": { characterId: committed.entity.id },
        "character:import-preview": {},
        "character:import-commit": { previewToken: "a".repeat(64) },
        "character:export": { revisionId: committed.revision.id },
        "session-character:get-binding": { sessionId: "session-a" },
        "session-character:set-binding": {
          sessionId: "session-a", expectedBindingVersion: 1, mode: "native",
        },
        "session-character:get-events": { sessionId: "session-a" },
        "world-book:list": {},
        "world-book:get": { worldBookId: "book-1" },
        "world-book:get-revision": { revisionId: "book-rev-1" },
      };
      for (const [channel, payload] of Object.entries(payloads)) {
        const result = await handlers.get(channel)(trustedEvent(), payload);
        assert.deepEqual(
          result,
          { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" },
          `${channel} fails closed without throwing`,
        );
      }
    } finally {
      ctx.characterWorldsService = service;
      ctx.characterWorldsRepository = repository;
    }
  });

  console.log(`character-worlds-ipc: ok (${checks} checks)`);
} finally {
  Module._load = originalLoad;
  try {
    await service.close();
  } catch {
    // best-effort cleanup
  }
}
