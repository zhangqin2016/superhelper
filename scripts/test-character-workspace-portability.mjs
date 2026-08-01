// Character Worlds workspace portability (Phase 2C, Task P2C-2; spec §14.4).
// Export-side: from a project's sessions we collect ONLY the Character Worlds
// entities referenced by current bindings + admitted turn snapshots, and emit
// a bounded `character-worlds.json` pack section (canonical revisions + asset
// blob data, embedded world books). Import-side: entities get new local ids,
// character→book pins are remapped, bindings restore only when their
// referenced revisions imported (otherwise native + diagnostic), and the same
// hostile validation pipeline applies. No account data, credentials, absolute
// paths, runtime events, or unrelated library entries ever leave the machine.
// Run: node scripts/test-character-workspace-portability.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { MessageStore } = require("../src/main/store/message-store.js");
const {
  CharacterWorldsRepository,
} = require("../src/main/character-worlds/repository.js");
const {
  collectCharacterWorldsForExport,
  packCharacterWorldsSection,
  unpackCharacterWorldsSection,
  importCharacterWorldsPack,
  restoreBindingPreview,
} = require("../src/main/character-worlds/workspace-portability.js");

const OWNER = "profile:local";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-portability-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repo = new CharacterWorldsRepository(store);

let checks = 0;
async function check(name, fn) {
  const result = await fn();
  checks += 1;
  console.log(`ok - ${name}`);
  return result;
}

function createCharacter({ name, description = "A character", book = null }) {
  return repo.createCharacter({
    ownerScope: OWNER,
    canonical: { name, description },
    source: { format: "lily", container: "json", original: null },
    assets: [],
    characterBookRevisionId: book ? book.revision.id : null,
  });
}

function createPersona({ name, description = "A persona" }) {
  return repo.createPersona({
    ownerScope: OWNER,
    canonical: { name, description },
    source: { format: "lily", container: "json", original: null },
    assets: [],
  });
}

function bindCharacter(sessionId, revisionId) {
  return repo.setBinding({
    sessionId,
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: { mode: "character", characterRevisionId: revisionId },
  });
}

function bindPersona(sessionId, characterRevisionId, personaRevisionId) {
  return repo.setBinding({
    sessionId,
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: {
      mode: "character",
      characterRevisionId,
      personaRevisionId,
    },
  });
}

