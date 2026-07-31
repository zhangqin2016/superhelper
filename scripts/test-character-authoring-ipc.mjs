#!/usr/bin/env node
// Character Worlds authoring IPC + preload contract (Phase 2B, Task P2B-4).
//
// Verifies the guarded authoring mutation channels from the design spec
// §13.2/§15/§16 on top of the validated domain API (P2B-3):
//   - fifteen channels: ten mutations (character create/update-revision/
//     restore-revision/duplicate/archive, persona create/update-revision/
//     archive, world-book create/archive) plus five read channels
//     (character/persona/world-book history, character/persona get-revision)
//   - trusted-sender guard on every channel; owner scope derived in main
//     (renderer ownerScope/accountId payload fields are ignored)
//   - payloads and ids bounded; failures are stable coded results
//   - rollout policy gate: EVERY authoring mutation — including archive, which
//     is a mutation and stays gated (there is no unarchive) — follows import
//     availability; read-only channels stay open under a disabled policy,
//     exactly like list/get in ipc-character-worlds.js
//
// Run: node scripts/test-character-authoring-ipc.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);

const MUTATION_CHANNELS = [
  "character:create",
  "character:update-revision",
  "character:restore-revision",
  "character:duplicate",
  "character:archive",
  "persona:create",
  "persona:update-revision",
  "persona:archive",
  "world-book:create",
  "world-book:archive",
];
const READ_CHANNELS = [
  "character:history",
  "persona:history",
  "world-book:history",
  "character:get-revision",
  "persona:get-revision",
];
const CHANNELS = [...MUTATION_CHANNELS, ...READ_CHANNELS];

const FACADE_METHODS = {
  createCharacter: "character:create",
  updateCharacterRevision: "character:update-revision",
  restoreCharacterRevision: "character:restore-revision",
  duplicateCharacter: "character:duplicate",
  archiveCharacter: "character:archive",
  getCharacterRevision: "character:get-revision",
  getCharacterHistory: "character:history",
  createPersona: "persona:create",
  updatePersonaRevision: "persona:update-revision",
  archivePersona: "persona:archive",
  getPersonaRevision: "persona:get-revision",
  getPersonaHistory: "persona:history",
  createWorldBook: "world-book:create",
  archiveWorldBook: "world-book:archive",
  getWorldBookHistory: "world-book:history",
};

// --- electron mock -----------------------------------------------------------

const handlers = new Map();
const exposed = {};
const invokeCalls = [];
const trustedWebContents = { id: 7 };
const mainWindow = { webContents: trustedWebContents, isDestroyed: () => false };

const electronMock = {
  ipcMain: {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: "" }),
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-authoring-ipc-"));
const sourceRoot = path.join(tmp, "sources");
fs.mkdirSync(sourceRoot);

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
const destinationBroker = new DialogDestinationBroker();
const service = new CharacterWorldsService({
  messageStore: store,
  repository,
  sourceAuthority: new CharacterSourceAuthority({ roots: [sourceRoot] }),
  destinationWriter: new CharacterDestinationWriter({
    broker: destinationBroker,
    ownsBroker: true,
  }),
  resolveOwnerScope: async () => OWNER,
  ownsDestinationWriter: true,
});

const ctx = {
  mainWindow,
  characterWorldsService: service,
  characterWorldsRepository: repository,
  resolveCharacterOwnerScope: () => OWNER,
  characterWorldsPolicy: () => ({ enabled: true, compatibilityProfile: "lily-character-compat-1" }),
  sessionManager: {
    resolveTurnOwnerScope() {
      return Object.freeze({ ok: false, error: "NO_SESSION", ownerScope: null });
    },
  },
};

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}

const { registerCharacterAuthoringHandlers } = require("../src/main/ipc-character-authoring.js");

function samplePayload(channel, ids = {}) {
  const characterId = ids.characterId || "char-x";
  const revisionId = ids.revisionId || "rev-x";
  const personaId = ids.personaId || "persona-x";
  const worldBookId = ids.worldBookId || "book-x";
  switch (channel) {
    case "character:create": return { canonical: { name: "A" } };
    case "character:update-revision":
      return { characterId, expectedBaseRevisionId: revisionId, canonical: { name: "A" } };
    case "character:restore-revision":
      return { characterId, revisionId, expectedBaseRevisionId: revisionId };
    case "character:duplicate": return { characterId };
    case "character:archive": return { characterId };
    case "character:history": return { characterId };
    case "character:get-revision": return { revisionId };
    case "persona:create": return { canonical: { name: "P" } };
    case "persona:update-revision":
      return { personaId, expectedBaseRevisionId: revisionId, canonical: { name: "P" } };
    case "persona:archive": return { personaId };
    case "persona:history": return { personaId };
    case "persona:get-revision": return { revisionId };
    case "world-book:create": return { canonical: { name: "B", entries: [] } };
    case "world-book:archive": return { worldBookId };
    case "world-book:history": return { worldBookId };
    default: throw new Error(`unknown channel ${channel}`);
  }
}

