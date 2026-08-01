"use strict";
/**
 * §4.3 P3: world-book entry content expands safe macros with the same
 * narrative context as character fields — {{char}} binds to the identity.
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
  characterRevisionId: "char-rev-macro",
  personaRevisionId: null,
  compatibilityProfile: "v3",
  snapshotStatus: "ready",
};
const revision = {
  id: "char-rev-macro",
  characterId: "char-macro",
  schemaVersion: 1,
  canonical: { name: "Aria", description: "Keeper of the light." },
  source: { format: "lily", container: "json", original: null },
  cardAssets: [],
  characterBookRevisionId: "book-rev-1",
};

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

try {
  await check("world entry content expands {{char}} with the identity", async () => {
    const worldBookRevision = {
      id: "book-rev-1",
      worldBookId: "book-1",
      schemaVersion: 1,
      canonical: normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Harbor Atlas",
        entries: [{ id: "lighthouse", content: "{{char}} tends the lamp here.", activation: { constant: true } }],
      }),
      source: { format: "lily", container: "json", original: null },
      cardAssets: [],
    };
    const result = compileCharacterContext({
      snapshot,
      revision,
      worldBook: {
        revisionId: "book-rev-1",
        revision: worldBookRevision,
        corpus: buildScanCorpus({ messages: [{ seq: 1, role: "user", text: "hello", speakerName: "User" }] }),
        seedIdentity: { ownerScope: "profile:local", sessionId: "s-1", turnId: "t-1" },
      },
    });
    assert.equal(result.status, "compiled");
    assert.ok(result.text.includes("Aria tends the lamp here."), "{{char}} expanded in world entry");
  });

  await check("plain world prose without macro syntax is untouched", async () => {
    const worldBookRevision = {
      id: "book-rev-1",
      worldBookId: "book-1",
      schemaVersion: 1,
      canonical: normalizeWorldBookCanonical({
        schemaVersion: 1,
        name: "Harbor Atlas",
        entries: [{ id: "dock", content: "The dock is busy at dawn.", activation: { constant: true } }],
      }),
      source: { format: "lily", container: "json", original: null },
      cardAssets: [],
    };
    const result = compileCharacterContext({
      snapshot,
      revision,
      worldBook: {
        revisionId: "book-rev-1",
        revision: worldBookRevision,
        corpus: buildScanCorpus({ messages: [{ seq: 1, role: "user", text: "hello", speakerName: "User" }] }),
        seedIdentity: { ownerScope: "profile:local", sessionId: "s-1", turnId: "t-1" },
      },
    });
    assert.ok(result.text.includes("The dock is busy at dawn."), "plain prose preserved");
  });

  console.log(`PASS: test-character-world-macros (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
}
