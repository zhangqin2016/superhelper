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
  const previews = new CharacterPreviewStore({ repository: repo, now: () => 1000 });
  assert.equal(previews.get(OWNER, SESSION), null);

  assert.throws(
    () => previews.replaceFacet({
      ownerScope: OWNER,
      sessionId: SESSION,
      expectedPreviewVersion: 0,
      facet: "persona",
      revisionId: "retired-persona-revision",
    }),
    (error) => error.code === "FEATURE_DISABLED",
  );
  assert.equal(previews.get(OTHER_OWNER, SESSION), null, "preview never crosses owner scope");

  assert.throws(
    () => previews.replaceFacet({
      ownerScope: OWNER,
      sessionId: "foreign-revision-session",
      expectedPreviewVersion: 0,
      facet: "persona",
      revisionId: "retired-persona-revision",
    }),
    (error) => error.code === "FEATURE_DISABLED",
  );

  const withCharacter = previews.replaceFacet({
    ownerScope: OWNER,
    sessionId: SESSION,
    expectedPreviewVersion: 0,
    facet: "character",
    revisionId: character.revision.id,
  });
  assert.equal(withCharacter.previewVersion, 1);
  assert.deepEqual(withCharacter.worldBooks, []);
  assert.throws(
    () => previews.addWorldBook({
      ownerScope: OWNER,
      sessionId: SESSION,
      expectedPreviewVersion: withCharacter.previewVersion,
      revisionId: "retired-book-revision",
    }),
    (error) => error.code === "FEATURE_DISABLED",
  );

  const durable = repo.getConversationConfig(SESSION, OWNER);
  const effective = previews.effectiveConfig({
    ownerScope: OWNER,
    sessionId: SESSION,
    durableConfig: durable,
  });
  assert.equal(effective.characterRevisionId, character.revision.id);
  assert.equal(effective.personaRevisionId, null);
  assert.deepEqual(effective.books, []);

  assert.throws(
    () => previews.activateFacet({
      ownerScope: OWNER,
      sessionId: SESSION,
      expectedPreviewVersion: withCharacter.previewVersion,
      expectedBindingVersion: durable.bindingVersion,
      facet: "persona",
    }),
    (error) => error.code === "FEATURE_DISABLED",
  );

  const cleared = previews.clear({
    ownerScope: OWNER,
    sessionId: SESSION,
    expectedPreviewVersion: withCharacter.previewVersion,
  });
  assert.equal(cleared.previewVersion, 2);
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
      && error.current?.previewVersion === 2,
    "clearing retains a monotonic CAS version",
  );

  console.log("PASS: test-character-preview-store");
} finally {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
