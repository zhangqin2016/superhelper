#!/usr/bin/env node
// Character Worlds world-book IPC contract (Phase 2A, Task WB-6; design spec
// §15/§16, HANDOFF.md §5/§6).
//
// Verifies the READ-ONLY book inspection surface on the trusted bridge:
//   - exactly three book channels (world-book:list/get/get-revision), exposed
//     through the same frozen preload facade as the eight Phase 1 channels
//   - NO renderer mutation path for books in Phase 2A: no create/update/
//     delete/archive/import channel exists and the facade has no such method
//   - owner scope is derived in main; renderer-supplied owner/account IDs are
//     ignored; books of another owner are invisible
//   - payloads/IDs are bounded, errors are stable renderer-safe codes, and NO
//     raw card content crosses the bridge: entry content, activation keys,
//     preserved payloads, and decorator raw lines stay in the main process —
//     the renderer receives ids, counts, enums, and hashes only
//   - the rollout policy gates selection/import only: book reads stay
//     readable when the policy is disabled (matching character list/get)
//
// Run: node scripts/test-character-world-book-ipc.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);

const BOOK_CHANNELS = {
  listWorldBooks: "world-book:list",
  getWorldBook: "world-book:get",
  getWorldBookRevision: "world-book:get-revision",
};
const PHASE_ONE_CHANNELS = [
  "character:list",
  "character:get",
  "character:import-preview",
  "character:import-commit",
  "character:export",
  "session-character:get-binding",
  "session-character:set-binding",
  "session-character:get-events",
];
// Phase 2A ships no book mutation surface; any of these would be a finding.
const FORBIDDEN_CHANNEL_PATTERN = /^world-book:(create|update|delete|archive|import|set|mutate)/;

// Sentinel strings that live ONLY in stored book content/keys. They must
// never appear in any bridge response.
const SENTINELS = ["ZQXWV-7781", "SECRET-LORE-DO-NOT-LEAK-4492", "moon-vault"];

// --- electron mock (mirrors test-character-worlds-ipc.mjs) -------------------

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-world-book-ipc-"));

const { MessageStore } = require("../src/main/store/message-store.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");

const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = new CharacterWorldsRepository(store);

let policyEnabled = true;
const ctx = {
  mainWindow,
  characterWorldsService: null,
  characterWorldsRepository: repository,
  resolveCharacterOwnerScope: () => OWNER,
  characterWorldsPolicy: () => (
    policyEnabled
      ? { enabled: true, compatibilityProfile: "lily-character-compat-1" }
      : { enabled: false, reason: "kill_switch" }
  ),
  sessionManager: {
    resolveTurnOwnerScope() {
      return Object.freeze({ ok: false, error: "NO_SESSION", ownerScope: null });
    },
  },
};

function sourceOf(name) {
  return {
    kind: "imported",
    format: "character_card_v3",
    container: "json",
    originalFileName: `${name}.json`,
  };
}

// Book A exercises every report dimension: constant/keyed entries, applied
// and inert V3 decorators, inert regex activation, an unsupported (safe
// behavior) position, and preserved extensions.
const bookA = repository.createWorldBook({
  ownerScope: OWNER,
  canonical: {
    schemaVersion: 1,
    name: "Atlas of Alderan",
    entries: [
      {
        id: "e-constant",
        content: "The silver sentinel ZQXWV-7781 guards the gate.",
        activation: { constant: true },
        insertion: { position: "before_character" },
      },
      {
        id: "e-keyed",
        content: "SECRET-LORE-DO-NOT-LEAK-4492",
        activation: {
          primaryKeys: ["moon-vault"],
          secondaryKeys: ["silver"],
          selective: true,
          selectiveLogic: "and_any",
          probability: 50,
        },
      },
      {
        id: "e-decorator",
        content: "@@activate\n@@position after_character\nDecorator body.",
      },
      {
        id: "e-inert",
        content: "@@totally_unknown_decorator foo\nInert body text.",
      },
      {
        id: "e-regex",
        content: "Regex-gated lore.",
        activation: { useRegex: true, primaryKeys: ["vault-\\d+"] },
      },
      {
        id: "e-depth",
        content: "Depth lore.",
        activation: { constant: true },
        insertion: { position: "at_depth", depth: 2 },
      },
      {
        id: "e-ext",
        content: "Extension lore.",
        preservedExtensions: { automation_id: "auto-1" },
      },
    ],
  },
  source: sourceOf("atlas"),
});

