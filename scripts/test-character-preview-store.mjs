#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { CharacterPreviewStore } = require("../src/main/character-worlds/preview-store.js");

const OWNER = "profile:preview-owner";
const OTHER_OWNER = "profile:preview-other";
const SESSION = "preview-session";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-preview-store-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repo = store.characterWorlds();
const source = { kind: "created", format: "lily", container: "json" };

try {
  const character = repo.createCharacter({
    ownerScope: OWNER,
    canonical: { name: "Mira", description: "A precise guide.", personality: "calm" },
    source,
  });
  const persona = repo.createPersona({
    ownerScope: OWNER,
    canonical: { schemaVersion: 1, name: "Builder", description: "Builds durable products." },
    source,
  });
  const book = repo.createWorldBook({
    ownerScope: OWNER,
    canonical: {
      schemaVersion: 1,
      name: "Workshop Rules",
      entries: [{ id: "rule", content: "Evidence beats confidence.", activation: { constant: true } }],
    },
    source,
  });
  const foreignPersona = repo.createPersona({
    ownerScope: OTHER_OWNER,
    canonical: { schemaVersion: 1, name: "Foreign", description: "Must remain private." },
    source,
  });

  const previews = new CharacterPreviewStore({ repository: repo, now: () => 1000 });
  assert.equal(previews.get(OWNER, SESSION), null);

  const personaPreview = previews.replaceFacet({
    ownerScope: OWNER,
    sessionId: SESSION,
    expectedPreviewVersion: 0,
    facet: "persona",
    revisionId: persona.revision.id,
  });
  assert.equal(personaPreview.previewVersion, 1);
  assert.deepEqual(personaPreview.persona, {
    entityId: persona.entity.id,
    revisionId: persona.revision.id,
  });
  assert.equal(new CharacterPreviewStore({ repository: repo }).get(OWNER, SESSION).previewVersion, 1);
  assert.equal(previews.get(OTHER_OWNER, SESSION), null, "preview never crosses owner scope");

  assert.throws(
    () => previews.replaceFacet({
      ownerScope: OWNER,
      sessionId: SESSION,
      expectedPreviewVersion: 0,
      facet: "character",
      revisionId: character.revision.id,
    }),
    (error) => error.code === "CHARACTER_PREVIEW_CONFLICT"
      && error.current?.previewVersion === 1,
  );
  assert.throws(
    () => previews.replaceFacet({
      ownerScope: OWNER,
      sessionId: "foreign-revision-session",
      expectedPreviewVersion: 0,
      facet: "persona",
      revisionId: foreignPersona.revision.id,
    }),
    (error) => error.code === "PERSONA_REVISION_NOT_FOUND",
  );

  const withCharacter = previews.replaceFacet({
    ownerScope: OWNER,
    sessionId: SESSION,
    expectedPreviewVersion: 1,
    facet: "character",
    revisionId: character.revision.id,
  });
  const withBook = previews.addWorldBook({
    ownerScope: OWNER,
    sessionId: SESSION,
    expectedPreviewVersion: withCharacter.previewVersion,
    revisionId: book.revision.id,
    scope: "chat",
    mergeStrategy: "constant",
  });
  assert.equal(withBook.previewVersion, 3);
  assert.equal(withBook.worldBooks.length, 1);
  assert.equal(withBook.worldBooks[0].entityId, book.entity.id);

  const durable = repo.getConversationConfig(SESSION, OWNER);
  const effective = previews.effectiveConfig({
    ownerScope: OWNER,
    sessionId: SESSION,
    durableConfig: durable,
  });
  assert.equal(effective.characterRevisionId, character.revision.id);
  assert.equal(effective.personaRevisionId, persona.revision.id);
  assert.deepEqual(effective.books, [{
    scope: "chat",
    worldBookRevisionId: book.revision.id,
    mergeStrategy: "constant",
  }]);

  const activated = previews.activateFacet({
    ownerScope: OWNER,
    sessionId: SESSION,
    expectedPreviewVersion: withBook.previewVersion,
    expectedBindingVersion: durable.bindingVersion,
    facet: "persona",
  });
  assert.equal(activated.binding.personaRevisionId, persona.revision.id);
  assert.equal(activated.preview.previewVersion, 4);
  assert.equal(activated.preview.persona, null, "activated facet leaves preview mode");
  assert.ok(activated.preview.character, "other preview facets remain active");
  assert.equal(activated.preview.worldBooks.length, 1);
  assert.equal(repo.getConversationConfig(SESSION, OWNER).personaRevisionId, persona.revision.id);

  const cleared = previews.clear({
    ownerScope: OWNER,
    sessionId: SESSION,
    expectedPreviewVersion: activated.preview.previewVersion,
  });
  assert.equal(cleared.previewVersion, 5);
  assert.equal(cleared.character, null);
  assert.equal(cleared.persona, null);
  assert.deepEqual(cleared.worldBooks, []);
  assert.throws(
    () => previews.replaceFacet({
      ownerScope: OWNER,
      sessionId: SESSION,
      expectedPreviewVersion: 0,
      facet: "character",
      revisionId: character.revision.id,
    }),
    (error) => error.code === "CHARACTER_PREVIEW_CONFLICT"
      && error.current?.previewVersion === 5,
    "clearing retains a monotonic CAS version",
  );

  console.log("PASS: test-character-preview-store");
} finally {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
