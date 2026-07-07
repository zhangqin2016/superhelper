#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderThinkingEntry } from "../src/renderer/modules/turn-thinking-entry.js";

function element(tagName) {
  const classes = new Set();
  return {
    tagName,
    className: "",
    dataset: {},
    textContent: "",
    open: true,
    children: [],
    classList: {
      add(name) {
        classes.add(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

assert.equal(
  renderThinkingEntry({ id: "blank", text: "   " }),
  null,
  "blank thinking entries should not render",
);

const finished = renderThinkingEntry(
  { id: "think_done", text: " done thinking ", status: "done" },
  true,
  { summaryLabel: () => "Thought" },
);
assert.equal(finished.className, "assistant-process-thinking-group");
assert.equal(finished.dataset.thinkingId, "think_done");
assert.equal(finished.open, false, "thinking details should stay collapsed by default");
assert.equal(finished.classList.contains("is-live"), false, "done thinking should not be marked live");
assert.equal(finished.children[0].className, "assistant-process-thinking-summary");
assert.equal(finished.children[0].textContent, "Thought");
assert.equal(finished.children[1].className, "assistant-process-thinking");
assert.equal(finished.children[1].textContent, "done thinking");

const live = renderThinkingEntry(
  { id: "think_live", text: "still thinking", status: "running" },
  true,
  { summaryLabel: (entry, isLive) => (isLive ? "Thinking live" : "Thought") },
);
assert.equal(live.classList.contains("is-live"), true, "active live thinking should keep the live marker");
assert.equal(live.children[0].textContent, "Thinking live");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderThinkingEntry"),
  false,
  "turn-view-renderer should delegate thinking entry DOM to turn-thinking-entry",
);

console.log("turn-thinking-entry: ok");
