import assert from "node:assert/strict";

const {
  normalizeLibraryItem,
  filterLibraryItems,
  sortLibraryItems,
} = await import("../src/renderer/modules/character-library-model.js");

function fixture(count) {
  return Array.from({ length: count }, (_, index) => normalizeLibraryItem("characters", {
    id: `character-${index}`,
    name: `角色 ${index}`,
    summary: index % 2 === 0 ? "研究与交付" : "内容与技术",
    categoryId: index % 2 === 0 ? "research-analysis" : "technology-creation",
    source: index % 5 === 0 ? "official" : "local",
    editorialOrder: index,
    tags: index % 2 === 0 ? ["研究", "交付"] : ["技术", "创作"],
    recentlyUsedAt: index < 5 ? `2026-08-03T12:0${index}:00.000Z` : "",
  }));
}

for (const size of [30, 100, 500]) {
  const items = fixture(size);
  const snapshot = items.map((item) => item.id);
  const result = filterLibraryItems(items, { query: "研究", groupId: "research-analysis" });
  assert.ok(result.length > 0);
  assert.deepEqual(items.map((item) => item.id), snapshot, `filter mutates ${size} items`);
  const ordered = sortLibraryItems(items, { now: Date.parse("2026-08-04T00:00:00.000Z") });
  assert.equal(ordered.length, size);
  assert.deepEqual(sortLibraryItems(items, { now: Date.parse("2026-08-04T00:00:00.000Z") }), ordered);
}

console.log("PASS: test-character-library-scale");
