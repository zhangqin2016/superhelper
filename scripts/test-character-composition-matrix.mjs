#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { compileTurnWorldCharacterContext } = require("../src/main/character-worlds/turn-world-book.js");
const { normalizeWorldBookCanonical } = require("../src/main/character-worlds/world-book-model.js");
const { buildOpencodePromptBody } = require("../src/main/runtime/opencode-message-parts.js");
const {
  characterWorldsSummarySection,
  isMetadataOnlyCharacterSection,
} = require("../src/main/character-worlds/compaction.js");

const OWNER = "profile:composition";
const SESSION = "session-composition";
const PROFILE = "lily-character-worlds-v1";
const character = {
  id: "character-revision-1",
  canonical: {
    schemaVersion: 1,
    name: "Aria",
    description: "A careful companion.",
    personality: "Warm and precise.",
    scenario: "A quiet shared studio.",
  },
};
const persona = {
  id: "persona-revision-1",
  canonical: {
    schemaVersion: 1,
    name: "Product lead",
    description: "I value evidence, clarity, and practical outcomes.",
  },
};
const book = {
  id: "book-revision-1",
  revisionHash: "sha256:" + "b".repeat(64),
  canonical: normalizeWorldBookCanonical({
    schemaVersion: 1,
    name: "Studio rules",
    entries: [{ id: "rule-1", content: "The studio closes at midnight.", activation: { constant: true } }],
  }),
};
const revisions = new Map([[character.id, character]]);
const personas = new Map([[persona.id, persona]]);
const books = new Map([[book.id, book]]);
const repository = {
  getPersonaRevision: (_owner, id) => personas.get(id) || null,
  getWorldBookRevision: (_owner, id) => books.get(id) || null,
  readWorldBookCheckpoint: () => null,
};
const baseInput = {
  userText: "Help me decide",
  taskContract: { active: true, taskType: "general" },
  modelBudget: { usableInputTokens: 32768, remainingInputTokens: 12000 },
};

function snapshot({ withCharacter, withPersona, withBook }) {
  return Object.freeze({
    schemaVersion: 2,
    mode: withCharacter ? "character" : "native",
    bindingVersion: 7,
    previewVersion: 0,
    characterRevisionId: withCharacter ? character.id : null,
    personaRevisionId: withPersona ? persona.id : null,
    worldBookBindings: withBook
      ? [{ scope: "chat", worldBookRevisionId: book.id, mergeStrategy: "constant" }]
      : [],
    compatibilityProfile: withCharacter ? PROFILE : null,
    greetingIndex: null,
    sceneId: null,
    groupId: null,
    snapshotStatus: "ready",
  });
}

function compile(flags) {
  const admitted = snapshot(flags);
  return compileTurnWorldCharacterContext({
    repository,
    ownerScope: OWNER,
    sessionId: SESSION,
    turnId: `turn-${Number(flags.withCharacter)}${Number(flags.withPersona)}${Number(flags.withBook)}`,
    snapshot: admitted,
    revision: admitted.characterRevisionId ? revisions.get(admitted.characterRevisionId) : null,
    baseInput,
  }).compiled;
}

function envelope(compiled) {
  return JSON.parse(compiled.text.slice(compiled.text.indexOf("\n\n") + 2));
}

for (const withCharacter of [false, true]) {
  for (const withPersona of [false, true]) {
    for (const withBook of [false, true]) {
      const label = `${withCharacter ? "character" : "native"}/${withPersona ? "persona" : "no-persona"}/${withBook ? "book" : "no-book"}`;
      const compiled = compile({ withCharacter, withPersona, withBook });
      if (!withCharacter && !withPersona && !withBook) {
        assert.equal(compiled.status, "native", `${label} remains byte-equivalent native Lily`);
        continue;
      }
      assert.equal(compiled.status, "compiled", `${label} compiles`);
      const types = envelope(compiled).blocks.map((block) => block.type);
      assert.equal(types.includes("identity"), withCharacter, `${label} character facet`);
      assert.equal(types.includes("persona"), withPersona, `${label} persona facet`);
      assert.equal(types.some((type) => type.startsWith("world_")), withBook, `${label} world-book facet`);

      const prompt = {
        text: baseInput.userText,
        guidance: "LILY PROTECTED GUIDANCE",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        tools: { shell: true },
        permissionMode: "default",
      };
      const nativeBody = buildOpencodePromptBody(prompt);
      const composedBody = buildOpencodePromptBody({ ...prompt, characterContext: compiled });
      assert.ok(composedBody.system.startsWith(nativeBody.system), `${label} preserves Lily prefix`);
      assert.deepEqual(composedBody.parts, nativeBody.parts, `${label} preserves user/file parts`);
      assert.equal(prompt.model.modelID, "gpt-5", `${label} model unchanged`);
      assert.deepEqual(prompt.tools, { shell: true }, `${label} tools unchanged`);
      assert.equal(prompt.permissionMode, "default", `${label} permission unchanged`);
      const summary = characterWorldsSummarySection(snapshot({ withCharacter, withPersona, withBook }));
      assert.equal(isMetadataOnlyCharacterSection(summary), true, `${label} compaction metadata is valid`);
      assert.equal(JSON.stringify(summary).includes(persona.canonical.description), false);
      assert.equal(JSON.stringify(summary).includes(book.canonical.entries[0].content), false);
    }
  }
}

console.log("character-composition-matrix: ok (8 durable combinations)");
