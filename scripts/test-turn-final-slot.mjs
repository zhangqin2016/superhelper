#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderTurnFinalSlot } from "../src/renderer/modules/turn-final-slot.js";

const article = { id: "article" };
const calls = [];
const liveTurn = { turnId: "turn_1", final: { type: "turn.completed" }, finalRendered: false };
const narrative = { text: "answer" };

renderTurnFinalSlot(article, liveTurn, narrative, {
  renderFinalReport: (target, turn, view) => calls.push(["render", target.id, turn.turnId, view.text]),
});
assert.equal(liveTurn.finalRendered, true);
assert.deepEqual(calls, [["render", "article", "turn_1", "answer"]]);

renderTurnFinalSlot(article, liveTurn, narrative, {
  renderFinalReport: () => {
    throw new Error("already rendered final should not render again");
  },
});

const noFinal = { turnId: "turn_2", finalRendered: false };
renderTurnFinalSlot(article, noFinal, narrative, {
  renderFinalReport: () => {
    throw new Error("turn without final should not render");
  },
});
assert.equal(noFinal.finalRendered, false);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("finalRendered"),
  false,
  "turn-view-renderer should delegate finalRendered gating",
);

console.log("turn-final-slot: ok");
