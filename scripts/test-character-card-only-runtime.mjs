#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  projectCharacterCardConfig,
  projectCharacterCardBinding,
  projectCharacterCardSnapshot,
} = require("../src/main/character-worlds/character-card-only.js");
const { compileTurnWorldCharacterContext } = require("../src/main/character-worlds/turn-world-book.js");
const { buildOpencodePromptBody, characterApplicationOf } = require("../src/main/runtime/opencode-message-parts.js");

const legacy = {
  characterRevisionId: "character-rev-1",
  personaRevisionId: "persona-rev-1",
  books: [
    { scope: "chat", worldBookRevisionId: "book-rev-1", mergeStrategy: "constant" },
  ],
  greetingIndex: 2,
  sceneId: "scene-1",
  groupId: "group-1",
};

assert.deepEqual(projectCharacterCardConfig(legacy), {
  characterRevisionId: "character-rev-1",
  personaRevisionId: null,
  books: [],
  greetingIndex: 2,
  sceneId: "scene-1",
  groupId: "group-1",
});

assert.deepEqual(projectCharacterCardBinding({
  mode: "character",
  bindingVersion: 4,
  characterRevisionId: "character-rev-1",
  personaRevisionId: "persona-rev-1",
  compatibilityProfile: "lily-character-worlds-v1",
  greetingIndex: 2,
}), {
  mode: "character",
  bindingVersion: 4,
  characterRevisionId: "character-rev-1",
  personaRevisionId: null,
  compatibilityProfile: "lily-character-worlds-v1",
  greetingIndex: 2,
});

assert.deepEqual(projectCharacterCardSnapshot({
  schemaVersion: 2,
  mode: "character",
  bindingVersion: 4,
  previewVersion: 1,
  characterRevisionId: "character-rev-1",
  personaRevisionId: "persona-rev-1",
  worldBookBindings: legacy.books,
  compatibilityProfile: "lily-character-worlds-v1",
  greetingIndex: 2,
  sceneId: "scene-1",
  groupId: "group-1",
  snapshotStatus: "ready",
}), {
  schemaVersion: 2,
  mode: "character",
  bindingVersion: 4,
  previewVersion: 1,
  characterRevisionId: "character-rev-1",
  personaRevisionId: null,
  worldBookBindings: [],
  compatibilityProfile: "lily-character-worlds-v1",
  greetingIndex: 2,
  sceneId: "scene-1",
  groupId: "group-1",
  snapshotStatus: "ready",
});

assert.deepEqual(projectCharacterCardConfig({}), {
  characterRevisionId: null,
  personaRevisionId: null,
  books: [],
  greetingIndex: null,
  sceneId: null,
  groupId: null,
});

const projectedSnapshot = projectCharacterCardSnapshot({
  schemaVersion: 1,
  mode: "character",
  bindingVersion: 4,
  characterRevisionId: "character-rev-1",
  personaRevisionId: "persona-rev-1",
  compatibilityProfile: "lily-character-worlds-v1",
  snapshotStatus: "ready",
});
const compiled = compileTurnWorldCharacterContext({
  ownerScope: "profile:test",
  sessionId: "session-test",
  turnId: "turn-test",
  snapshot: projectedSnapshot,
  revision: {
    id: "character-rev-1",
    displayName: "Card Only",
    characterBookRevisionId: "embedded-book-must-stay-inert",
    canonical: {
      name: "Card Only",
      description: "A character card without extra context systems.",
      personality: "Precise and direct.",
    },
  },
  repository: {
    getPersonaRevision() { throw new Error("persona must not be read"); },
    getWorldBookRevision() { throw new Error("embedded world book must not be read"); },
  },
  baseInput: { userText: "hello", modelBudget: { usableInputTokens: 32768, remainingInputTokens: 12000 } },
});
assert.equal(compiled.compiled.status, "compiled");
assert.equal(compiled.compiled.worldBook, null);
assert.equal(compiled.pendingCheckpoint, null);
const body = buildOpencodePromptBody({
  text: "hello",
  guidance: "LILY GUIDANCE",
  characterContext: compiled.compiled,
});
assert.equal(characterApplicationOf(body).status, "applied");
assert.doesNotMatch(body.system, /embedded-book-must-stay-inert/);

console.log("character-card-only-runtime: embedded world books stay inert");

console.log("character-card-only-runtime: ok");
