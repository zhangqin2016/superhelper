// Character Worlds validated authoring domain APIs (Phase 2B, Task P2B-3).
// One validated entry point (authoring-service.js) shared by IPC now and the
// agent draft path later: create/edit-as-new-revision with CAS, revision
// history, restore-as-new-revision, duplicate, archive, and reference-guarded
// delete (§18: no hard delete while references exist; GC is a later concern).
// Run: node scripts/test-character-authoring.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const {
  MAX_CHARACTER_TEXT_FIELD_BYTES,
} = require("../src/main/character-worlds/constants.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  CharacterAuthoringService,
} = require("../src/main/character-worlds/authoring-service.js");
const {
  CharacterWorldsService,
} = require("../src/main/character-worlds/service.js");
const {
  parseJsonCharacterCard,
} = require("../src/main/character-worlds/card-parser.js");

const OWNER = "profile:local";
const OTHER_OWNER = "profile:local:other";
const SESSION = "session-authoring";

let checks = 0;
async function check(name, fn) {
  const result = await fn();
  checks += 1;
  console.log(`ok - ${name}`);
  return result;
}

async function assertCodedRejection(promise, code, message) {
  await assert.rejects(
    promise,
    (error) => error.code === code,
    `${message || code} (got ${String(await promise.catch((e) => e?.code || e))})`,
  );
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-authoring-"));
const blobDir = path.join(tmp, "blobs");
const store = new MessageStore(path.join(tmp, "messages.db"), blobDir);
const repository = new CharacterWorldsRepository(store);
let currentOwner = OWNER;
const authoring = new CharacterAuthoringService({
  repository,
  resolveOwnerScope: async () => currentOwner,
});

const avatarBytes = Buffer.from("local-private-authoring-avatar");
const avatarHash = crypto.createHash("sha256").update(avatarBytes).digest("hex");
const avatarAsset = { purpose: "avatar", mime: "image/png", data: avatarBytes };

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

try {
  // --- createCharacter ---------------------------------------------------
  const luna = await check("createCharacter validates blank canonical and records provenance", async () => {
    const created = await authoring.createCharacter({
      ownerScope: OWNER,
      canonical: { name: "Luna", description: "Navigator" },
      assets: [avatarAsset],
    });
    assert.equal(created.ok, true);
    assert.equal(created.entity.displayName, "Luna");
    assert.equal(created.revision.revisionNumber, 1);
    assert.equal(created.revision.parentRevisionId, null);
    assert.equal(created.revision.source.kind, "created");
    assert.equal(created.revision.source.format, "lily");
    // Blank input is normalized to the full canonical field set (mapCanonical shape).
    assert.equal(created.revision.canonical.schemaVersion, 1);
    assert.equal(created.revision.canonical.name, "Luna");
    assert.equal(created.revision.canonical.firstMessage, "");
    assert.deepEqual(created.revision.canonical.tags, []);
    assert.deepEqual(created.revision.cardAssets.map((a) => a.hash), [avatarHash]);
    return created;
  });

  await check("createCharacter rejects hostile input with the import model's codes", async () => {
    // Direct equivalence: the same hostile value produces the same code
    // through the import parser and through authoring validation.
    const oversizedName = "x".repeat(MAX_CHARACTER_TEXT_FIELD_BYTES + 1);
    let importCode = null;
    try {
      parseJsonCharacterCard(Buffer.from(JSON.stringify({ name: oversizedName })));
    } catch (error) {
      importCode = error.code;
    }
    assert.equal(importCode, "CARD_LIMIT_EXCEEDED");
    await assertCodedRejection(
      authoring.createCharacter({ ownerScope: OWNER, canonical: { name: oversizedName } }),
      "CARD_LIMIT_EXCEEDED",
      "oversized name",
    );

    const dangerous = JSON.parse('{"__proto__":{"polluted":true},"name":"x"}');
    let importDangerousCode = null;
    try {
      parseJsonCharacterCard(Buffer.from('{"__proto__":{"polluted":true},"name":"x"}'));
    } catch (error) {
      importDangerousCode = error.code;
    }
    assert.equal(importDangerousCode, "CARD_DANGEROUS_KEY");
    await assertCodedRejection(
      authoring.createCharacter({ ownerScope: OWNER, canonical: dangerous }),
      "CARD_DANGEROUS_KEY",
      "dangerous key",
    );

    const cyclic = { name: "Cycle" };
    cyclic.self = cyclic;
    await assertCodedRejection(
      authoring.createCharacter({ ownerScope: OWNER, canonical: cyclic }),
      "CARD_JSON_INVALID",
      "cyclic canonical",
    );
    await assertCodedRejection(
      authoring.createCharacter({
        ownerScope: OWNER,
        canonical: new Proxy({ name: "Proxy" }, {}),
      }),
      "CARD_JSON_INVALID",
      "proxy canonical",
    );
    await assertCodedRejection(
      authoring.createCharacter({ ownerScope: OWNER, canonical: { name: "   " } }),
      "CARD_ROOT_INVALID",
      "blank name (import requires a non-empty name)",
    );
    await assertCodedRejection(
      authoring.createCharacter({ ownerScope: OWNER, canonical: { name: 42 } }),
      "CARD_JSON_INVALID",
      "non-string name",
    );
  });

  await check("executable-flagged unknown keys are dropped, import parity", async () => {
    // Import stance: executable keys classify as rejectedExecutable and never
    // enter the canonical. Authoring matches it and reports the drop.
    const parsed = parseJsonCharacterCard(Buffer.from(JSON.stringify({
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: "Scripted", script: "run()", plugins: ["evil"] },
    })));
    assert.equal(Object.hasOwn(parsed.canonical, "script"), false);
    assert.equal(Object.hasOwn(parsed.canonical, "plugins"), false);

    const created = await authoring.createCharacter({
      ownerScope: OWNER,
      canonical: { name: "Scripted", script: "run()", plugins: ["evil"], lore: "inert" },
    });
    assert.equal(Object.hasOwn(created.revision.canonical, "script"), false);
    assert.equal(Object.hasOwn(created.revision.canonical, "plugins"), false);
    assert.equal(created.revision.canonical.lore, "inert", "inert unknown keys stay preserved");
    assert.deepEqual(
      [...created.droppedExecutableKeys].sort(),
      ["plugins", "script"],
      "the drop is recorded for the caller",
    );
    const edited = await authoring.editCharacter({
      ownerScope: OWNER,
      entityId: created.entity.id,
      expectedBaseRevisionId: created.revision.id,
      canonical: { ...created.revision.canonical, quickReply: "x" },
    });
    assert.equal(Object.hasOwn(edited.revision.canonical, "quickReply"), false);
    assert.deepEqual(edited.droppedExecutableKeys, ["quickReply"]);
  });

  // --- createPersona / createWorldBook ------------------------------------
  const persona = await check("createPersona uses the persona model and records provenance", async () => {
    const created = await authoring.createPersona({
      ownerScope: OWNER,
      canonical: { name: "Aurelia", description: "Harbor cartographer." },
      assets: [avatarAsset],
    });
    assert.equal(created.ok, true);
    assert.equal(created.revision.revisionNumber, 1);
    assert.equal(created.revision.source.kind, "created");
    assert.equal(created.revision.source.format, "lily");
    assert.equal(created.revision.canonical.schemaVersion, 1);
    assert.equal(created.revision.avatarAssetId, avatarHash);
    return created;
  });

  await check("createPersona rejects authorization-shaped fields (persona model, unchanged)", async () => {
    await assertCodedRejection(
      authoring.createPersona({
        ownerScope: OWNER,
        canonical: { name: "Bad", role: "admin" },
      }),
      "PERSONA_DATA_INVALID",
      "authorization-shaped persona field",
    );
  });

  const book = await check("createWorldBook uses the world-book model and records provenance", async () => {
    const created = await authoring.createWorldBook({
      ownerScope: OWNER,
      canonical: {
        name: "Atlas",
        entries: [{ keys: ["harbor"], content: "The harbor never sleeps." }],
      },
    });
    assert.equal(created.ok, true);
    assert.equal(created.revision.revisionNumber, 1);
    assert.equal(created.revision.source.kind, "created");
    assert.equal(created.revision.source.format, "lily");
    assert.equal(created.revision.canonical.entries.length, 1);
    return created;
  });

  await check("createWorldBook rejects invalid entries (world-book model, unchanged)", async () => {
    await assertCodedRejection(
      authoring.createWorldBook({
        ownerScope: OWNER,
        canonical: { name: "Bad", entries: "not-an-array" },
      }),
      "WORLD_BOOK_DATA_INVALID",
      "non-array world book entries",
    );
  });

  // --- edit = new revision with CAS ----------------------------------------
  const lunaEdit = await check("editCharacter creates a new revision pinned to its parent", async () => {
    const edited = await authoring.editCharacter({
      ownerScope: OWNER,
      entityId: luna.entity.id,
      expectedBaseRevisionId: luna.revision.id,
      canonical: { ...luna.revision.canonical, description: "Storm navigator" },
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.revision.revisionNumber, 2);
    assert.equal(edited.revision.parentRevisionId, luna.revision.id);
    assert.equal(edited.revision.canonical.description, "Storm navigator");
    assert.equal(edited.revision.source.kind, "edited");
    assert.equal(edited.revision.source.format, "lily");
    const entity = repository.getCharacter(OWNER, luna.entity.id);
    assert.equal(entity.currentRevisionId, edited.revision.id);
    return edited;
  });

  await check("editCharacter with a stale base fails coded CHARACTER_REVISION_CONFLICT", async () => {
    await assert.rejects(
      authoring.editCharacter({
        ownerScope: OWNER,
        entityId: luna.entity.id,
        expectedBaseRevisionId: luna.revision.id, // stale: tip is now revision 2
        canonical: { ...luna.revision.canonical, description: "Conflicting" },
      }),
      (error) => (
        error.code === "CHARACTER_REVISION_CONFLICT"
        && error.currentRevisionId === lunaEdit.revision.id
      ),
      "stale base must report the current revision",
    );
  });

  await check("missing/empty ids fail coded, never TypeError", async () => {
    const cases = [
      [() => authoring.characterHistory({ ownerScope: OWNER, entityId: "" }), "CHARACTER_NOT_FOUND"],
      [() => authoring.editCharacter({
        ownerScope: OWNER, entityId: "", expectedBaseRevisionId: "x", canonical: {},
      }), "CHARACTER_NOT_FOUND"],
      [() => authoring.editCharacter({
        ownerScope: OWNER, entityId: luna.entity.id, expectedBaseRevisionId: "", canonical: {},
      }), "CHARACTER_REVISION_CONFLICT"],
      [() => authoring.restoreCharacterRevision({
        ownerScope: OWNER, entityId: "", revisionId: "x", expectedBaseRevisionId: "y",
      }), "CHARACTER_NOT_FOUND"],
      [() => authoring.restoreCharacterRevision({
        ownerScope: OWNER, entityId: luna.entity.id, revisionId: "", expectedBaseRevisionId: "y",
      }), "CHARACTER_REVISION_NOT_FOUND"],
      [() => authoring.restoreCharacterRevision({
        ownerScope: OWNER,
        entityId: luna.entity.id,
        revisionId: luna.revision.id,
        expectedBaseRevisionId: "  ",
      }), "CHARACTER_REVISION_CONFLICT"],
      [() => authoring.duplicateCharacter({ ownerScope: OWNER, entityId: null }), "CHARACTER_NOT_FOUND"],
      [() => authoring.archiveCharacter({ ownerScope: OWNER, entityId: "" }), "CHARACTER_NOT_FOUND"],
      [() => authoring.deleteCharacter({ ownerScope: OWNER, entityId: "" }), "CHARACTER_NOT_FOUND"],
      [() => authoring.editPersona({
        ownerScope: OWNER, entityId: persona.entity.id, expectedBaseRevisionId: null, canonical: {},
      }), "PERSONA_REVISION_CONFLICT"],
      [() => authoring.restorePersonaRevision({
        ownerScope: OWNER, entityId: persona.entity.id, revisionId: undefined, expectedBaseRevisionId: "y",
      }), "PERSONA_REVISION_NOT_FOUND"],
      [() => authoring.editWorldBook({
        ownerScope: OWNER, entityId: "  ", expectedBaseRevisionId: "x", canonical: {},
      }), "WORLD_BOOK_NOT_FOUND"],
      [() => authoring.restoreWorldBookRevision({
        ownerScope: OWNER,
        entityId: book.entity.id,
        revisionId: book.revision.id,
        expectedBaseRevisionId: "",
      }), "WORLD_BOOK_REVISION_CONFLICT"],
      [() => authoring.duplicateWorldBook({ ownerScope: OWNER, entityId: 0 }), "WORLD_BOOK_NOT_FOUND"],
    ];
    for (const [fn, code] of cases) {
      await assert.rejects(
        fn(),
        (error) => error.code === code && !(error instanceof TypeError),
        `expected coded ${code}, never a TypeError`,
      );
    }
  });

  await check("editPersona/editWorldBook share the same CAS discipline", async () => {
    const personaEdit = await authoring.editPersona({
      ownerScope: OWNER,
      entityId: persona.entity.id,
      expectedBaseRevisionId: persona.revision.id,
      canonical: { ...persona.revision.canonical, description: "Tide-locked." },
    });
    assert.equal(personaEdit.revision.revisionNumber, 2);
    assert.equal(personaEdit.revision.parentRevisionId, persona.revision.id);
    await assertCodedRejection(
      authoring.editPersona({
        ownerScope: OWNER,
        entityId: persona.entity.id,
        expectedBaseRevisionId: persona.revision.id,
        canonical: persona.revision.canonical,
      }),
      "PERSONA_REVISION_CONFLICT",
      "stale persona base",
    );

    const bookEdit = await authoring.editWorldBook({
      ownerScope: OWNER,
      entityId: book.entity.id,
      expectedBaseRevisionId: book.revision.id,
      canonical: {
        ...book.revision.canonical,
        entries: [{ keys: ["reef"], content: "The reef is charted." }],
      },
    });
    assert.equal(bookEdit.revision.revisionNumber, 2);
    assert.equal(bookEdit.revision.parentRevisionId, book.revision.id);
    await assertCodedRejection(
      authoring.editWorldBook({
        ownerScope: OWNER,
        entityId: book.entity.id,
        expectedBaseRevisionId: book.revision.id,
        canonical: book.revision.canonical,
      }),
      "WORLD_BOOK_REVISION_CONFLICT",
      "stale world book base",
    );
  });

  await check("editCharacter propagates the embedded world-book pin (WB-2)", async () => {
    const originalBytes = Buffer.from(
      '{"spec":"chara_card_v3","data":{"name":"Pinned","character_book":{"name":"Pin Book","entries":[{"keys":["tide"],"content":"Tide lore."}]}}}',
    );
    const originalHash = crypto.createHash("sha256").update(originalBytes).digest("hex");
    const imported = repository.importCharacter({
      ownerScope: OWNER,
      canonical: { schemaVersion: 1, name: "Pinned", description: "" },
      source: {
        kind: "imported",
        format: "v3_json",
        container: "json",
        original: {
          hash: originalHash,
          bytes: originalBytes.length,
          mime: "application/json",
          purpose: "character-card-original",
        },
        preserved: { schemaVersion: 1, data: { name: "Pinned" } },
      },
      assets: [{
        purpose: "character-card-original",
        mime: "application/json",
        data: originalBytes,
      }],
      characterBook: {
        canonical: {
          name: "Pin Book",
          entries: [{ keys: ["tide"], content: "Tide lore." }],
        },
      },
    });
    const pin = imported.revision.characterBookRevisionId;
    assert.ok(pin, "imported revision must pin its embedded book");
    const edited = await authoring.editCharacter({
      ownerScope: OWNER,
      entityId: imported.entity.id,
      expectedBaseRevisionId: imported.revision.id,
      canonical: { ...imported.revision.canonical, description: "Edited" },
    });
    assert.equal(
      edited.revision.characterBookRevisionId,
      pin,
      "edits keep the parent's embedded book pin",
    );
  });

  // --- revision history -----------------------------------------------------
  await check("characterHistory lists newest-first bounded metadata only", async () => {
    const history = await authoring.characterHistory({
      ownerScope: OWNER,
      entityId: luna.entity.id,
    });
    assert.equal(history.ok, true);
    assert.deepEqual(
      history.revisions.map((entry) => entry.revisionNumber),
      [2, 1],
      "newest-first",
    );
    const tip = history.revisions[0];
    assert.equal(tip.revisionId, lunaEdit.revision.id);
    assert.equal(typeof tip.revisionHash, "string");
    assert.equal(tip.revisionHash.startsWith("sha256:"), true);
    assert.equal(typeof tip.contentHash, "string");
    assert.equal(tip.sourceKind, "edited");
    assert.equal(history.revisions[1].sourceKind, "created");
    assert.equal(typeof tip.createdAt, "string");
    assert.equal(tip.parentRevisionId, luna.revision.id);
    assert.equal(
      Object.hasOwn(tip, "canonical"),
      false,
      "history is metadata only — no canonical payload by default",
    );
    const bounded = await authoring.characterHistory({
      ownerScope: OWNER,
      entityId: luna.entity.id,
      limit: 1,
    });
    assert.equal(bounded.revisions.length, 1, "history is bounded by limit");
    assert.equal(bounded.revisions[0].revisionNumber, 2);
  });

  await check("persona/world-book history mirrors the character shape", async () => {
    const personaHistory = await authoring.personaHistory({
      ownerScope: OWNER,
      entityId: persona.entity.id,
    });
    assert.deepEqual(
      personaHistory.revisions.map((entry) => entry.revisionNumber),
      [2, 1],
    );
    const bookHistory = await authoring.worldBookHistory({
      ownerScope: OWNER,
      entityId: book.entity.id,
    });
    assert.deepEqual(
      bookHistory.revisions.map((entry) => entry.revisionNumber),
      [2, 1],
    );
    await assertCodedRejection(
      authoring.characterHistory({ ownerScope: OWNER, entityId: crypto.randomUUID() }),
      "CHARACTER_NOT_FOUND",
      "history of an unknown entity",
    );
  });

  // --- restore-as-new-revision ----------------------------------------------
  const lunaRestore = await check("restore copies an old revision onto the tip with provenance", async () => {
    const restored = await authoring.restoreCharacterRevision({
      ownerScope: OWNER,
      entityId: luna.entity.id,
      revisionId: luna.revision.id, // restore revision 1 over the revision-2 tip
      expectedBaseRevisionId: lunaEdit.revision.id,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.revision.revisionNumber, 3);
    assert.equal(restored.revision.parentRevisionId, lunaEdit.revision.id);
    assert.equal(restored.revision.source.kind, "created");
    assert.equal(restored.revision.source.format, "lily");
    assert.equal(restored.revision.source.restoredFromRevisionId, luna.revision.id);
    assert.equal(
      restored.revision.contentHash,
      luna.revision.contentHash,
      "restored canonical is byte-identical to revision K",
    );
    assert.equal(stableJson(restored.revision.canonical), stableJson(luna.revision.canonical));
    // The restored avatar rides along: revision K's assets relink to N+1.
    assert.deepEqual(restored.revision.cardAssets.map((a) => a.hash), [avatarHash]);
    const entity = repository.getCharacter(OWNER, luna.entity.id);
    assert.equal(entity.currentRevisionId, restored.revision.id);
    return restored;
  });

  await check("restore dedup stays sound: an identical restore reuses its revision", async () => {
    const again = await authoring.restoreCharacterRevision({
      ownerScope: OWNER,
      entityId: luna.entity.id,
      revisionId: luna.revision.id,
      expectedBaseRevisionId: lunaRestore.revision.id,
    });
    assert.equal(
      again.revision.id,
      lunaRestore.revision.id,
      "same canonical + same provenance envelope dedupes to the same immutable revision",
    );
    const history = await authoring.characterHistory({
      ownerScope: OWNER,
      entityId: luna.entity.id,
    });
    assert.equal(history.revisions.length, 3, "no duplicate revision was written");
  });

  await check("restore with a stale base fails coded and writes nothing", async () => {
    await assertCodedRejection(
      authoring.restoreCharacterRevision({
        ownerScope: OWNER,
        entityId: luna.entity.id,
        revisionId: luna.revision.id,
        expectedBaseRevisionId: lunaEdit.revision.id, // stale: tip is the restore
      }),
      "CHARACTER_REVISION_CONFLICT",
      "stale restore base",
    );
    const history = await authoring.characterHistory({
      ownerScope: OWNER,
      entityId: luna.entity.id,
    });
    assert.equal(history.revisions.length, 3);
  });

  await check("restore works for personas and world books", async () => {
    const personaRestore = await authoring.restorePersonaRevision({
      ownerScope: OWNER,
      entityId: persona.entity.id,
      revisionId: persona.revision.id,
      expectedBaseRevisionId: (repository.getPersona(OWNER, persona.entity.id)).currentRevisionId,
    });
    assert.equal(personaRestore.revision.revisionNumber, 3);
    assert.equal(personaRestore.revision.contentHash, persona.revision.contentHash);
    assert.equal(personaRestore.revision.source.restoredFromRevisionId, persona.revision.id);
    assert.equal(
      personaRestore.revision.avatarAssetId,
      avatarHash,
      "restored persona revision relinks the avatar asset",
    );

    const bookRestore = await authoring.restoreWorldBookRevision({
      ownerScope: OWNER,
      entityId: book.entity.id,
      revisionId: book.revision.id,
      expectedBaseRevisionId: (repository.getWorldBook(OWNER, book.entity.id)).currentRevisionId,
    });
    assert.equal(bookRestore.revision.revisionNumber, 3);
    assert.equal(bookRestore.revision.contentHash, book.revision.contentHash);
    assert.equal(bookRestore.revision.source.restoredFromRevisionId, book.revision.id);
    await assertCodedRejection(
      authoring.restoreCharacterRevision({
        ownerScope: OWNER,
        entityId: luna.entity.id,
        revisionId: crypto.randomUUID(),
        expectedBaseRevisionId: lunaRestore.revision.id,
      }),
      "CHARACTER_REVISION_NOT_FOUND",
      "unknown restore source revision",
    );
  });

  // --- duplicate --------------------------------------------------------------
  await check("duplicate deep-copies the current revision as revision 1 of a new entity", async () => {
    const duplicate = await authoring.duplicateCharacter({
      ownerScope: OWNER,
      entityId: luna.entity.id,
    });
    assert.equal(duplicate.ok, true);
    assert.notEqual(duplicate.entity.id, luna.entity.id);
    assert.equal(duplicate.revision.revisionNumber, 1);
    assert.equal(duplicate.revision.parentRevisionId, null);
    // The tip is the restore (revision 1's canonical), so the copy matches it.
    assert.equal(duplicate.revision.contentHash, lunaRestore.revision.contentHash);
    assert.equal(duplicate.revision.source.kind, "created");
    assert.equal(duplicate.revision.source.format, "lily");
    assert.equal(duplicate.revision.source.duplicatedFromEntityId, luna.entity.id);
    assert.equal(
      duplicate.revision.source.duplicatedFromRevisionId,
      lunaRestore.revision.id,
    );
    assert.deepEqual(duplicate.revision.cardAssets.map((a) => a.hash), [avatarHash]);
    const history = await authoring.characterHistory({
      ownerScope: OWNER,
      entityId: duplicate.entity.id,
    });
    assert.equal(history.revisions.length, 1);
  });

  await check("duplicate works for personas (avatar relinked) and world books", async () => {
    const personaDuplicate = await authoring.duplicatePersona({
      ownerScope: OWNER,
      entityId: persona.entity.id,
    });
    assert.notEqual(personaDuplicate.entity.id, persona.entity.id);
    assert.equal(personaDuplicate.revision.revisionNumber, 1);
    assert.equal(personaDuplicate.revision.avatarAssetId, avatarHash);
    assert.equal(personaDuplicate.revision.source.duplicatedFromEntityId, persona.entity.id);

    const bookDuplicate = await authoring.duplicateWorldBook({
      ownerScope: OWNER,
      entityId: book.entity.id,
    });
    assert.notEqual(bookDuplicate.entity.id, book.entity.id);
    assert.equal(bookDuplicate.revision.revisionNumber, 1);
    assert.equal(bookDuplicate.revision.source.duplicatedFromEntityId, book.entity.id);
  });

  // --- archive (idempotent) ---------------------------------------------------
  await check("archive is idempotent and coded for unknown entities", async () => {
    const first = await authoring.archiveCharacter({
      ownerScope: OWNER,
      entityId: luna.entity.id,
    });
    assert.equal(first.ok, true);
    assert.ok(first.entity.archivedAt);
    const second = await authoring.archiveCharacter({
      ownerScope: OWNER,
      entityId: luna.entity.id,
    });
    assert.equal(
      second.entity.archivedAt,
      first.entity.archivedAt,
      "a second archive keeps the original archivedAt",
    );
    assert.equal(
      repository.listCharacters(OWNER).some((entity) => entity.id === luna.entity.id),
      false,
      "archived entities leave the default list",
    );
    await assertCodedRejection(
      authoring.archiveCharacter({ ownerScope: OWNER, entityId: crypto.randomUUID() }),
      "CHARACTER_NOT_FOUND",
      "archive of an unknown entity",
    );
    // Unarchive-by-edit is NOT a thing; archived stays archived until a
    // dedicated unarchive exists. Restoring data stays readable.
    assert.ok(repository.getCharacter(OWNER, luna.entity.id).archivedAt);
    // archive the other kinds too so delete tests below control references
    await authoring.archivePersona({ ownerScope: OWNER, entityId: persona.entity.id });
    await authoring.archiveWorldBook({ ownerScope: OWNER, entityId: book.entity.id });
  });

  // --- delete: no hard delete while references exist (§18) ---------------------
  const bound = await check("delete of a binding-referenced entity fails CHARACTER_ENTITY_IN_USE", async () => {
    const created = await authoring.createCharacter({
      ownerScope: OWNER,
      canonical: { name: "Bound Hero" },
    });
    repository.setBinding({
      sessionId: SESSION,
      ownerScope: OWNER,
      expectedBindingVersion: 0,
      next: { mode: "character", characterRevisionId: created.revision.id },
    });
    await assert.rejects(
      authoring.deleteCharacter({ ownerScope: OWNER, entityId: created.entity.id }),
      (error) => (
        error.code === "CHARACTER_ENTITY_IN_USE"
        && Array.isArray(error.references)
        && error.references.includes("session_binding")
      ),
      "binding reference must block hard delete",
    );
    return created;
  });

  await check("delete of a turn-snapshot-referenced entity fails CHARACTER_ENTITY_IN_USE", async () => {
    const created = await authoring.createCharacter({
      ownerScope: OWNER,
      canonical: { name: "Snapshotted Hero" },
    });
    repository.setBinding({
      sessionId: `${SESSION}-snapshot`,
      ownerScope: OWNER,
      expectedBindingVersion: 0,
      next: { mode: "character", characterRevisionId: created.revision.id },
    });
    // Persist an admitted turn carrying the binding snapshot through the
    // real admission path (which snapshots the binding into turn metadata).
    const admittedTurn = store.admitTurnInput(
      `${SESSION}-snapshot`,
      { turnId: "turn-authoring-snapshot", userText: "hello" },
      { ownerScope: OWNER },
    );
    assert.equal(
      admittedTurn.metadata.characterWorlds.characterRevisionId,
      created.revision.id,
    );
    // Drop the binding so ONLY the admitted turn snapshot references the revision.
    repository.setBinding({
      sessionId: `${SESSION}-snapshot`,
      ownerScope: OWNER,
      expectedBindingVersion: 1,
      next: { mode: "native" },
    });
    await assert.rejects(
      authoring.deleteCharacter({ ownerScope: OWNER, entityId: created.entity.id }),
      (error) => (
        error.code === "CHARACTER_ENTITY_IN_USE"
        && error.references.includes("turn_snapshot")
      ),
      "admitted turn snapshot must block hard delete",
    );
    return created;
  });

  await check("delete of a world book pinned by a character revision fails CHARACTER_ENTITY_IN_USE", async () => {
    const originalBytes = Buffer.from(
      '{"spec":"chara_card_v3","data":{"name":"Pin Holder","character_book":{"name":"Held Book","entries":[{"keys":["reef"],"content":"Reef lore."}]}}}',
    );
    const originalHash = crypto.createHash("sha256").update(originalBytes).digest("hex");
    const imported = repository.importCharacter({
      ownerScope: OWNER,
      canonical: { schemaVersion: 1, name: "Pin Holder", description: "" },
      source: {
        kind: "imported",
        format: "v3_json",
        container: "json",
        original: {
          hash: originalHash,
          bytes: originalBytes.length,
          mime: "application/json",
          purpose: "character-card-original",
        },
        preserved: { schemaVersion: 1, data: { name: "Pin Holder" } },
      },
      assets: [{
        purpose: "character-card-original",
        mime: "application/json",
        data: originalBytes,
      }],
      characterBook: {
        canonical: {
          name: "Held Book",
          entries: [{ keys: ["reef"], content: "Reef lore." }],
        },
      },
    });
    const bookEntityId = repository.getWorldBookRevision(
      OWNER, imported.revision.characterBookRevisionId,
    ).worldBookId;
    await assert.rejects(
      authoring.deleteWorldBook({ ownerScope: OWNER, entityId: bookEntityId }),
      (error) => (
        error.code === "CHARACTER_ENTITY_IN_USE"
        && error.references.includes("character_pin")
      ),
      "a character revision pin must block hard delete of the book",
    );
  });

  await check("persona binding references block persona delete", async () => {
    const created = await authoring.createPersona({
      ownerScope: OWNER,
      canonical: { name: "Bound Persona" },
    });
    repository.setBinding({
      sessionId: `${SESSION}-persona`,
      ownerScope: OWNER,
      expectedBindingVersion: 0,
      next: {
        mode: "character",
        characterRevisionId: bound.revision.id,
        personaRevisionId: created.revision.id,
      },
    });
    await assert.rejects(
      authoring.deletePersona({ ownerScope: OWNER, entityId: created.entity.id }),
      (error) => (
        error.code === "CHARACTER_ENTITY_IN_USE"
        && error.references.includes("session_binding")
      ),
      "persona pin in a binding must block hard delete",
    );
  });

  await check("a written world_book_checkpoints row blocks deleteWorldBook", async () => {
    const created = await authoring.createWorldBook({
      ownerScope: OWNER,
      canonical: { name: "Checkpointed Book", entries: [{ keys: ["cove"], content: "Cove lore." }] },
    });
    // The live per-session checkpoint table written on every successful
    // world-book turn must count as a reference (direct column probe).
    repository.writeWorldBookCheckpoint({
      ownerScope: OWNER,
      sessionId: `${SESSION}-checkpoint`,
      worldBookRevisionId: created.revision.id,
      checkpoint: { schemaVersion: 1, entries: {} },
      turnId: "turn-authoring-checkpoint",
    });
    await assert.rejects(
      authoring.deleteWorldBook({ ownerScope: OWNER, entityId: created.entity.id }),
      (error) => (
        error.code === "CHARACTER_ENTITY_IN_USE"
        && error.references.includes("world_book_checkpoint")
      ),
      "a world-book checkpoint must block hard delete",
    );
  });

  await check("restore/duplicate fail coded when revision asset bytes are missing", async () => {
    const doomedBytes = Buffer.from("doomed-avatar-bytes");
    const doomedHash = crypto.createHash("sha256").update(doomedBytes).digest("hex");
    const created = await authoring.createCharacter({
      ownerScope: OWNER,
      canonical: { name: "Doomed" },
      assets: [{ purpose: "avatar", mime: "image/png", data: doomedBytes }],
    });
    fs.rmSync(path.join(blobDir, doomedHash.slice(0, 2), doomedHash));
    const before = (await authoring.characterHistory({
      ownerScope: OWNER, entityId: created.entity.id,
    })).revisions.length;
    await assertCodedRejection(
      authoring.restoreCharacterRevision({
        ownerScope: OWNER,
        entityId: created.entity.id,
        revisionId: created.revision.id,
        expectedBaseRevisionId: created.revision.id,
      }),
      "CHARACTER_ASSET_UNAVAILABLE",
      "restore with missing blob bytes",
    );
    await assertCodedRejection(
      authoring.duplicateCharacter({ ownerScope: OWNER, entityId: created.entity.id }),
      "CHARACTER_ASSET_UNAVAILABLE",
      "duplicate with missing blob bytes",
    );
    const after = (await authoring.characterHistory({
      ownerScope: OWNER, entityId: created.entity.id,
    })).revisions.length;
    assert.equal(after, before, "no revision was written");
  });

  await check("unreferenced delete archives; hard delete is deferred GC (§18)", async () => {
    const created = await authoring.createCharacter({
      ownerScope: OWNER,
      canonical: { name: "Free Hero" },
    });
    const result = await authoring.deleteCharacter({
      ownerScope: OWNER,
      entityId: created.entity.id,
    });
    assert.equal(result.ok, true);
    assert.equal(result.archived, true);
    assert.equal(
      result.hardDelete,
      "deferred_gc",
      "revisions are immutable rows; physical GC is a separate later concern",
    );
    assert.ok(repository.getCharacter(OWNER, created.entity.id).archivedAt);
    assert.ok(
      repository.getRevision(OWNER, created.revision.id),
      "revisions stay readable after delete-as-archive",
    );
  });

  // --- admitted turn snapshots never mutate (§8) -------------------------------
  await check("edits never touch an admitted turn snapshot or a live binding pin", async () => {
    const created = await authoring.createCharacter({
      ownerScope: OWNER,
      canonical: { name: "Snapshot Hero" },
    });
    repository.setBinding({
      sessionId: `${SESSION}-pinned`,
      ownerScope: OWNER,
      expectedBindingVersion: 0,
      next: { mode: "character", characterRevisionId: created.revision.id },
    });
    // Admission snapshot taken BEFORE the edit, persisted by the real
    // admission path.
    const admittedTurn = store.admitTurnInput(
      `${SESSION}-pinned`,
      { turnId: "turn-authoring-pinned", userText: "hi" },
      { ownerScope: OWNER },
    );
    const admitted = admittedTurn.metadata.characterWorlds;
    assert.equal(admitted.snapshotStatus, "ready");
    assert.equal(admitted.characterRevisionId, created.revision.id);
    const metadataJson = store.db.get(
      "SELECT metadata_json FROM turn_inputs WHERE turn_id = ?",
      "turn-authoring-pinned",
    ).metadata_json;

    const edited = await authoring.editCharacter({
      ownerScope: OWNER,
      entityId: created.entity.id,
      expectedBaseRevisionId: created.revision.id,
      canonical: { ...created.revision.canonical, description: "Edited after admission" },
    });
    assert.equal(edited.revision.revisionNumber, 2);

    // The admitted snapshot bytes are untouched.
    const row = store.db.get(
      "SELECT metadata_json FROM turn_inputs WHERE turn_id = ?",
      "turn-authoring-pinned",
    );
    assert.equal(row.metadata_json, metadataJson, "admitted turn metadata is immutable");
    // The live binding still pins revision 1 (§8: applying an edit is explicit).
    const binding = repository.getBinding(`${SESSION}-pinned`, OWNER);
    assert.equal(binding.characterRevisionId, created.revision.id);
    // A new admission AFTER the edit still snapshots the pinned revision.
    const nextTurn = store.admitTurnInput(
      `${SESSION}-pinned`,
      { turnId: "turn-authoring-pinned-2", userText: "again" },
      { ownerScope: OWNER },
    );
    assert.equal(
      nextTurn.metadata.characterWorlds.characterRevisionId,
      created.revision.id,
      "a snapshot taken after the edit still pins the admitted revision",
    );
    assert.equal(
      nextTurn.metadata.characterWorlds.bindingVersion,
      admitted.bindingVersion,
    );
  });

  // --- owner scoping ------------------------------------------------------------
  await check("every operation is owner-scoped and coded", async () => {
    const created = await authoring.createWorldBook({
      ownerScope: OWNER,
      canonical: { name: "Owner Book" },
    });
    currentOwner = OTHER_OWNER;
    try {
      await assertCodedRejection(
        authoring.editWorldBook({
          ownerScope: OTHER_OWNER,
          entityId: created.entity.id,
          expectedBaseRevisionId: created.revision.id,
          canonical: created.revision.canonical,
        }),
        "WORLD_BOOK_NOT_FOUND",
        "cross-owner edit",
      );
      await assertCodedRejection(
        authoring.worldBookHistory({ ownerScope: OTHER_OWNER, entityId: created.entity.id }),
        "WORLD_BOOK_NOT_FOUND",
        "cross-owner history",
      );
      await assertCodedRejection(
        authoring.duplicateWorldBook({ ownerScope: OTHER_OWNER, entityId: created.entity.id }),
        "WORLD_BOOK_NOT_FOUND",
        "cross-owner duplicate",
      );
      await assertCodedRejection(
        authoring.archiveWorldBook({ ownerScope: OTHER_OWNER, entityId: created.entity.id }),
        "WORLD_BOOK_NOT_FOUND",
        "cross-owner archive",
      );
      await assertCodedRejection(
        authoring.deleteWorldBook({ ownerScope: OTHER_OWNER, entityId: created.entity.id }),
        "WORLD_BOOK_NOT_FOUND",
        "cross-owner delete",
      );
      await assertCodedRejection(
        authoring.createWorldBook({ ownerScope: OWNER, canonical: { name: "Mismatch" } }),
        "IMPORT_OWNER_MISMATCH",
        "caller owner must match the resolved owner scope",
      );
      // The other owner gets an independent namespace, not an error.
      const other = await authoring.createWorldBook({
        ownerScope: OTHER_OWNER,
        canonical: { name: "Other Book" },
      });
      assert.equal(other.entity.ownerScope, OTHER_OWNER);
    } finally {
      currentOwner = OWNER;
    }
  });

  // --- CharacterWorldsService wiring ---------------------------------------------
  await check("CharacterWorldsService exposes one shared authoring instance", async () => {
    const service = new CharacterWorldsService({
      messageStore: store,
      repository,
      resolveOwnerScope: async () => currentOwner,
      sourceAuthority: { read: async () => { throw new Error("unused"); } },
      destinationWriter: {
        write: async () => { throw new Error("unused"); },
        release: async () => {},
      },
      workerPool: { parse: async () => { throw new Error("unused"); }, close: async () => {} },
    });
    assert.ok(service.authoring instanceof CharacterAuthoringService);
    assert.equal(service.authoring.repository, repository);
    const created = await service.authoring.createPersona({
      ownerScope: OWNER,
      canonical: { name: "Wired Persona" },
    });
    assert.equal(created.ok, true);
    assert.equal(created.revision.source.kind, "created");
    await service.close();
  });

  console.log(`\n${checks} checks passed`);
} finally {
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
