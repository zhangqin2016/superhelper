#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderTurnPromptsSlot } from "../src/renderer/modules/turn-prompts-slot.js";

const root = { id: "prompts" };
const article = {
  querySelector(selector) {
    assert.equal(selector, '[data-role="prompts"]');
    return root;
  },
};
const calls = [];
const viewModel = { prompts: { signature: "sig_1" } };

renderTurnPromptsSlot(article, "session_1", { turnId: "turn_1" }, viewModel, {
  renderPromptRoot: (target, sessionId, turn, prompts, options) => {
    calls.push(["render", target.id, sessionId, turn.turnId, prompts.signature, Object.keys(options.renderers).sort().join(",")]);
  },
  renderers: {
    question: () => {},
    permission: () => {},
  },
});
assert.deepEqual(calls, [["render", "prompts", "session_1", "turn_1", "sig_1", "permission,question"]]);

renderTurnPromptsSlot(article, "", { turnId: "turn_2" }, viewModel, {
  renderPromptRoot: () => {
    throw new Error("missing session id should skip prompt rendering");
  },
});

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("promptRenderers"),
  false,
  "turn-view-renderer should not own prompt renderer maps",
);
assert.equal(
  rendererSource.includes("renderPrompts("),
  false,
  "turn-view-renderer should delegate prompt slot rendering",
);

console.log("turn-prompts-slot: ok");