try {
  // --- export-side collection ----------------------------------------------

  await check("export collects ONLY entities referenced by bindings + snapshots", async () => {
    const referenced = createCharacter({ name: "Referenced Hero", description: "bound" });
    const unrelated = createCharacter({ name: "Unrelated Villain", description: "never bound" });
    const persona = createPersona({ name: "Nav Persona", description: "bound persona" });
    bindCharacter("session-a", referenced.revision.id);
    bindPersona("session-b", referenced.revision.id, persona.revision.id);

    const collected = collectCharacterWorldsForExport(repo, [
      { sessionId: "session-a", ownerScope: OWNER },
      { sessionId: "session-b", ownerScope: OWNER },
    ]);

    const kinds = collected.entities.map((e) => e.kind).sort();
    const names = collected.entities.map((e) => e.displayName).sort();
    assert.deepEqual(kinds, ["character", "persona"], "one character + one persona referenced");
    assert.deepEqual(names, ["Nav Persona", "Referenced Hero"]);
    assert.equal(
      names.includes("Unrelated Villain"),
      false,
      "an unreferenced library entry is NEVER packed",
    );
    assert.ok(collected.bindings.length >= 2, "both session bindings are recorded");
    assert.ok(collected.bindings.every((b) => !b.ownerScope), "bindings carry no owner scope");
  });

  await check("world book pinned by a character is packed as an embedded book, remapped on import", async () => {
    const book = repo.createWorldBook({
      ownerScope: OWNER,
      canonical: {
        name: "Harbor Atlas",
        groups: [{ name: "Places", entries: [{ key: "harbor", content: "A busy harbor." }] }],
      },
      source: { format: "lily", container: "json", original: null },
      assets: [],
    });
    const hero = createCharacter({ name: "Book Hero", description: "pins the atlas", book });
    bindCharacter("session-book", hero.revision.id);

    const collected = collectCharacterWorldsForExport(repo, [
      { sessionId: "session-book", ownerScope: OWNER },
    ]);
    assert.equal(collected.entities.length, 1, "only the character is an entity");
    const entity = collected.entities[0];
    assert.ok(
      entity.characterBook && entity.characterBook.canonical,
      "the pinned world book rides inside the character as characterBook",
    );
    assert.equal(entity.characterBook.canonical.name, "Harbor Atlas");
  });

  await check("durable turn snapshots also contribute referenced revisions", async () => {
    const hero = createCharacter({ name: "Snapshot Hero", description: "from a turn snapshot" });
    // Snapshot metadata mirrors turn-binding-snapshot's ready snapshot shape.
    const snapshot = {
      schemaVersion: 1,
      mode: "character",
      bindingVersion: 3,
      snapshotStatus: "ready",
      characterRevisionId: hero.revision.id,
      personaRevisionId: null,
      compatibilityProfile: "lily-character-compat-1",
    };
    const collected = collectCharacterWorldsForExport(repo, [
      { sessionId: "session-snap", ownerScope: OWNER, snapshot },
    ]);
    assert.equal(
      collected.entities.some((e) => e.sourceRevisionId === hero.revision.id),
      true,
      "a revision referenced only by a turn snapshot is packed",
    );
  });

  await check("packed JSON leaks no secrets, no absolute paths, no runtime events", async () => {
    const hero = createCharacter({ name: "Secret Hero", description: "clean" });
    bindCharacter("session-secret", hero.revision.id);
    const collected = collectCharacterWorldsForExport(repo, [
      { sessionId: "session-secret", ownerScope: OWNER },
    ]);
    const packed = packCharacterWorldsSection(collected);
    const json = packed.json;
    assert.ok(packed.bytes > 0 && packed.bytes <= packed.maxBytes, "bounded pack");
    const parsed = JSON.parse(json);
    assert.ok(parsed.schemaVersion >= 1);
    const serialized = JSON.stringify(parsed);
    for (const forbidden of [OWNER, "profile:local", "messages.db", "/Users", "session-secret"]) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `pack never leaks ${forbidden}`,
      );
    }
    assert.equal(JSON.stringify(parsed).includes("runtime event"), false);
  });

  // --- import-side remap ---------------------------------------------------

  await check("import gives entities new local ids and remaps character→book pins", async () => {
    const book = repo.createWorldBook({
      ownerScope: OWNER,
      canonical: {
        name: "Remap Atlas",
        groups: [{ name: "Places", entries: [{ key: "docks", content: "The docks." }] }],
      },
      source: { format: "lily", container: "json", original: null },
      assets: [],
    });
    const hero = createCharacter({ name: "Remap Hero", description: "pins atlas", book });
    const persona = createPersona({ name: "Remap Persona", description: "bound" });
    bindPersona("session-remap", hero.revision.id, persona.revision.id);

    const collected = collectCharacterWorldsForExport(repo, [
      { sessionId: "session-remap", ownerScope: OWNER },
    ]);
    const packed = packCharacterWorldsSection(collected);
    const section = unpackCharacterWorldsSection(packed.json);

    const dstTmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-portability-dst-"));
    const dstStore = new MessageStore(path.join(dstTmp, "messages.db"), path.join(dstTmp, "blobs"));
    const dstRepo = new CharacterWorldsRepository(dstStore);
    const result = await importCharacterWorldsPack(dstRepo, OWNER, section);

    assert.equal(result.ok, true, JSON.stringify(result.errors || []));
    assert.equal(result.imported.length, 2, "character + persona imported");
    const heroImport = result.imported.find((e) => e.kind === "character");
    const personaImport = result.imported.find((e) => e.kind === "persona");
    assert.notEqual(heroImport.newRevisionId, hero.revision.id, "character revision id regenerated");
    assert.notEqual(heroImport.newEntityId, hero.entity.id, "character entity id regenerated");
    assert.notEqual(personaImport.newRevisionId, persona.revision.id, "persona revision id regenerated");
    assert.ok(
      heroImport.characterBookNewRevisionId,
      "the character's book pin was remapped to the imported book revision",
    );
    assert.notEqual(
      heroImport.characterBookNewRevisionId,
      book.revision.id,
      "book pin points at the NEW book revision, not the source id",
    );
    const newRev = dstRepo.getRevision(OWNER, heroImport.newRevisionId);
    assert.equal(newRev.canonical.name, "Remap Hero", "canonical content survives the round-trip");
    assert.equal(newRev.characterBookRevisionId, heroImport.characterBookNewRevisionId);
    assert.equal(newRev.cardAssets.length, 0);
  });

  await check("restoreBindingPreview restores only when the referenced revision imported", async () => {
    const idMap = {
      "rev-present": "rev-new-present",
    };
    const previews = restoreBindingPreview(idMap, [
      { sessionId: "s-ok", characterRevisionId: "rev-present" },
      { sessionId: "s-missing", characterRevisionId: "rev-gone" },
    ]);
    const ok = previews.find((p) => p.sessionId === "s-ok");
    const missing = previews.find((p) => p.sessionId === "s-missing");
    assert.equal(ok.restored, true);
    assert.equal(ok.newCharacterRevisionId, "rev-new-present");
    assert.equal(missing.restored, false);
    assert.equal(missing.diagnostic, "missing_revision");
  });

  await check("exact-duplicate re-import of a character dedups naturally", async () => {
    const hero = createCharacter({ name: "Dup Hero", description: "same content" });
    bindCharacter("session-dup", hero.revision.id);
    const collected = collectCharacterWorldsForExport(repo, [
      { sessionId: "session-dup", ownerScope: OWNER },
    ]);
    const packed = packCharacterWorldsSection(collected);
    const section = unpackCharacterWorldsSection(packed.json);

    const dstTmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-portability-dup-"));
    const dstStore = new MessageStore(path.join(dstTmp, "messages.db"), path.join(dstTmp, "blobs"));
    const dstRepo = new CharacterWorldsRepository(dstStore);
    const first = await importCharacterWorldsPack(dstRepo, OWNER, section);
    const second = await importCharacterWorldsPack(dstRepo, OWNER, section);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const chars = dstRepo.listCharacters(OWNER);
    const dupHeroes = chars.filter((c) => c.displayName === "Dup Hero");
    assert.equal(dupHeroes.length, 1, "the identical character is deduped, not doubled");
  });

  await check("group scenes and scene memory travel with the pack and remap on import (P3-3)", async () => {
    const memory = require("../src/main/character-worlds/scene-memory.js");
    const group = require("../src/main/character-worlds/group-modes.js");
    const hero = createCharacter({ name: "Scene Hero", description: "scene participant" });
    bindCharacter("s-scene", hero.revision.id);
    memory.appendMemory(repo.db, {
      sessionId: "s-scene",
      characterRevisionId: hero.revision.id,
      kind: "character_belief",
      text: "Aria believes the lighthouse is haunted.",
      sourceTurnIds: ["t1"],
      confidence: "explicit",
    });
    group.createScene(repo, {
      ownerScope: OWNER,
      sessionId: "s-scene",
      name: "Harbor Scene",
      participantCharacterRevisionIds: [hero.revision.id],
      replyStrategy: "natural",
    });
    const collected = collectCharacterWorldsForExport(repo, [
      { sessionId: "s-scene", ownerScope: OWNER },
    ]);
    const packed = packCharacterWorldsSection(collected);
    const section = unpackCharacterWorldsSection(packed.json);
    assert.equal(section.memory.length, 1, "memory section packed");
    assert.equal(section.scenes.length, 1, "scene section packed");

    const dstTmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-portability-p3-"));
    const dstStore = new MessageStore(path.join(dstTmp, "messages.db"), path.join(dstTmp, "blobs"));
    const dstRepo = new CharacterWorldsRepository(dstStore);
    const result = await importCharacterWorldsPack(dstRepo, OWNER, section);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.memoryImported.length, 1, "memory imported with remapped revision");
    assert.equal(result.scenesImported.length, 1, "scene imported with remapped participants");
  });

  console.log(`PASS: test-character-workspace-portability (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