// Book B crosses the entry-summary cap so the bridge must truncate.
const BULK_ENTRY_COUNT = 520;
const bookB = repository.createWorldBook({
  ownerScope: OWNER,
  canonical: {
    schemaVersion: 1,
    name: "Bulk Compendium",
    entries: Array.from({ length: BULK_ENTRY_COUNT }, (_, index) => ({
      id: `bulk-${index}`,
      content: `bulk lore ${index}`,
    })),
  },
  source: sourceOf("bulk"),
});

// Book C is archived: hidden from list, still readable by id.
const bookC = repository.createWorldBook({
  ownerScope: OWNER,
  canonical: { schemaVersion: 1, name: "Retired Lore", entries: [] },
  source: sourceOf("retired"),
});
repository.archiveWorldBook(OWNER, bookC.entity.id);

// Another owner's book must be invisible through this bridge.
const foreignBook = repository.createWorldBook({
  ownerScope: OTHER_OWNER,
  canonical: { schemaVersion: 1, name: "Foreign Lore", entries: [] },
  source: sourceOf("foreign"),
});

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok - ${name}`);
}

function assertNoSentinels(value, label) {
  const serialized = JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `${label}: raw book content never crosses the bridge (${JSON.stringify(sentinel)})`,
    );
  }
  assert.equal(serialized.includes(OWNER), false, `${label}: owner scope never crosses the bridge`);
  assert.equal(serialized.includes(OTHER_OWNER), false, `${label}: foreign owner never crosses the bridge`);
}

const { registerCharacterWorldsHandlers } = require("../src/main/ipc-character-worlds.js");

try {
  console.log("character-world-book-ipc:");

  registerCharacterWorldsHandlers(ctx);
  // Load the real preload against the electron mock to capture the bridge.
  require("../src/preload.js");

  await check("exactly three read-only book channels are registered, and no mutation channel exists", async () => {
    for (const channel of Object.values(BOOK_CHANNELS)) {
      assert.equal(typeof handlers.get(channel), "function", `${channel} handler registered`);
    }
    for (const channel of PHASE_ONE_CHANNELS) {
      assert.equal(typeof handlers.get(channel), "function", `${channel} still registered`);
    }
    assert.equal(handlers.size, PHASE_ONE_CHANNELS.length + 7, "no additional channels");
    for (const channel of handlers.keys()) {
      assert.equal(
        FORBIDDEN_CHANNEL_PATTERN.test(channel),
        false,
        `Phase 2A exposes no book mutation channel (${channel})`,
      );
    }
  });

  await check("preload facade is frozen with exactly the twenty-eight methods and no book edit channel", async () => {
    const facade = exposed.assistantClient?.characterWorlds;
    assert(facade, "characterWorlds facade exposed");
    assert(Object.isFrozen(facade), "facade is frozen");
    assert.deepEqual(
      Object.keys(facade).sort(),
      [
        "commitCharacterImport",
        "exportCharacter",
        "getCharacter",
        "getSessionCharacterBinding",
        "getSessionCharacterEvents",
        "getWorldBook",
        "getWorldBookRevision",
        "listCharacters",
        "listPersonas",
        "getPersona",
        "listWorldBooks",
        "previewCharacterImport",
        "setSessionCharacterBinding",
        // Phase 2B (P2B-4) authoring surface — see test-character-authoring-ipc.mjs.
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
        "getScene",
        "updateScene",
      ].sort(),
    );
    // Phase 2B deliberately ships NO world-book edit/restore/duplicate
    // channel: books are created blank or imported; entry-level editing is a
    // later phase. Assert the absence so it cannot sneak in unnoticed.
    for (const method of ["updateWorldBookRevision", "restoreWorldBookRevision", "duplicateWorldBook"]) {
      assert.equal(typeof facade[method], "undefined", `no ${method} on the facade`);
    }
  });

  await check("preload wrappers invoke the book channels with whitelisted payloads only", async () => {
    const facade = exposed.assistantClient.characterWorlds;
    invokeCalls.length = 0;
    await facade.listWorldBooks();
    await facade.getWorldBook("book-1");
    await facade.getWorldBookRevision("book-rev-1");
    assert.deepEqual(
      invokeCalls.map((call) => call.channel),
      ["world-book:list", "world-book:get", "world-book:get-revision"],
    );
    assert.equal(invokeCalls[0].payload, undefined, "listWorldBooks takes no payload");
    assert.deepEqual(invokeCalls[1].payload, { worldBookId: "book-1" });
    assert.deepEqual(invokeCalls[2].payload, { revisionId: "book-rev-1" });
    const serialized = JSON.stringify(invokeCalls);
    assert(!serialized.includes("ownerScope"), "bridge never forwards owner scope");
    assert(!/outputPath|destinationPath|sourcePath|filePath/.test(serialized), "bridge never forwards paths");
  });

  await check("untrusted senders and remote frames are rejected on every book channel", async () => {
    const before = repository.listWorldBooks(OWNER).length;
    for (const channel of Object.values(BOOK_CHANNELS)) {
      const payload = { worldBookId: bookA.entity.id, revisionId: bookA.revision.id };
      const fromStranger = await handlers.get(channel)(untrustedEvent(), payload);
      assert.deepEqual(fromStranger, { ok: false, error: "UNTRUSTED_SENDER" }, `${channel} stranger`);
      const fromRemoteFrame = await handlers.get(channel)(remoteFrameEvent(), payload);
      assert.deepEqual(fromRemoteFrame, { ok: false, error: "UNTRUSTED_SENDER" }, `${channel} remote frame`);
      const noEvent = await handlers.get(channel)(null, payload);
      assert.deepEqual(noEvent, { ok: false, error: "UNTRUSTED_SENDER" }, `${channel} missing event`);
    }
    assert.equal(repository.listWorldBooks(OWNER).length, before, "no side effects");
  });

  await check("world-book:list returns whitelisted summaries with the owner derived in main", async () => {
    const listed = await handlers.get("world-book:list")(trustedEvent(), {
      ownerScope: OTHER_OWNER,
      accountId: "attacker",
    });
    assert.equal(listed.ok, true);
    assert.equal(listed.worldBooks.length, 2, "archived books are hidden by default");
    const atlas = listed.worldBooks.find((book) => book.id === bookA.entity.id);
    assert(atlas, "book A listed");
    assert.deepEqual(
      Object.keys(atlas).sort(),
      ["archivedAt", "currentRevisionId", "entryCount", "id", "name"].sort(),
      "summary carries exactly the whitelisted fields",
    );
    assert.equal(atlas.name, "Atlas of Alderan");
    assert.equal(atlas.entryCount, 7);
    assert.equal(atlas.currentRevisionId, bookA.revision.id);
    assert.equal(atlas.archivedAt, null);
    const bulk = listed.worldBooks.find((book) => book.id === bookB.entity.id);
    assert.equal(bulk.entryCount, BULK_ENTRY_COUNT);
    assertNoSentinels(listed, "world-book:list");
  });

  await check("world-book:list never leaks another owner's books", async () => {
    const listed = await handlers.get("world-book:list")(trustedEvent(), {});
    assert.equal(
      listed.worldBooks.some((book) => book.id === foreignBook.entity.id),
      false,
      "foreign owner's book is invisible",
    );
    const original = ctx.resolveCharacterOwnerScope;
    ctx.resolveCharacterOwnerScope = () => OTHER_OWNER;
    try {
      const foreign = await handlers.get("world-book:list")(trustedEvent(), {});
      assert.equal(foreign.ok, true);
      assert.equal(foreign.worldBooks.length, 1, "the resolved owner sees only their own books");
      assert.equal(foreign.worldBooks[0].id, foreignBook.entity.id);
    } finally {
      ctx.resolveCharacterOwnerScope = original;
    }
  });

  await check("world-book:get returns entity + current revision metadata + compatibility/decorator report", async () => {
    const fetched = await handlers.get("world-book:get")(trustedEvent(), {
      worldBookId: bookA.entity.id,
      ownerScope: OTHER_OWNER,
    });
    assert.equal(fetched.ok, true);
    const detail = fetched.worldBook;
    assert.equal(detail.id, bookA.entity.id);
    assert.equal(detail.name, "Atlas of Alderan");
    assert.equal(detail.entryCount, 7);
    assert.equal(detail.currentRevisionId, bookA.revision.id);
    const revision = detail.revision;
    assert(revision, "current revision metadata present");
    assert.deepEqual(
      Object.keys(revision).sort(),
      ["contentHash", "createdAt", "id", "revisionHash", "revisionNumber", "source", "worldBookId"].sort(),
      "revision metadata is whitelisted",
    );
    assert.equal(revision.id, bookA.revision.id);
    assert.equal(revision.worldBookId, bookA.entity.id);
    assert.equal(revision.revisionNumber, 1);
    assert.match(revision.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(revision.revisionHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(
      Object.keys(revision.source).sort(),
      ["container", "format", "kind"].sort(),
      "source provenance is whitelisted (no file names or paths)",
    );
    const report = detail.report;
    assert(report, "compatibility/decorator report present");
    assert.equal(report.entryCount, 7);
    assert.equal(report.enabledCount, 7);
    assert.equal(report.constantCount, 2, "e-constant + e-depth are constant");
    assert.equal(report.appliedDecoratorCount, 2, "@@activate + @@position applied");
    assert.equal(report.inertDecoratorCount, 1, "the unknown decorator stayed inert");
    assert.equal(report.preservedDecoratorEntryCount, 1);
    assert.equal(report.preservedExtensionEntryCount, 1);
    assert.equal(report.safeBehaviorPositionCount, 1, "at_depth maps to the safe-behavior bucket");
    assert.equal(report.regexEntryCount, 1, "regex entries are reported inert in Phase 2A");
    assert.equal(report.vectorizedEntryCount, 0);
    assertNoSentinels(fetched, "world-book:get");
    assert.ok(
      Buffer.byteLength(JSON.stringify(fetched), "utf8") <= 16 * 1024,
      "world-book:get payload is bounded",
    );
  });

  await check("world-book:get fails with stable codes and bounds ids/payloads", async () => {
    const missing = await handlers.get("world-book:get")(trustedEvent(), {
      worldBookId: crypto.randomUUID(),
    });
    assert.deepEqual(missing, { ok: false, error: "WORLD_BOOK_NOT_FOUND" });

    const foreign = await handlers.get("world-book:get")(trustedEvent(), {
      worldBookId: foreignBook.entity.id,
    });
    assert.deepEqual(foreign, { ok: false, error: "WORLD_BOOK_NOT_FOUND" }, "cross-owner reads fail closed");

    for (const bad of ["x".repeat(200), "../secrets", { id: "x" }, ""]) {
      const invalid = await handlers.get("world-book:get")(trustedEvent(), { worldBookId: bad });
      assert.deepEqual(invalid, { ok: false, error: "INVALID_INPUT" }, `id ${JSON.stringify(bad)}`);
    }

    const huge = await handlers.get("world-book:get")(trustedEvent(), {
      worldBookId: bookA.entity.id,
      pad: "x".repeat(32 * 1024),
    });
    assert.deepEqual(huge, { ok: false, error: "INVALID_INPUT" });
  });

  await check("world-book:get-revision returns bounded entry summaries with decorator info", async () => {
    const fetched = await handlers.get("world-book:get-revision")(trustedEvent(), {
      revisionId: bookA.revision.id,
      ownerScope: OTHER_OWNER,
    });
    assert.equal(fetched.ok, true);
    const revision = fetched.revision;
    assert.equal(revision.id, bookA.revision.id);
    assert.equal(revision.entryCount, 7);
    assert.equal(revision.truncated, false);
    assert.equal(revision.entries.length, 7);
    for (const entry of revision.entries) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        [
          "appliedDecorators",
          "constant",
          "enabled",
          "hasPreservedExtensions",
          "id",
          "inertDecoratorCount",
          "order",
          "position",
          "primaryKeyCount",
          "probability",
          "secondaryKeyCount",
          "selective",
        ].sort(),
        "entry summary carries exactly the whitelisted fields",
      );
    }
    const keyed = revision.entries.find((entry) => entry.id === "e-keyed");
    assert.equal(keyed.primaryKeyCount, 1);
    assert.equal(keyed.secondaryKeyCount, 1);
    assert.equal(keyed.selective, true);
    assert.equal(keyed.probability, 50);
    const decorated = revision.entries.find((entry) => entry.id === "e-decorator");
    assert.deepEqual(decorated.appliedDecorators, ["activate", "position"]);
    assert.equal(decorated.inertDecoratorCount, 0);
    assert.equal(decorated.position, "after_character", "the applied @@position shows in the summary");
    const inert = revision.entries.find((entry) => entry.id === "e-inert");
    assert.deepEqual(inert.appliedDecorators, []);
    assert.equal(inert.inertDecoratorCount, 1);
    const extension = revision.entries.find((entry) => entry.id === "e-ext");
    assert.equal(extension.hasPreservedExtensions, true);
    assertNoSentinels(fetched, "world-book:get-revision");
  });

  await check("world-book:get-revision caps entry summaries and reports truncation", async () => {
    const fetched = await handlers.get("world-book:get-revision")(trustedEvent(), {
      revisionId: bookB.revision.id,
    });
    assert.equal(fetched.ok, true);
    assert.equal(fetched.revision.entryCount, BULK_ENTRY_COUNT);
    assert.equal(fetched.revision.entries.length, 200, "entry summaries are capped");
    assert.equal(fetched.revision.truncated, true);
    assert.ok(
      Buffer.byteLength(JSON.stringify(fetched), "utf8") <= 64 * 1024,
      "capped revision payload stays bounded",
    );
  });

  await check("world-book:get-revision fails with stable codes", async () => {
    const missing = await handlers.get("world-book:get-revision")(trustedEvent(), {
      revisionId: crypto.randomUUID(),
    });
    assert.deepEqual(missing, { ok: false, error: "WORLD_BOOK_REVISION_NOT_FOUND" });

    const foreign = await handlers.get("world-book:get-revision")(trustedEvent(), {
      revisionId: foreignBook.revision.id,
    });
    assert.deepEqual(foreign, { ok: false, error: "WORLD_BOOK_REVISION_NOT_FOUND" }, "cross-owner reads fail closed");

    const bad = await handlers.get("world-book:get-revision")(trustedEvent(), { revisionId: "../x" });
    assert.deepEqual(bad, { ok: false, error: "INVALID_INPUT" });
  });

  await check("a missing current revision degrades to metadata-free detail, never an error", async () => {
    const original = ctx.characterWorldsRepository;
    ctx.characterWorldsRepository = {
      listWorldBooks: (owner) => repository.listWorldBooks(owner),
      getWorldBook: () => bookA.entity,
      getWorldBookRevision: () => null,
    };
    try {
      const listed = await handlers.get("world-book:list")(trustedEvent(), {});
      assert.equal(listed.ok, true, "list still succeeds when a revision row is unreadable");
      const detail = await handlers.get("world-book:get")(trustedEvent(), {
        worldBookId: bookA.entity.id,
      });
      assert.equal(detail.ok, true);
      assert.equal(detail.worldBook.entryCount, null);
      assert.equal(detail.worldBook.revision, null);
      assert.equal(detail.worldBook.report, null);
    } finally {
      ctx.characterWorldsRepository = original;
    }
  });

  await check("disabled rollout policy keeps book reads readable (selection gate only)", async () => {
    policyEnabled = false;
    try {
      const listed = await handlers.get("world-book:list")(trustedEvent(), {});
      assert.equal(listed.ok, true, "list stays readable under a disabled policy");
      assert.equal(listed.worldBooks.length, 2);
      const detail = await handlers.get("world-book:get")(trustedEvent(), {
        worldBookId: bookA.entity.id,
      });
      assert.equal(detail.ok, true, "get stays readable under a disabled policy");
      const revision = await handlers.get("world-book:get-revision")(trustedEvent(), {
        revisionId: bookA.revision.id,
      });
      assert.equal(revision.ok, true, "get-revision stays readable under a disabled policy");
    } finally {
      policyEnabled = true;
    }
  });

  await check("startup construction failure (null repository) fails closed on every book channel", async () => {
    const original = ctx.characterWorldsRepository;
    ctx.characterWorldsRepository = null;
    try {
      const payloads = {
        "world-book:list": {},
        "world-book:get": { worldBookId: bookA.entity.id },
        "world-book:get-revision": { revisionId: bookA.revision.id },
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
      ctx.characterWorldsRepository = original;
    }
  });

  await check("repository errors map to renderer-safe codes (domain passes, foreign collapses)", async () => {
    const original = ctx.characterWorldsRepository;
    ctx.characterWorldsRepository = {
      getWorldBook: () => {
        throw Object.assign(new Error(`boom ${path.join(tmp, "local-secret-path")}`), {
          code: "SQLITE_BUSY",
        });
      },
    };
    try {
      const collapsed = await handlers.get("world-book:get")(trustedEvent(), {
        worldBookId: bookA.entity.id,
      });
      assert.deepEqual(collapsed, { ok: false, error: "CHARACTER_WORLDS_UNAVAILABLE" });
      assert(!JSON.stringify(collapsed).includes("local-secret-path"), "no internal detail crosses");
    } finally {
      ctx.characterWorldsRepository = original;
    }

    ctx.characterWorldsRepository = {
      getWorldBook: () => {
        throw Object.assign(new Error("stored book payload is not plain data"), {
          code: "WORLD_BOOK_DATA_INVALID",
        });
      },
    };
    try {
      const domain = await handlers.get("world-book:get")(trustedEvent(), {
        worldBookId: bookA.entity.id,
      });
      assert.deepEqual(domain, { ok: false, error: "WORLD_BOOK_DATA_INVALID" });
      assert(!domain.message && !domain.stack, "no message/stack crosses the bridge");
    } finally {
      ctx.characterWorldsRepository = original;
    }
  });

  console.log(`character-world-book-ipc: ok (${checks} checks)`);
} finally {
  Module._load = originalLoad;
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
