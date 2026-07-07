#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderPrompts } from "../src/renderer/modules/turn-prompts-renderer.js";

function element(tagName) {
  return {
    tagName,
    dataset: {},
    hidden: false,
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
    replaceChildren(...children) {
      this.children = children;
    },
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

const calls = [];
const root = element("div");
const promptView = {
  signature: "sig_1",
  visible: true,
  activeQuestionRequestIds: new Set(["q1"]),
  entries: [
    { requestId: "q1", kind: "question" },
    { requestId: "p1", kind: "permission" },
  ],
};
const renderers = {
  question: (sessionId, item) => {
    calls.push(["question", sessionId, item.requestId]);
    return element("question");
  },
  permission: (sessionId, item) => {
    calls.push(["permission", sessionId, item.requestId]);
    return element("permission");
  },
};

renderPrompts(root, "session_1", {}, promptView, {
  pruneDrafts: (sessionId, activeIds) => calls.push(["prune", sessionId, [...activeIds]]),
  kindForItem: (item) => item.kind,
  rendererKeyForKind: (kind) => kind,
  renderers,
});
assert.equal(root.dataset.promptsSig, "sig_1");
assert.equal(root.hidden, false);
assert.equal(root.children.length, 2);
assert.deepEqual(calls, [
  ["prune", "session_1", ["q1"]],
  ["question", "session_1", "q1"],
  ["permission", "session_1", "p1"],
]);

renderPrompts(root, "session_1", {}, promptView, {
  pruneDrafts: (sessionId, activeIds) => calls.push(["prune-again", sessionId, [...activeIds]]),
  kindForItem: (item) => item.kind,
  rendererKeyForKind: (kind) => kind,
  renderers,
});
assert.equal(root.children.length, 2, "unchanged prompt signatures should not rebuild cards");
assert.deepEqual(calls.at(-1), ["prune-again", "session_1", ["q1"]]);

renderPrompts(root, "session_1", {}, {
  ...promptView,
  signature: "sig_2",
  visible: false,
  entries: [],
}, {
  pruneDrafts: () => {},
  kindForItem: (item) => item.kind,
  rendererKeyForKind: (kind) => kind,
  renderers,
});
assert.equal(root.dataset.promptsSig, "sig_2");
assert.equal(root.hidden, true);
assert.equal(root.children.length, 0);

renderPrompts(null, "session_1", {}, promptView, {
  pruneDrafts: () => {
    throw new Error("null roots should return before pruning");
  },
});

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderPrompts"),
  false,
  "turn-view-renderer should delegate prompt root rendering to turn-prompts-renderer",
);

console.log("turn-prompts-renderer: ok");
