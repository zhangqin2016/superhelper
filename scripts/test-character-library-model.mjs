import assert from "node:assert/strict";

const {
  initialCharacterLibraryState,
  normalizeLibraryItem,
  deriveLibraryGroups,
  filterLibraryItems,
  sortLibraryItems,
  reduceCharacterLibrary,
} = await import("../src/renderer/modules/character-library-model.js");

const official = normalizeLibraryItem("characters", {
  id: "official:product-manager",
  name: "资深产品经理",
  summary: "把模糊需求变成可验收方案",
  categoryId: "work-delivery",
  source: "official",
  editorialOrder: 10,
  tags: ["需求", "PRD", "验收"],
  recentlyUsedAt: "2026-08-03T12:00:00.000Z",
});
const local = normalizeLibraryItem("characters", {
  id: "local:writer",
  name: "内容编辑",
  description: "整理和校验文章。",
  tags: ["写作", "校验"],
  sourceKind: "created",
});
const malformedLegacy = normalizeLibraryItem("characters", {
  id: "legacy:one",
  displayName: "旧角色",
  unknownNested: { shouldNotSurvive: true },
});
const archived = normalizeLibraryItem("characters", {
  id: "local:archived",
  name: "归档角色",
  archivedAt: "2026-08-01T00:00:00.000Z",
});

assert.equal(official.kind, "character");
assert.equal(official.source, "official");
assert.equal(official.categoryId, "work-delivery");
assert.deepEqual(official.tags, ["需求", "PRD", "验收"]);
assert.equal(local.source, "local");
assert.equal(malformedLegacy.name, "旧角色");
assert.equal("unknownNested" in malformedLegacy, false);
assert.equal(archived.archived, true);

const groups = deriveLibraryGroups("characters", [official, local, archived]);
assert.deepEqual(groups.map((group) => group.id), [
  "all", "official", "work-delivery", "uncategorized", "my", "recent", "archived",
]);
assert.equal(groups.find((group) => group.id === "all").count, 2);
assert.equal(groups.find((group) => group.id === "official").count, 1);
assert.equal(groups.find((group) => group.id === "archived").count, 1);

const searchable = [official, local, malformedLegacy];
assert.deepEqual(
  filterLibraryItems(searchable, { query: "验收" }).map((item) => item.id),
  [official.id],
);
assert.deepEqual(
  filterLibraryItems(searchable, { query: "旧角色" }).map((item) => item.id),
  [malformedLegacy.id],
);
assert.deepEqual(
  filterLibraryItems(searchable, { tag: "写" }).map((item) => item.id),
  [local.id],
);
assert.deepEqual(
  filterLibraryItems([official, local, archived], { groupId: "official" }).map((item) => item.id),
  [official.id],
);

const ordered = sortLibraryItems([local, official, archived], { now: Date.parse("2026-08-04T00:00:00.000Z") });
assert.deepEqual(ordered.map((item) => item.id), [official.id, local.id, archived.id]);
assert.deepEqual(sortLibraryItems(ordered).map((item) => item.id), ordered.map((item) => item.id));

let state = initialCharacterLibraryState({
  open: true,
  items: { characters: [official, local], personas: [], books: [] },
});
state = reduceCharacterLibrary(state, { type: "group.changed", groupId: "official" });
assert.equal(state.groupId, "official");
state = reduceCharacterLibrary(state, { type: "detail.selected", itemId: official.id });
assert.equal(state.selectedItemId, official.id);
assert.equal(state.activation.status, "idle");
state = reduceCharacterLibrary(state, { type: "activation.started", itemId: official.id });
assert.equal(state.activation.status, "running");
state = reduceCharacterLibrary(state, { type: "activation.failed", itemId: official.id, error: "CONFLICT" });
assert.equal(state.activation.status, "error");
assert.equal(state.selectedItemId, official.id);
state = reduceCharacterLibrary(state, { type: "activation.settled", itemId: official.id });
assert.equal(state.activation.status, "settled");
assert.equal(state.selectedItemId, official.id);

console.log("PASS: test-character-library-model");