try {
  console.log("character-authoring-ipc:");

  registerCharacterAuthoringHandlers(ctx);
  require("../src/preload.js");

  await check("exactly the fifteen authoring channels are registered", async () => {
    assert.deepEqual([...handlers.keys()].sort(), [...CHANNELS].sort());
  });

  await check("preload facade exposes the fifteen authoring methods, frozen", async () => {
    const api = exposed.assistantClient;
    assert(api?.characterWorlds, "characterWorlds facade exposed");
    assert(Object.isFrozen(api.characterWorlds), "facade is frozen");
    for (const method of Object.keys(FACADE_METHODS)) {
      assert.equal(typeof api.characterWorlds[method], "function", `${method} exposed`);
    }
  });

  await check("preload wrappers invoke the contract channels with whitelisted payloads", async () => {
    const api = exposed.assistantClient.characterWorlds;
    invokeCalls.length = 0;
    await api.createCharacter({ canonical: { name: "A" }, ownerScope: OTHER_OWNER, accountId: "x" });
    await api.updateCharacterRevision({
      characterId: "c1", expectedBaseRevisionId: "r1", canonical: { name: "A" },
      ownerScope: OTHER_OWNER,
    });
    await api.restoreCharacterRevision({
      characterId: "c1", revisionId: "r0", expectedBaseRevisionId: "r1", filePath: "/etc/passwd",
    });
    await api.duplicateCharacter("c1");
    await api.archiveCharacter("c1");
    await api.getCharacterRevision("r1");
    await api.getCharacterHistory("c1", { limit: 10 });
    await api.createPersona({ canonical: { name: "P" }, ownerScope: OTHER_OWNER });
    await api.updatePersonaRevision({ personaId: "p1", expectedBaseRevisionId: "r1", canonical: { name: "P" } });
    await api.archivePersona("p1");
    await api.getPersonaRevision("r1");
    await api.getPersonaHistory("p1");
    await api.createWorldBook({ canonical: { name: "B", entries: [] } });
    await api.archiveWorldBook("b1");
    await api.getWorldBookHistory("b1");
    assert.deepEqual(
      invokeCalls.map((call) => call.channel),
      Object.values(FACADE_METHODS),
    );
    const serialized = JSON.stringify(invokeCalls);
    assert(!serialized.includes("ownerScope"), "bridge never forwards owner scope");
    assert(!serialized.includes("accountId"), "bridge never forwards account ids");
    assert(!/filePath|sourcePath|outputPath/.test(serialized), "bridge never forwards paths");
    assert.deepEqual(invokeCalls[0].payload, { canonical: { name: "A" } });
    assert.deepEqual(invokeCalls[1].payload, {
      characterId: "c1", expectedBaseRevisionId: "r1", canonical: { name: "A" },
    });
    assert.deepEqual(invokeCalls[2].payload, {
      characterId: "c1", revisionId: "r0", expectedBaseRevisionId: "r1",
    });
    assert.deepEqual(invokeCalls[3].payload, { characterId: "c1" });
    assert.deepEqual(invokeCalls[6].payload, { characterId: "c1", limit: 10 });
    assert.deepEqual(invokeCalls[14].payload, { worldBookId: "b1", limit: undefined });
  });

  await check("untrusted senders and remote frames are rejected on every channel", async () => {
    const before = repository.listCharacters(OWNER).length;
    for (const channel of CHANNELS) {
      const payload = samplePayload(channel);
      const fromStranger = await handlers.get(channel)(untrustedEvent(), payload);
      assert.deepEqual(fromStranger, { ok: false, error: "UNTRUSTED_SENDER" }, `${channel} stranger`);
      const fromRemoteFrame = await handlers.get(channel)(remoteFrameEvent(), payload);
      assert.deepEqual(fromRemoteFrame, { ok: false, error: "UNTRUSTED_SENDER" }, `${channel} remote frame`);
      const noEvent = await handlers.get(channel)(null, payload);
      assert.deepEqual(noEvent, { ok: false, error: "UNTRUSTED_SENDER" }, `${channel} missing event`);
    }
    assert.equal(repository.listCharacters(OWNER).length, before, "no side effects");
  });

  // --- character lifecycle over the bridge -----------------------------------

  let character;
  await check("character:create derives owner in main and validates canonical", async () => {
    const created = await handlers.get("character:create")(trustedEvent(), {
      canonical: { name: "Luna", description: "Navigator", tags: ["moon", "tide"] },
      ownerScope: OTHER_OWNER,
      accountId: "attacker",
    });
    assert.equal(created.ok, true);
    assert.equal(created.entity.displayName, "Luna");
    assert.equal(created.revision.revisionNumber, 1);
    assert.equal(created.revision.canonical.name, "Luna");
    assert.equal(repository.listCharacters(OTHER_OWNER).length, 0, "renderer ownerScope ignored");
    assert.equal(repository.listCharacters(OWNER).length, 1);
    character = created;
  });

  await check("character:get-revision returns the stored canonical for the editor", async () => {
    const read = await handlers.get("character:get-revision")(trustedEvent(), {
      revisionId: character.revision.id,
      ownerScope: OTHER_OWNER,
    });
    assert.equal(read.ok, true);
    assert.equal(read.revision.canonical.description, "Navigator");
    assert.deepEqual(read.revision.canonical.tags, ["moon", "tide"]);

    const missing = await handlers.get("character:get-revision")(trustedEvent(), {
      revisionId: crypto.randomUUID(),
    });
    assert.deepEqual(missing, { ok: false, error: "CHARACTER_REVISION_NOT_FOUND" });
    const badId = await handlers.get("character:get-revision")(trustedEvent(), {
      revisionId: "../secrets",
    });
    assert.deepEqual(badId, { ok: false, error: "INVALID_INPUT" });
  });

  await check("character:update-revision creates revision N+1 with CAS conflict coded", async () => {
    const edited = await handlers.get("character:update-revision")(trustedEvent(), {
      characterId: character.entity.id,
      expectedBaseRevisionId: character.revision.id,
      canonical: { ...character.revision.canonical, description: "Storm navigator" },
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.revision.revisionNumber, 2);
    assert.equal(edited.revision.parentRevisionId, character.revision.id);
    assert.equal(edited.revision.canonical.description, "Storm navigator");
    character = { entity: character.entity, revision: edited.revision };

    const stale = await handlers.get("character:update-revision")(trustedEvent(), {
      characterId: character.entity.id,
      expectedBaseRevisionId: edited.revision.parentRevisionId,
      canonical: { name: "Conflicting" },
    });
    assert.deepEqual(stale, { ok: false, error: "CHARACTER_REVISION_CONFLICT" });

    const unknown = await handlers.get("character:update-revision")(trustedEvent(), {
      characterId: crypto.randomUUID(),
      expectedBaseRevisionId: character.revision.id,
      canonical: { name: "Ghost" },
    });
    assert.deepEqual(unknown, { ok: false, error: "CHARACTER_NOT_FOUND" });
  });

  await check("ids, versions, and payload bytes are bounded", async () => {
    const longId = await handlers.get("character:archive")(trustedEvent(), {
      characterId: "x".repeat(200),
    });
    assert.deepEqual(longId, { ok: false, error: "INVALID_INPUT" });

    const slashId = await handlers.get("character:duplicate")(trustedEvent(), {
      characterId: "../x",
    });
    assert.deepEqual(slashId, { ok: false, error: "INVALID_INPUT" });

    const missingBase = await handlers.get("character:update-revision")(trustedEvent(), {
      characterId: character.entity.id,
      canonical: { name: "A" },
    });
    assert.deepEqual(missingBase, { ok: false, error: "INVALID_INPUT" });

    const huge = await handlers.get("character:create")(trustedEvent(), {
      canonical: { name: "x".repeat(2 * 1024 * 1024) },
    });
    assert.deepEqual(huge, { ok: false, error: "INVALID_INPUT" });

    const arrayPayload = await handlers.get("character:create")(trustedEvent(), [1, 2, 3]);
    assert.deepEqual(arrayPayload, { ok: false, error: "INVALID_INPUT" });

    const badLimit = await handlers.get("character:history")(trustedEvent(), {
      characterId: character.entity.id,
      limit: -5,
    });
    assert.deepEqual(badLimit, { ok: false, error: "INVALID_INPUT" });
  });

  await check("hostile canonical input fails with the import model's codes", async () => {
    const wrongType = await handlers.get("character:create")(trustedEvent(), {
      canonical: { name: 42 },
    });
    assert.deepEqual(wrongType, { ok: false, error: "CARD_JSON_INVALID" });

    const emptyName = await handlers.get("character:create")(trustedEvent(), {
      canonical: { name: "   " },
    });
    assert.deepEqual(emptyName, { ok: false, error: "CARD_ROOT_INVALID" });
  });

  await check("character:history is newest-first metadata (no canonical payload)", async () => {
    const history = await handlers.get("character:history")(trustedEvent(), {
      characterId: character.entity.id,
      limit: 100000,
      ownerScope: OTHER_OWNER,
    });
    assert.equal(history.ok, true);
    assert.equal(history.revisions.length, 2);
    assert.equal(history.revisions[0].revisionNumber, 2);
    assert.equal(history.revisions[1].revisionNumber, 1);
    assert(!("canonical" in history.revisions[0]), "history stays metadata-only");

    const unknown = await handlers.get("character:history")(trustedEvent(), {
      characterId: crypto.randomUUID(),
    });
    assert.deepEqual(unknown, { ok: false, error: "CHARACTER_NOT_FOUND" });
  });

  await check("character:restore-revision copies an old revision as a new one", async () => {
    const history = await handlers.get("character:history")(trustedEvent(), {
      characterId: character.entity.id,
    });
    const first = history.revisions.find((r) => r.revisionNumber === 1);
    const restored = await handlers.get("character:restore-revision")(trustedEvent(), {
      characterId: character.entity.id,
      revisionId: first.revisionId,
      expectedBaseRevisionId: character.revision.id,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.revision.revisionNumber, 3);
    assert.equal(restored.revision.canonical.description, "Navigator", "byte-equal copy of revision 1");
    assert.equal(restored.revision.source.restoredFromRevisionId, first.revisionId);
    character = { entity: character.entity, revision: restored.revision };
  });

  await check("character:duplicate creates an independent copy", async () => {
    const duplicated = await handlers.get("character:duplicate")(trustedEvent(), {
      characterId: character.entity.id,
      ownerScope: OTHER_OWNER,
    });
    assert.equal(duplicated.ok, true);
    assert.notEqual(duplicated.entity.id, character.entity.id);
    assert.equal(duplicated.revision.canonical.name, "Luna");
    assert.equal(duplicated.revision.revisionNumber, 1);
    assert.equal(repository.listCharacters(OWNER).length, 2);

    const unknown = await handlers.get("character:duplicate")(trustedEvent(), {
      characterId: crypto.randomUUID(),
    });
    assert.deepEqual(unknown, { ok: false, error: "CHARACTER_NOT_FOUND" });
  });

  await check("character:archive archives (revision reads stay available)", async () => {
    const listed = repository.listCharacters(OWNER);
    const target = listed.find((c) => c.id !== character.entity.id);
    const archived = await handlers.get("character:archive")(trustedEvent(), {
      characterId: target.id,
    });
    assert.equal(archived.ok, true);
    assert(archived.entity.archivedAt, "archived entity carries archivedAt");
    assert.equal(repository.listCharacters(OWNER).length, 1, "archived rows leave the default list");
    // History of the archived copy stays readable (append-only revisions).
    const history = await handlers.get("character:history")(trustedEvent(), { characterId: target.id });
    assert.equal(history.ok, true);

    const unknown = await handlers.get("character:archive")(trustedEvent(), {
      characterId: crypto.randomUUID(),
    });
    assert.deepEqual(unknown, { ok: false, error: "CHARACTER_NOT_FOUND" });
  });

  // --- persona + world-book lifecycle -----------------------------------------

  let persona;
  await check("persona:create/update-revision/archive over the bridge", async () => {
    const created = await handlers.get("persona:create")(trustedEvent(), {
      canonical: { name: "Aurelia", description: "Harbor cartographer." },
      ownerScope: OTHER_OWNER,
    });
    assert.equal(created.ok, true);
    assert.equal(created.revision.revisionNumber, 1);
    persona = { entity: created.entity, revision: created.revision };

    const read = await handlers.get("persona:get-revision")(trustedEvent(), {
      revisionId: persona.revision.id,
    });
    assert.equal(read.ok, true);
    assert.equal(read.revision.canonical.description, "Harbor cartographer.");

    const edited = await handlers.get("persona:update-revision")(trustedEvent(), {
      personaId: persona.entity.id,
      expectedBaseRevisionId: persona.revision.id,
      canonical: { name: "Aurelia", description: "Tide-locked." },
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.revision.revisionNumber, 2);

    const stale = await handlers.get("persona:update-revision")(trustedEvent(), {
      personaId: persona.entity.id,
      expectedBaseRevisionId: persona.revision.id,
      canonical: { name: "Aurelia" },
    });
    assert.deepEqual(stale, { ok: false, error: "PERSONA_REVISION_CONFLICT" });

    const history = await handlers.get("persona:history")(trustedEvent(), {
      personaId: persona.entity.id,
    });
    assert.equal(history.ok, true);
    assert.equal(history.revisions.length, 2);

    // Authorization-shaped fields are rejected by the persona model (§7.3).
    const hostile = await handlers.get("persona:create")(trustedEvent(), {
      canonical: { name: "Bad", role: "admin" },
    });
    assert.equal(hostile.ok, false);
    assert.match(hostile.error, /^PERSONA_/, "persona model code crosses the bridge");

    const archived = await handlers.get("persona:archive")(trustedEvent(), {
      personaId: persona.entity.id,
    });
    assert.equal(archived.ok, true);
    assert(archived.entity.archivedAt);
  });

  let book;
  await check("world-book:create/archive over the bridge", async () => {
    const created = await handlers.get("world-book:create")(trustedEvent(), {
      canonical: { name: "Atlas", entries: [] },
      ownerScope: OTHER_OWNER,
    });
    assert.equal(created.ok, true);
    assert.equal(created.revision.revisionNumber, 1);
    book = created;

    const invalid = await handlers.get("world-book:create")(trustedEvent(), {
      canonical: { name: "Bad", entries: "not-an-array" },
    });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /^WORLD_BOOK_/, "world-book model code crosses the bridge");

    const history = await handlers.get("world-book:history")(trustedEvent(), {
      worldBookId: book.entity.id,
    });
    assert.equal(history.ok, true);
    assert.equal(history.revisions.length, 1);

    const archived = await handlers.get("world-book:archive")(trustedEvent(), {
      worldBookId: book.entity.id,
    });
    assert.equal(archived.ok, true);
    assert(archived.entity.archivedAt);

    const unknown = await handlers.get("world-book:archive")(trustedEvent(), {
      worldBookId: crypto.randomUUID(),
    });
    assert.deepEqual(unknown, { ok: false, error: "WORLD_BOOK_NOT_FOUND" });
  });

  // --- rollout policy gate ------------------------------------------------------

  await check("disabled policy gates EVERY authoring mutation but no read channel", async () => {
    ctx.characterWorldsPolicy = () => ({ enabled: false, reason: "kill_switch" });
    try {
      for (const channel of MUTATION_CHANNELS) {
        const result = await handlers.get(channel)(trustedEvent(), samplePayload(channel, {
          characterId: character.entity.id,
          revisionId: character.revision.id,
        }));
        assert.deepEqual(
          result,
          { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" },
          `${channel} gated (archive is a mutation and stays gated; no unarchive exists)`,
        );
      }
      const history = await handlers.get("character:history")(trustedEvent(), {
        characterId: character.entity.id,
      });
      assert.equal(history.ok, true, "history stays readable under a disabled policy");
      const read = await handlers.get("character:get-revision")(trustedEvent(), {
        revisionId: character.revision.id,
      });
      assert.equal(read.ok, true, "revision reads stay available under a disabled policy");
      const personaHistory = await handlers.get("persona:history")(trustedEvent(), {
        personaId: persona.entity.id,
      });
      assert.equal(personaHistory.ok, true);
      const bookHistory = await handlers.get("world-book:history")(trustedEvent(), {
        worldBookId: book.entity.id,
      });
      assert.equal(bookHistory.ok, true);
    } finally {
      ctx.characterWorldsPolicy = () => ({ enabled: true, compatibilityProfile: "lily-character-compat-1" });
    }
  });

  await check("non-whitelisted error codes collapse; startup failure fails closed", async () => {
    const leaky = {
      authoring: {
        createCharacter: async () => {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        },
      },
    };
    ctx.characterWorldsService = leaky;
    try {
      const result = await handlers.get("character:create")(trustedEvent(), {
        canonical: { name: "A" },
      });
      assert.deepEqual(result, { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" });
      assert(!JSON.stringify(result).includes("locked"), "no internal detail crosses the bridge");
    } finally {
      ctx.characterWorldsService = service;
    }

    ctx.characterWorldsService = null;
    ctx.characterWorldsRepository = null;
    try {
      for (const channel of CHANNELS) {
        const result = await handlers.get(channel)(trustedEvent(), samplePayload(channel));
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

  console.log(`character-authoring-ipc: ok (${checks} checks)`);
} finally {
  Module._load = originalLoad;
  try {
    await service.close();
  } catch {
    // best-effort cleanup
  }
}
