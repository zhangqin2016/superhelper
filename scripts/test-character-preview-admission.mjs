#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { CharacterPreviewStore } = require("../src/main/character-worlds/preview-store.js");

const OWNER = "profile:preview-admission";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-preview-admission-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repo = store.characterWorlds();
const previews = new CharacterPreviewStore({ repository: repo });
const source = { kind: "created", format: "lily", container: "json" };

function admit(sessionId, turnId, sourceTurnId = undefined) {
  return store.admitTurnInput(
    sessionId,
    {
      turnId,
      delivery: "direct",
      status: "admitted",
      userText: turnId,
      files: [],
      metadata: {},
      createdAt: Date.now(),
    },
    {
      ownerScope: OWNER,
      ...(sourceTurnId ? { sourceTurnId } : {}),
    },
  );
}

try {
  const character = repo.createCharacter({
    ownerScope: OWNER,
    canonical: { name: "Preview Guide", description: "A preview-only guide.", personality: "direct" },
    source,
  });
  const persona = repo.createPersona({
    ownerScope: OWNER,
    canonical: { schemaVersion: 1, name: "Operator", description: "Runs the product." },
    source,
  });
  const book = repo.createWorldBook({
    ownerScope: OWNER,
    canonical: {
      schemaVersion: 1,
      name: "Preview Lore",
      entries: [{ id: "entry", content: "Preview facts are pinned.", activation: { constant: true } }],
    },
    source,
  });

  const durable = repo.setConversationConfig({
    sessionId: "composed-session",
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: { personaRevisionId: persona.revision.id },
  });
  assert.equal(durable.mode, "native");
  const characterPreview = previews.replaceFacet({
    ownerScope: OWNER,
    sessionId: "composed-session",
    expectedPreviewVersion: 0,
    facet: "character",
    revisionId: character.revision.id,
  });
  const bookPreview = previews.addWorldBook({
    ownerScope: OWNER,
    sessionId: "composed-session",
    expectedPreviewVersion: characterPreview.previewVersion,
    revisionId: book.revision.id,
  });

  const admitted = admit("composed-session", "turn-composed-1");
  const snapshot = admitted.metadata.characterWorlds;
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.snapshotStatus, "ready");
  assert.equal(snapshot.mode, "character");
  assert.equal(snapshot.bindingVersion, durable.bindingVersion);
  assert.equal(snapshot.previewVersion, bookPreview.previewVersion);
  assert.equal(snapshot.characterRevisionId, character.revision.id);
  assert.equal(snapshot.personaRevisionId, persona.revision.id);
  assert.deepEqual(snapshot.worldBookBindings, [{
    scope: "chat",
    worldBookRevisionId: book.revision.id,
    mergeStrategy: "constant",
  }]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.worldBookBindings), true);

  const raw = store.db.get(
    "SELECT character_worlds_snapshot_json FROM turn_inputs WHERE turn_id = ?",
    "turn-composed-1",
  );
  assert.deepEqual(JSON.parse(raw.character_worlds_snapshot_json), snapshot);

  previews.clear({
    ownerScope: OWNER,
    sessionId: "composed-session",
    expectedPreviewVersion: bookPreview.previewVersion,
  });
  repo.setConversationConfig({
    sessionId: "composed-session",
    ownerScope: OWNER,
    expectedBindingVersion: durable.bindingVersion,
    next: {},
  });
  assert.deepEqual(
    store.getTurnInputByTurnId("turn-composed-1", OWNER).metadata.characterWorlds,
    snapshot,
    "admitted turn never rereads the current preview or durable config",
  );

  const inherited = admit("composed-session", "turn-composed-retry", "turn-composed-1");
  assert.deepEqual(inherited.metadata.characterWorlds, snapshot);
  assert.deepEqual(
    JSON.parse(store.db.get(
      "SELECT character_worlds_snapshot_json FROM turn_inputs WHERE turn_id = ?",
      "turn-composed-retry",
    ).character_worlds_snapshot_json),
    snapshot,
  );

  const personaOnly = repo.setConversationConfig({
    sessionId: "persona-only-session",
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: { personaRevisionId: persona.revision.id },
  });
  const personaTurn = admit("persona-only-session", "turn-persona-only");
  assert.equal(personaTurn.metadata.characterWorlds.mode, "native");
  assert.equal(personaTurn.metadata.characterWorlds.snapshotStatus, "ready");
  assert.equal(personaTurn.metadata.characterWorlds.characterRevisionId, null);
  assert.equal(personaTurn.metadata.characterWorlds.personaRevisionId, persona.revision.id);
  assert.equal(personaTurn.metadata.characterWorlds.bindingVersion, personaOnly.bindingVersion);

  previews.replaceFacet({
    ownerScope: OWNER,
    sessionId: "persona-only-session",
    expectedPreviewVersion: 0,
    facet: "character",
    revisionId: character.revision.id,
  });
  store.db.run(
    "UPDATE character_session_previews SET preview_json = ? WHERE session_id = ? AND owner_scope = ?",
    "{broken", "persona-only-session", OWNER,
  );
  const corruptPreviewTurn = admit("persona-only-session", "turn-corrupt-preview");
  assert.equal(corruptPreviewTurn.metadata.characterWorlds.mode, "native");
  assert.equal(corruptPreviewTurn.metadata.characterWorlds.characterRevisionId, null);
  assert.equal(corruptPreviewTurn.metadata.characterWorlds.personaRevisionId, persona.revision.id);

  const native = admit("empty-native-session", "turn-native-empty");
  assert.equal(Object.hasOwn(native.metadata, "characterWorlds"), false);
  assert.equal(
    store.db.get(
      "SELECT character_worlds_snapshot_json FROM turn_inputs WHERE turn_id = ?",
      "turn-native-empty",
    ).character_worlds_snapshot_json,
    null,
  );

  console.log("PASS: test-character-preview-admission");
} finally {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
