#!/usr/bin/env node
// Character-card-only runtime contract. Persona/world-book rows remain
// readable for migration and export, but cannot enter a live turn binding.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-character-card-only-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const { MessageStore } = require("../src/main/store/message-store.js");
const { MIGRATIONS } = require("../src/main/store/schema.js");
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { CharacterWorldsRepository } = require("../src/main/character-worlds/repository.js");
const { projectCharacterCardBinding, projectCharacterCardSnapshot } = require("../src/main/character-worlds/character-card-only.js");
const { normalizeSnapshot } = require("../src/main/character-worlds/turn-binding-snapshot.js");

const OWNER = "profile:character-card-owner";
const SESSION = "character-card-session";
let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function source(name) {
  return { kind: "created", format: "lily", container: "json", originalFileName: `${name}.json` };
}

const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = new CharacterWorldsRepository(store);
const character = repository.createCharacter({
  ownerScope: OWNER,
  canonical: { schemaVersion: 1, name: "Aria", description: "A precise archivist." },
  source: source("aria"),
});
const persona = repository.createPersona({
  ownerScope: OWNER,
  canonical: { schemaVersion: 1, name: "Qin", description: "A harbor cartographer." },
  source: source("qin"),
});

await check("schema keeps nullable legacy persona storage", () => {
  assert.equal(store.db.pragma("user_version"), MIGRATIONS.length);
  assert.ok(store.db.all("PRAGMA table_info(character_session_bindings)")
    .some((row) => row.name === "persona_revision_id"));
});

await check("legacy persona rows remain readable", () => {
  const listed = repository.listPersonas(OWNER);
  assert.equal(listed.length, 1);
  assert.equal(repository.getPersona(OWNER, persona.entity.id).displayName, "Qin");
  assert.equal(repository.getPersonaRevision(OWNER, persona.revision.id).canonical.name, "Qin");
});

await check("binding projects persona input out of the live character context", () => {
  const committed = repository.setBinding({
    sessionId: SESSION,
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: {
      mode: "character",
      characterRevisionId: character.revision.id,
      personaRevisionId: persona.revision.id,
    },
  });
  assert.equal(committed.mode, "character");
  assert.equal(committed.characterRevisionId, character.revision.id);
  assert.equal(committed.personaRevisionId, null);
  const raw = store.db.get("SELECT persona_revision_id, binding_json FROM character_session_bindings WHERE session_id = ?", SESSION);
  assert.equal(raw.persona_revision_id, null);
  assert.equal(JSON.parse(raw.binding_json).activePersonaRevisionId, null);
  assert.equal(repository.getBinding(SESSION, OWNER).personaRevisionId, null);
});

await check("binding events do not expose a persona pin", () => {
  const event = repository.getBindingEvents(SESSION, OWNER)[0];
  assert.equal(event.nextBinding.activePersonaRevisionId, null);
  assert.deepEqual(event.nextBinding.worldBookBindings, []);
});

await check("snapshot projection strips legacy persona and world-book fields", () => {
  const snapshot = projectCharacterCardSnapshot({
    schemaVersion: 2,
    mode: "character",
    bindingVersion: 1,
    characterRevisionId: character.revision.id,
    personaRevisionId: persona.revision.id,
    worldBookBindings: [{ scope: "persona", worldBookRevisionId: "legacy-book" }],
    compatibilityProfile: "lily-character-compat-1",
  });
  assert.equal(snapshot.mode, "character");
  assert.equal(snapshot.characterRevisionId, character.revision.id);
  assert.equal(snapshot.personaRevisionId, null);
  assert.deepEqual(snapshot.worldBookBindings, []);
  assert.equal(normalizeSnapshot({
    schemaVersion: 1,
    mode: "character",
    bindingVersion: 1,
    characterRevisionId: character.revision.id,
    personaRevisionId: null,
    compatibilityProfile: "lily-character-compat-1",
    snapshotStatus: "ready",
  }).personaRevisionId, null);
});

await check("native projection clears all legacy context", () => {
  const native = projectCharacterCardBinding({
    mode: "native",
    bindingVersion: 2,
    characterRevisionId: null,
    personaRevisionId: persona.revision.id,
    compatibilityProfile: "legacy",
  });
  assert.equal(native.mode, "native");
  assert.equal(native.personaRevisionId, null);
  assert.equal(native.compatibilityProfile, null);
});

store.close();
console.log(`PASS: test-character-persona-context (${checks} checks)`);
