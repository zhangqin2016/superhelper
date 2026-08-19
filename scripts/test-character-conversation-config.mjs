#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const {
  configMode,
  dedupeBooks,
  emptyConversationConfig,
  normalizeConversationConfig,
} = require("../src/main/character-worlds/conversation-config.js");

const OWNER = "profile:conversation-config";
const OTHER_OWNER = "profile:conversation-config:other";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "character-conversation-config-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repo = store.characterWorlds();

const source = { kind: "created", format: "lily", container: "json" };

try {
  const empty = emptyConversationConfig();
  assert.deepEqual(empty, {
    characterRevisionId: null,
    personaRevisionId: null,
    books: [],
    greetingIndex: null,
    sceneId: null,
    groupId: null,
  });
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(configMode(empty), "native");

  const persona = repo.createPersona({
    ownerScope: OWNER,
    canonical: { schemaVersion: 1, name: "Product Lead", description: "Decisive product lead." },
    source,
  });
  const foreignPersona = repo.createPersona({
    ownerScope: OTHER_OWNER,
    canonical: { schemaVersion: 1, name: "Foreign", description: "Must remain isolated." },
    source,
  });
  const book = repo.createWorldBook({
    ownerScope: OWNER,
    canonical: {
      schemaVersion: 1,
      name: "Product World",
      entries: [{ id: "rule-1", content: "Customers define value.", activation: { constant: true } }],
    },
    source,
  });

  const normalized = normalizeConversationConfig({
    personaRevisionId: persona.revision.id,
    books: [{
      scope: "chat",
      worldBookRevisionId: book.revision.id,
      mergeStrategy: "constant",
    }],
    greetingIndex: 4,
    sceneId: "scene-without-character",
    groupId: "group-without-character",
  });
  assert.equal(normalized.characterRevisionId, null);
  assert.equal(normalized.personaRevisionId, persona.revision.id);
  assert.equal(normalized.greetingIndex, null, "character-dependent greeting is cleared");
  assert.equal(normalized.sceneId, null, "character-dependent scene is cleared");
  assert.equal(normalized.groupId, null, "character-dependent group is cleared");
  assert.equal(configMode(normalized), "native");
  assert.equal(Object.isFrozen(normalized.books), true);

  assert.deepEqual(dedupeBooks([
    { scope: "chat", worldBookRevisionId: book.revision.id, mergeStrategy: "constant" },
    { scope: "chat", worldBookRevisionId: book.revision.id, mergeStrategy: "constant" },
  ]), [{ scope: "chat", worldBookRevisionId: book.revision.id, mergeStrategy: "constant" }]);
  assert.throws(
    () => dedupeBooks([
      { scope: "chat", worldBookRevisionId: book.revision.id, mergeStrategy: "constant" },
      { scope: "chat", worldBookRevisionId: "another-revision", mergeStrategy: "constant" },
    ]),
    /conversation_config_invalid/,
  );

  const committed = repo.setConversationConfig({
    sessionId: "session-native-context",
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: normalized,
  });
  assert.equal(committed.mode, "native");
  assert.equal(committed.bindingVersion, 1);
  assert.equal(committed.characterRevisionId, null);
  assert.equal(committed.personaRevisionId, null);
  assert.deepEqual(committed.books, []);

  const loaded = repo.getConversationConfig("session-native-context", OWNER);
  assert.deepEqual(loaded, committed);
  assert.equal(repo.getBinding("session-native-context", OWNER).personaRevisionId, null);
  assert.deepEqual(repo.getBookBindings("session-native-context", OWNER), []);

  assert.throws(
    () => repo.setConversationConfig({
      sessionId: "session-native-context",
      ownerScope: OWNER,
      expectedBindingVersion: 0,
      next: empty,
    }),
    (error) => error.code === "CHARACTER_BINDING_CONFLICT"
      && error.current?.bindingVersion === 1,
  );
  const foreignFacet = repo.setConversationConfig({
    sessionId: "session-foreign-persona",
    ownerScope: OWNER,
    expectedBindingVersion: 0,
    next: { personaRevisionId: foreignPersona.revision.id },
  });
  assert.equal(foreignFacet.personaRevisionId, null);

  const nativeViaLegacy = repo.setBinding({
    sessionId: "session-native-context",
    ownerScope: OWNER,
    expectedBindingVersion: 1,
    next: { mode: "native" },
  });
  assert.equal(nativeViaLegacy.personaRevisionId, null, "legacy native selection still clears persona");
  assert.deepEqual(repo.getBookBindings("session-native-context", OWNER), [],
    "character-card-only binding clears retired facet rows");

  console.log("PASS: test-character-conversation-config");
} finally {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
