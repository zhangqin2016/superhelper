#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.document = {
  createTreeWalker() {
    return {};
  },
  createComment() {
    return {};
  },
  createElement() {
    return {};
  },
};

const { renderTurnArtifacts } = await import("../src/renderer/modules/turn-artifacts-renderer.js");

const calls = [];
const host = { id: "artifacts" };
const article = {
  querySelector(selector) {
    calls.push(["query", selector]);
    return selector === '[data-role="artifacts"]' ? host : null;
  },
};

renderTurnArtifacts(article, {
  visibleResultBlocks: [{ id: "result_1" }],
  hoistedMediaGroups: [{ id: "media_1" }],
}, {
  sessionId: "session_1",
  renderResults: (root, blocks) => calls.push(["results", root.id, blocks.map((block) => block.id).join(",")]),
  appendHoisted: (target, blocks, options) => calls.push(["hoisted", target === article, blocks.map((block) => block.id).join(","), options.sessionId]),
});

assert.deepEqual(calls, [
  ["query", '[data-role="artifacts"]'],
  ["results", "artifacts", "result_1"],
  ["hoisted", true, "media_1", "session_1"],
]);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("renderResultBlocks("),
  false,
  "turn-view-renderer should delegate artifact result rendering",
);
assert.equal(
  rendererSource.includes("appendHoistedGeneratedMedia("),
  false,
  "turn-view-renderer should delegate hoisted generated media rendering",
);

console.log("turn-artifacts-renderer: ok");
