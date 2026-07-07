#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderFinal } from "../src/renderer/modules/turn-final-renderer.js";

function classList(hasSealed) {
  return {
    contains(name) {
      return name === "is-sealed" && hasSealed;
    },
  };
}

const calls = [];
const article = {
  classList: classList(true),
  querySelector(selector) {
    calls.push(["query", selector]);
    return selector === ".assistant-turn-report" ? null : undefined;
  },
};
renderFinal(article, { turnId: "turn_1", final: { type: "turn.completed" } }, { text: "Answer" }, {
  translate: (key) => key === "message.resultLabel" ? "Result" : key,
  makeView: (turn, narrative, options) => {
    calls.push(["view", turn.turnId, narrative.text, options.hasExistingReport, options.sealed, options.translate("message.resultLabel")]);
    return { label: "Result", text: narrative.text, sealed: options.sealed };
  },
  forgetMarkdown: (turnId) => calls.push(["forget", turnId]),
  renderReport: (target, view) => calls.push(["render", target === article, view]),
});
assert.deepEqual(calls, [
  ["query", ".assistant-turn-report"],
  ["view", "turn_1", "Answer", false, true, "Result"],
  ["forget", "turn_1"],
  ["render", true, { label: "Result", text: "Answer", sealed: true }],
]);

const skipped = [];
renderFinal(
  {
    classList: classList(false),
    querySelector: () => ({ existing: true }),
  },
  { turnId: "turn_2" },
  null,
  {
    makeView: () => null,
    forgetMarkdown: () => skipped.push("forget"),
    renderReport: () => skipped.push("render"),
  },
);
assert.deepEqual(skipped, [], "missing final view should not forget markdown or render a report");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderFinal"),
  false,
  "turn-view-renderer should delegate final report coordination to turn-final-renderer",
);

console.log("turn-final-renderer: ok");
