import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  OFFICIAL_CHARACTERS,
  getOfficialCharacter,
  listOfficialCharacters,
} = require("../src/main/character-worlds/official-character-catalog.js");

assert.equal(OFFICIAL_CHARACTERS.length, 4);
const summaries = listOfficialCharacters();
assert.equal(summaries.length, 4);
assert.equal(new Set(summaries.map((item) => item.id)).size, 4);

for (const summary of summaries) {
  const full = getOfficialCharacter(summary.id);
  assert.equal(summary.official, true);
  assert.equal(Number.isInteger(summary.version), true);
  assert.ok(summary.locale);
  assert.ok(summary.displayName);
  assert.ok(summary.tagline);
  assert.ok(summary.category);
  assert.ok(full.canonical.description);
  assert.ok(full.canonical.personality);
  assert.ok(full.canonical.scenario);
  assert.ok(full.canonical.firstMessage);
  assert.ok(full.canonical.exampleDialogue);
  assert.ok(full.canonical.tags.includes(`official:${summary.id}`));
}

const english = listOfficialCharacters("en");
assert.equal(english.every((item) => item.locale === "en"), true);
assert.equal(/[\u3400-\u9fff]/u.test(english.map((item) => `${item.displayName}${item.tagline}${item.category}`).join("")), false);

assert.equal(getOfficialCharacter("missing-official-role"), null);
console.log("PASS: test-official-character-catalog");
