import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  OFFICIAL_CHARACTERS,
  getOfficialCharacter,
  listOfficialCharacters,
} = require("../src/main/character-worlds/official-character-catalog.js");

const expectedIds = new Set([
  "lily-product-manager", "lily-project-manager", "lily-meeting-operator",
  "lily-contract-reviewer", "lily-spreadsheet-operator", "lily-cn-legal-counsel",
  "lily-researcher", "lily-data-analyst", "lily-market-analyst",
  "lily-content-editor", "lily-business-writer", "lily-presentation-strategist",
  "lily-architect", "lily-troubleshooter", "lily-automation-engineer",
  "lily-mentor", "lily-strategist", "lily-companion",
]);
assert.deepEqual(new Set(OFFICIAL_CHARACTERS.map((item) => item.id)), expectedIds);
assert.equal(OFFICIAL_CHARACTERS.length, expectedIds.size);
const summaries = listOfficialCharacters();
assert.equal(summaries.length, expectedIds.size);
assert.equal(new Set(summaries.map((item) => item.id)).size, expectedIds.size);

for (const summary of summaries) {
  const full = getOfficialCharacter(summary.id);
  assert.equal(summary.official, true);
  assert.equal(Number.isInteger(summary.version), true);
  assert.ok(summary.locale);
  assert.ok(summary.displayName);
  assert.ok(summary.tagline);
  assert.ok(summary.category);
  assert.ok(summary.categoryId);
  assert.ok(summary.summary);
  assert.ok(summary.suitableFor.length);
  assert.ok(summary.requiredInputs.length);
  assert.ok(summary.workflow.length);
  assert.ok(summary.deliverables.length);
  assert.ok(summary.qualityChecks.length);
  assert.ok(summary.boundaries.length);
  assert.ok(full.canonical.description);
  assert.ok(full.canonical.personality);
  assert.ok(full.canonical.scenario);
  assert.ok(full.canonical.firstMessage);
  assert.ok(full.canonical.exampleDialogue);
  assert.ok(full.canonical.tags.includes(`official:${summary.id}`));
}

const legal = getOfficialCharacter("lily-cn-legal-counsel", "zh-CN");
assert.match(legal.canonical.creatorNotes, /中国大陆|司法辖区|持证律师|人类律师/);
assert.ok(legal.locales?.["zh-CN"]?.boundaries?.length || legal.boundaries.length);
assert.ok(legal.canonical.creatorNotes.includes("材料时点"));

const english = listOfficialCharacters("en");
assert.equal(english.every((item) => item.locale === "en"), true);
assert.equal(/[\u3400-\u9fff]/u.test(english.map((item) => `${item.displayName}${item.tagline}${item.category}`).join("")), false);

assert.equal(getOfficialCharacter("missing-official-role"), null);
console.log("PASS: test-official-character-catalog");
