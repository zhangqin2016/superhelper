#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  collectDetailsOpenState,
  detailsOpenStateKey,
  restoreDetailsOpenState,
} from "../src/renderer/modules/turn-details-open-state.js";

function detail({ toolId = "", thinkingId = "", className = "", open = false } = {}) {
  return {
    dataset: { toolId, thinkingId },
    className,
    open,
    classList: {
      contains(value) {
        return className.split(/\s+/).includes(value);
      },
    },
  };
}

function root(details) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, "details");
      return details;
    },
  };
}

assert.equal(detailsOpenStateKey(detail({ toolId: "tool_1", className: "ignored" })), "tool_1");
assert.equal(detailsOpenStateKey(detail({ thinkingId: "think_1" })), "thinking:think_1");
assert.equal(detailsOpenStateKey(detail({ className: "assistant-process-group" })), "assistant-process-group");

const before = [
  detail({ toolId: "tool_1", open: true }),
  detail({ thinkingId: "think_1", open: true }),
  detail({ className: "assistant-process-group", open: false }),
];
const openState = collectDetailsOpenState(root(before));
assert.equal(openState.get("tool_1"), true);
assert.equal(openState.get("thinking:think_1"), true);
assert.equal(openState.get("assistant-process-group"), false);

const after = [
  detail({ toolId: "tool_1", open: false }),
  detail({ thinkingId: "think_1", className: "assistant-process-thinking-group", open: true }),
  detail({ className: "assistant-process-group", open: true }),
];
restoreDetailsOpenState(root(after), openState, { collapseFinishedThinking: true });
assert.equal(after[0].open, true, "tool details should restore user-opened state");
assert.equal(after[1].open, false, "finished thinking groups should collapse when sealing");
assert.equal(after[2].open, false, "class-keyed groups should restore previous state");

console.log("turn-details-open-state: ok");
