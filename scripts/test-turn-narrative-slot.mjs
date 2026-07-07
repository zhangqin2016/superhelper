#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderTurnNarrativeSlot } from "../src/renderer/modules/turn-narrative-slot.js";

const narrativeEl = { id: "narrative" };
const article = {
  dataset: {},
  querySelector(selector) {
    assert.equal(selector, '[data-role="narrative"]');
    return narrativeEl;
  },
};
const liveTurn = { turnId: "turn_1" };
const viewModel = {
  narrative: { key: "key_1", text: "hello" },
  artifacts: { resultBlocks: [{ path: "/tmp/a.md" }] },
};
const calls = [];

renderTurnNarrativeSlot(article, liveTurn, viewModel, {
  sealed: true,
  sessionId: "session_1",
  renderNarrativeSlot: (root, turn, options) => calls.push(["render", root.id, turn.turnId, options.sealed, options.narrative.text]),
  enhanceMentions: (root, sessionId, blocks) => calls.push(["mentions", root.id, sessionId, blocks[0].path]),
});

assert.equal(article.dataset.narrativeKey, "key_1");
assert.deepEqual(calls, [
  ["render", "narrative", "turn_1", true, "hello"],
  ["mentions", "narrative", "session_1", "/tmp/a.md"],
]);

renderTurnNarrativeSlot(article, liveTurn, viewModel, {
  sealed: true,
  sessionId: "session_1",
  renderNarrativeSlot: () => {
    throw new Error("same narrative key should skip re-render");
  },
  enhanceMentions: () => {
    throw new Error("same narrative key should skip mention enhancement");
  },
});

const draftArticle = { dataset: {}, querySelector: () => narrativeEl };
const draftCalls = [];
renderTurnNarrativeSlot(draftArticle, liveTurn, viewModel, {
  sealed: false,
  sessionId: "session_1",
  renderNarrativeSlot: () => draftCalls.push("render"),
  enhanceMentions: () => draftCalls.push("mentions"),
});
assert.deepEqual(draftCalls, ["render"], "live narrative should not enhance file mentions mid-stream");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("enhanceFileMentions"),
  false,
  "turn-view-renderer should delegate narrative file mention enhancement",
);
assert.equal(
  rendererSource.includes("dataset.narrativeKey"),
  false,
  "turn-view-renderer should delegate narrative key caching",
);

console.log("turn-narrative-slot: ok");
