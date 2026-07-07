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

const { renderTurnArticleSlots } = await import("../src/renderer/modules/turn-article-slots.js");

const roots = {
  '[data-role="process"]': { id: "process" },
  '[data-role="taskrun"]': { id: "taskrun" },
};
const article = {
  querySelector(selector) {
    return roots[selector] || null;
  },
};
const liveTurn = { turnId: "turn_1" };
const viewModel = {
  narrative: { text: "answer" },
  prompts: { signature: "prompts" },
  artifacts: { visibleResultBlocks: [{ id: "artifact" }] },
};
const calls = [];

renderTurnArticleSlots(article, liveTurn, viewModel, {
  sessionId: "session_1",
  sealed: true,
}, {
  renderNarrativeSlot: (target, turn, model, opts) => calls.push(["narrative", target === article, turn.turnId, model.narrative.text, opts.sealed, opts.sessionId]),
  renderProcessSlot: (root, turn, opts) => calls.push(["process", root.id, turn.turnId, opts.sealed, opts.sessionId]),
  renderTaskRun: (root, turn, sealed) => calls.push(["taskrun", root.id, turn.turnId, sealed]),
  renderPromptsSlot: (target, sessionId, turn, model) => calls.push(["prompts", target === article, sessionId, turn.turnId, model.prompts.signature]),
  renderFinalSlot: (target, turn, narrative) => calls.push(["final", target === article, turn.turnId, narrative.text]),
  renderArtifactsSlot: (target, artifacts, opts) => calls.push(["artifacts", target === article, artifacts.visibleResultBlocks[0].id, opts.sessionId]),
});

assert.deepEqual(calls, [
  ["narrative", true, "turn_1", "answer", true, "session_1"],
  ["process", "process", "turn_1", true, "session_1"],
  ["taskrun", "taskrun", "turn_1", true],
  ["prompts", true, "session_1", "turn_1", "prompts"],
  ["final", true, "turn_1", "answer"],
  ["artifacts", true, "artifact", "session_1"],
]);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
for (const token of [
  "renderTurnNarrativeSlot(",
  "renderProcess(",
  "renderTaskRunSummary(",
  "renderTurnPromptsSlot(",
  "renderTurnFinalSlot(",
  "renderTurnArtifacts(",
]) {
  assert.equal(
    rendererSource.includes(token),
    false,
    `turn-view-renderer should delegate article slot rendering instead of calling ${token}`,
  );
}

console.log("turn-article-slots: ok");
