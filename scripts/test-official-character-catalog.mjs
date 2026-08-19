import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  OFFICIAL_CHARACTERS,
  ADDITIONAL_OFFICIAL_CHARACTERS,
  INDUSTRY_OFFICIAL_CHARACTERS,
  ALL_OFFICIAL_CHARACTERS,
  FEATURED_OFFICIAL_CHARACTER_IDS,
  getOfficialCharacter,
  getOfficialCharacterDetail,
  listOfficialCharacters,
} = require("../src/main/character-worlds/official-character-catalog.js");

const baseIds = new Set([
  "lily-product-manager", "lily-project-manager", "lily-meeting-operator",
  "lily-contract-reviewer", "lily-spreadsheet-operator", "lily-cn-legal-counsel",
  "lily-researcher", "lily-data-analyst", "lily-market-analyst",
  "lily-content-editor", "lily-business-writer", "lily-presentation-strategist",
  "lily-architect", "lily-troubleshooter", "lily-automation-engineer",
  "lily-mentor", "lily-strategist", "lily-companion",
]);
const expectedIds = new Set([
  ...baseIds,
  "lily-career-coach", "lily-life-planner", "lily-family-coordinator",
  "lily-health-routine-coach",
  ...INDUSTRY_OFFICIAL_CHARACTERS.map((item) => item.id),
]);
assert.deepEqual(new Set(OFFICIAL_CHARACTERS.map((item) => item.id)), baseIds);
assert.equal(ADDITIONAL_OFFICIAL_CHARACTERS.length, 4);
assert.deepEqual(new Set(ALL_OFFICIAL_CHARACTERS.map((item) => item.id)), expectedIds);
assert.equal(INDUSTRY_OFFICIAL_CHARACTERS.length, 46);
assert.equal(ALL_OFFICIAL_CHARACTERS.length, 68);
assert.equal(FEATURED_OFFICIAL_CHARACTER_IDS.length, 12);
assert.deepEqual(
  new Set(ALL_OFFICIAL_CHARACTERS.filter((item) => item.featured).map((item) => item.id)),
  new Set(FEATURED_OFFICIAL_CHARACTER_IDS),
);
assert.ok(new Set(ALL_OFFICIAL_CHARACTERS.map((item) => item.categoryId)).size >= 14);
const summaries = listOfficialCharacters();
assert.equal(summaries.length, ALL_OFFICIAL_CHARACTERS.length);
assert.equal(new Set(summaries.map((item) => item.id)).size, ALL_OFFICIAL_CHARACTERS.length);
assert.equal(summaries.filter((item) => item.featured).length, 12);

for (const summary of summaries) {
  const full = getOfficialCharacter(summary.id);
  assert.equal(summary.official, true);
  assert.equal(Number.isInteger(summary.version), true);
  assert.ok(summary.locale);
  assert.ok(summary.displayName);
  assert.ok(summary.tagline);
  assert.ok(summary.category);
  assert.ok(summary.categoryId);
  assert.ok(summary.tags.length);
  assert.equal("canonical" in summary, false);
  assert.equal("workflow" in summary, false);
  const detail = getOfficialCharacterDetail(summary.id);
  assert.ok(detail.summary);
  assert.ok(detail.suitableFor.length);
  assert.ok(detail.requiredInputs.length);
  assert.ok(detail.workflow.length);
  assert.ok(detail.deliverables.length);
  assert.ok(detail.qualityChecks.length);
  assert.ok(detail.boundaries.length);
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
assert.ok(legal.canonical.creatorNotes.includes("lily_legal_search"));
const fullStack = getOfficialCharacter("lily-full-stack-engineer", "zh-CN");
assert.equal(fullStack.categoryId, "technology-engineering");
assert.match(fullStack.name, /全栈工程师/);
assert.match(fullStack.summary, /前端、后端、数据库/);
assert.ok(fullStack.workflow.some((step) => /测试|部署|运行/.test(step)));
assert.ok(fullStack.boundaries.some((boundary) => /数据库|生产环境|回滚/.test(boundary)));
for (const id of ["lily-healthcare-navigator", "lily-compliance-officer", "lily-financial-planning-analyst", "lily-cybersecurity-analyst"]) {
  const regulated = getOfficialCharacter(id, "zh-CN");
  assert.ok(regulated.boundaries.some((boundary) => /不|不要|必须|专业|医生|律师|投资|安全/.test(boundary)));
}

const english = listOfficialCharacters("en");
assert.equal(english.every((item) => item.locale === "en"), true);
assert.equal(/[\u3400-\u9fff]/u.test(english.map((item) => `${item.displayName}${item.tagline}${item.category}`).join("")), false);
for (const item of INDUSTRY_OFFICIAL_CHARACTERS) {
  const englishDetail = getOfficialCharacter(item.id, "en");
  assert.equal(/[\u3400-\u9fff]/u.test(JSON.stringify(englishDetail.canonical)), false, `${item.id} English canonical is localized`);
}
assert.equal(getOfficialCharacter("lily-retail-store-operations", "ar").locale, "en");

assert.equal(getOfficialCharacter("missing-official-role"), null);
console.log("PASS: test-official-character-catalog");
