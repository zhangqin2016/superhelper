import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PERSONA_TEMPLATES,
  ADDITIONAL_PERSONA_TEMPLATES,
  ALL_PERSONA_TEMPLATES,
  WORLD_BOOK_TEMPLATES,
  ADDITIONAL_WORLD_BOOK_TEMPLATES,
  INDUSTRY_WORLD_BOOK_TEMPLATES,
  ALL_WORLD_BOOK_TEMPLATES,
  getOfficialPersona,
  listOfficialPersonas,
  getOfficialWorldBook,
  listOfficialWorldBooks,
} = require(
  "../src/main/character-worlds/official-context-catalog.js",
);
const { normalizeWorldBookCanonical } = require("../src/main/character-worlds/world-book-model.js");
const { buildScanCorpus } = require("../src/main/character-worlds/world-book-corpus.js");
const { resolveWorldBookActivation } = require("../src/main/character-worlds/world-book-activation.js");

const rows = listOfficialPersonas("zh-CN");
assert.equal(PERSONA_TEMPLATES.length, 3);
assert.equal(ADDITIONAL_PERSONA_TEMPLATES.length, 4);
assert.equal(ALL_PERSONA_TEMPLATES.length, 7);
assert.equal(rows.length, ALL_PERSONA_TEMPLATES.length);
assert.ok(rows.every((row) => row.official === true && row.summary && row.displayName));

const detail = getOfficialPersona("persona-project-lead", "zh-CN");
assert.equal(detail.identity, "项目负责人或核心推进者");
assert.equal(detail.categoryId, "work-identities");
assert.deepEqual(detail.expertise, ["目标拆解", "优先级", "项目推进"]);
assert.equal(detail.canonical.name, detail.name);
assert.equal(getOfficialPersona("missing", "zh-CN"), null);
const lifePersona = getOfficialPersona("persona-life-manager", "zh-CN");
assert.equal(lifePersona.identity, "管理个人生活系统的成年人");
assert.equal(lifePersona.categoryId, "life-support");
assert.ok(lifePersona.constraints.includes("不要把自律建议变成道德评判"));
assert.equal(getOfficialPersona("persona-life-manager", "ar").locale, "en");

const books = listOfficialWorldBooks("zh-CN");
assert.equal(WORLD_BOOK_TEMPLATES.length, 3);
assert.equal(ADDITIONAL_WORLD_BOOK_TEMPLATES.length, 4);
assert.equal(INDUSTRY_WORLD_BOOK_TEMPLATES.length, 14);
assert.equal(ALL_WORLD_BOOK_TEMPLATES.length, 21);
assert.equal(books.length, ALL_WORLD_BOOK_TEMPLATES.length);
assert.ok(books.every((row) => row.official === true && row.entryCount > 0 && row.categoryId));
assert.equal(new Set(books.map((row) => row.id)).size, books.length);
for (const summary of books) {
  const full = getOfficialWorldBook(summary.id, "zh-CN");
  assert.ok(full.canonical.entries.length >= 3 && full.canonical.entries.length <= 5);
  assert.ok(full.canonical.entries.every((entry) => entry.enabled === true));
  assert.ok(full.canonical.entries.every((entry) => entry.activation.primaryKeys.length || entry.activation.constant));
  assert.ok(full.canonical.entries.some((entry) => entry.activation.constant === true));
  assert.ok(full.canonical.scanPolicy.tokenBudget > 0);
  assert.equal(full.canonical.scanPolicy.recursive, false);
}
const book = getOfficialWorldBook("world-book-project-knowledge", "zh-CN");
assert.equal(book.canonical.entries.length, 4);
assert.equal(book.canonical.entries[0].activation.constant, true);
assert.ok(book.canonical.entries.some((entry) => entry.activation.primaryKeys.includes("决策")));
assert.equal(getOfficialWorldBook("missing", "zh-CN"), null);
const meetingBook = getOfficialWorldBook("world-book-meeting-operations", "zh-CN");
assert.equal(meetingBook.canonical.entries.length, 4);
assert.ok(meetingBook.canonical.entries.some((entry) => entry.activation.primaryKeys.includes("负责人")));
assert.equal(meetingBook.canonical.scanPolicy.tokenBudget, 1900);
const regulatedBooks = [
  getOfficialWorldBook("world-book-healthcare-operations", "zh-CN"),
  getOfficialWorldBook("world-book-legal-compliance", "zh-CN"),
  getOfficialWorldBook("world-book-finance-accounting", "zh-CN"),
  getOfficialWorldBook("world-book-cybersecurity", "zh-CN"),
];
assert.ok(regulatedBooks.every((entry) => entry.canonical.entries.some((item) => item.activation.constant)));
assert.ok(regulatedBooks.every((entry) => entry.canonical.entries.every((item) => item.content.length >= 40)));
assert.ok(regulatedBooks.every((entry) => /不|not|professional|律师|医生|counsel|clinician|licensed/iu.test(
  entry.canonical.entries.map((item) => item.content).join(" "),
)));
assert.equal(getOfficialWorldBook("world-book-healthcare-operations", "ar").locale, "en");

function activate(book, text) {
  const canonical = normalizeWorldBookCanonical(book.canonical);
  return resolveWorldBookActivation({
    bookRevision: { canonical },
    corpus: buildScanCorpus({
      messages: [{ seq: 1, role: "user", speakerName: "User", text }],
      scanPolicy: canonical.scanPolicy,
    }),
    seedIdentity: { ownerScope: "official-catalog-test", sessionId: book.id, turnId: "turn-1" },
    compatibilityProfile: "lily-character-compat-1",
  });
}

for (const summary of books) {
  const full = getOfficialWorldBook(summary.id, "zh-CN");
  const constantIds = new Set(full.canonical.entries
    .filter((entry) => entry.activation.constant)
    .map((entry) => entry.id));
  const unrelated = activate(full, "今天天气不错，想聊点完全无关的事情。");
  assert.deepEqual(
    unrelated.activated.map((entry) => entry.entryId).filter((id) => !constantIds.has(id)),
    [],
    `${summary.id} should not activate non-constant entries for unrelated text`,
  );
  for (const entry of full.canonical.entries.filter((item) => !item.activation.constant)) {
    const key = entry.activation.primaryKeys[0];
    assert.ok(key, `${summary.id}/${entry.id} has a primary trigger`);
    const activated = activate(full, key);
    assert.ok(
      activated.activated.some((item) => item.entryId === entry.id),
      `${summary.id}/${entry.id} activates from its primary trigger`,
    );
  }
}

console.log("PASS: test-official-context-catalog");
