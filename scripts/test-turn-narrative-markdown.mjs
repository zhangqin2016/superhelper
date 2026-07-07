#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  forgetNarrativeMarkdownTurn,
  scheduleNarrativeMarkdown,
} from "../src/renderer/modules/turn-narrative-markdown.js";

function textEl() {
  return { dataset: {} };
}

function deps(events) {
  let nextTimer = 1;
  const timers = new Map();
  return {
    renderStreaming(el, text) {
      events.push(["stream", text]);
    },
    renderFinal(el, text) {
      events.push(["final", text]);
    },
    setTimeoutFn(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, ms, cleared: false });
      events.push(["timer", id, ms]);
      return id;
    },
    clearTimeoutFn(id) {
      const timer = timers.get(id);
      if (timer) timer.cleared = true;
      events.push(["clear", id]);
    },
    runTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer, `missing timer ${id}`);
      if (!timer.cleared) timer.fn();
    },
  };
}

const firstEvents = [];
const firstDeps = deps(firstEvents);
const firstEl = textEl();
scheduleNarrativeMarkdown(firstEl, "hello", "turn_md_first", {
  ...firstDeps,
  delayMs: 5,
});
assert.deepEqual(firstEvents, [["stream", "hello"]], "first streamed text should render immediately");
assert.equal(firstEl.dataset.streamText, "hello");
assert.equal(firstEl.dataset.renderMode, "stream");

scheduleNarrativeMarkdown(firstEl, "hello", "turn_md_first", {
  ...firstDeps,
  delayMs: 5,
});
assert.deepEqual(firstEvents, [["stream", "hello"]], "unchanged streamed text should not render again");
forgetNarrativeMarkdownTurn("turn_md_first");

const updateEvents = [];
const updateDeps = deps(updateEvents);
const updateEl = textEl();
scheduleNarrativeMarkdown(updateEl, "one", "turn_md_update", { ...updateDeps, delayMs: 5 });
scheduleNarrativeMarkdown(updateEl, "two", "turn_md_update", { ...updateDeps, delayMs: 5 });
scheduleNarrativeMarkdown(updateEl, "three", "turn_md_update", { ...updateDeps, delayMs: 5 });
assert.deepEqual(
  updateEvents,
  [["stream", "one"], ["timer", 1, 5]],
  "streaming updates should coalesce behind one pending timer",
);
updateDeps.runTimer(1);
assert.deepEqual(
  updateEvents,
  [["stream", "one"], ["timer", 1, 5], ["stream", "three"]],
  "pending timer should render the latest text only",
);
assert.equal(updateEl.dataset.streamText, "three");
forgetNarrativeMarkdownTurn("turn_md_update");

const sealedEvents = [];
const sealedDeps = deps(sealedEvents);
const sealedEl = textEl();
scheduleNarrativeMarkdown(sealedEl, "draft", "turn_md_sealed", { ...sealedDeps, delayMs: 5 });
scheduleNarrativeMarkdown(sealedEl, "final", "turn_md_sealed", { ...sealedDeps, delayMs: 5 });
scheduleNarrativeMarkdown(sealedEl, "final", "turn_md_sealed", {
  ...sealedDeps,
  sealed: true,
  delayMs: 5,
});
assert.deepEqual(
  sealedEvents,
  [["stream", "draft"], ["timer", 1, 5], ["clear", 1], ["final", "final"]],
  "sealed render should cancel pending streaming work and upgrade to full markdown",
);
assert.equal(sealedEl.dataset.streamText, "final");
assert.equal(sealedEl.dataset.renderMode, "full");
sealedDeps.runTimer(1);
assert.deepEqual(
  sealedEvents,
  [["stream", "draft"], ["timer", 1, 5], ["clear", 1], ["final", "final"]],
  "cleared pending streaming timer should not overwrite the full sealed render",
);

scheduleNarrativeMarkdown(sealedEl, "final", "turn_md_sealed", {
  ...sealedDeps,
  sealed: true,
  delayMs: 5,
});
assert.deepEqual(
  sealedEvents,
  [["stream", "draft"], ["timer", 1, 5], ["clear", 1], ["final", "final"]],
  "already full-rendered sealed text should not render again",
);
forgetNarrativeMarkdownTurn("turn_md_sealed");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("const narrativeRenderState"),
  false,
  "turn-view-renderer should not own narrative markdown render state",
);
assert.equal(
  rendererSource.includes("function scheduleNarrativeMarkdown"),
  false,
  "turn-view-renderer should consume the narrative markdown scheduler instead of owning it",
);

console.log("turn-narrative-markdown: ok");
