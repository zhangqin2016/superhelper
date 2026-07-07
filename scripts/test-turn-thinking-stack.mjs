#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderThinkingStack } from "../src/renderer/modules/turn-thinking-stack.js";

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

assert.equal(renderThinkingStack([]), null, "empty thinking stacks should not render");
assert.equal(
  renderThinkingStack([{ kind: "thinking", id: "blank", text: "   " }]),
  null,
  "blank thinking entries should not render a stack",
);

const stack = renderThinkingStack(
  [
    { kind: "thinking", id: "first", text: " first " },
    { kind: "tool", id: "ignored", text: "tool" },
    { kind: "thinking", id: "second", text: "second" },
  ],
  {
    groupSummary: (entries) => `Grouped ${entries.length}`,
    renderEntry: (entry) => {
      const node = document.createElement("details");
      node.dataset.thinkingId = entry.id;
      return node;
    },
  },
);
assert.equal(stack.className, "assistant-process-thinking-group assistant-process-thinking-stack");
assert.equal(stack.dataset.thinkingGroup, "true");
assert.equal(stack.open, false, "thinking stacks should start collapsed");
assert.equal(stack.children[0].className, "assistant-process-thinking-summary");
assert.equal(stack.children[0].textContent, "Grouped 2");
assert.equal(stack.children[1].className, "assistant-process-thinking-stack-body");
assert.deepEqual(
  stack.children[1].children.map((child) => child.dataset.thinkingId),
  ["first", "second"],
);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderThinkingStack"),
  false,
  "turn-view-renderer should delegate thinking stack DOM to turn-thinking-stack",
);

console.log("turn-thinking-stack: ok");
