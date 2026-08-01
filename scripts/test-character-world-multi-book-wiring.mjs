"use strict";
/**
 * §10.4.1 multi-book wiring: a compiled worldBook input carrying `books`
 * merges chat/persona/character/global lore into constant entries and injects
 * them into the envelope; single-book input stays byte-unchanged.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  compileCharacterContext,
} = require("../src/main/character-worlds/context-compiler.js");
const { buildScanCorpus } = require("../src/main/character-worlds/world-book-corpus.js");
const { normalizeWorldBookCanonical } = require("../src/main/character-worlds/world-book-model.js");

const snapshot = {
  schemaVersion: 1,
  mode: "character",
  bindingVersion: 5,
  characterRevisionId: "char-rev-mb",
  personaRevisionId: null,
  compatibilityProfile: "v3",
  snapshotStatus: "ready",
};
const revision = {
  id: "char-rev-mb",
  characterId: "char-mb",
  schemaVersion: 1,
  canonical: { name: "Aria", description: "Keeper." },
  source: { format: "lily", container: "json", original: null },
  cardAssets: [],
  characterBookRevisionId: "book-rev-1",
};

function book(scope, entries, id) {
  return {
    scope,
    revision: {
      id,
      worldBookId: `wb-${scope}`,
      schemaVersion: 1,
      canonical: normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: `${scope}-book`,
        entries,
      }),
      source: { format: "lily", container: "json", original: null },
      cardAssets: [],
    },
  };
}

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("multi-book input merges lore into the compiled envelope", async () => {
    const result = compileCharacterContext({
      snapshot,
      revision,
      worldBook: {
        revisionId: "book-rev-1",
        revision: book("character", [{ id: "c1", content: "Character lore." }], "book-rev-1").revision,
        books: [
          book("persona", [{ id: "p1", content: "Persona lore." }], "p-rev"),
          book("chat", [{ id: "k1", content: "Chat lore." }], "k-rev"),
        ],
        corpus: buildScanCorpus({ messages: [{ seq: 1, role: "user", text: "hi", speakerName: "User" }] }),
        seedIdentity: { ownerScope: "profile:local", sessionId: "s-1", turnId: "t-1" },
      },
    });
    assert.equal(result.status, "compiled");
    assert.ok(result.text.includes("Persona lore."), "persona lore merged in");
    assert.ok(result.text.includes("Chat lore."), "chat lore merged in");
  });

  await check("single-book input compiles unchanged", async () => {
    const result = compileCharacterContext({
      snapshot,
      revision,
      worldBook: {
        revisionId: "book-rev-1",
        revision: book("character", [{ id: "c1", content: "Character lore.", activation: { constant: true } }], "book-rev-1").revision,
        corpus: buildScanCorpus({ messages: [{ seq: 1, role: "user", text: "hi", speakerName: "User" }] }),
        seedIdentity: { ownerScope: "profile:local", sessionId: "s-1", turnId: "t-1" },
      },
    });
    assert.ok(result.text.includes("Character lore."), "character lore present");
  });

  console.log(`PASS: test-character-world-multi-book-wiring (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
}
