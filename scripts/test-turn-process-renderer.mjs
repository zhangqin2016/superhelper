#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderProcess } from "../src/renderer/modules/turn-process-renderer.js";

function element(tagName = "div") {
  return {
    tagName: tagName.toUpperCase(),
    dataset: {},
    hidden: false,
    children: [],
    replaceChildren(...items) {
      this.children = items;
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

const fullRoot = element();
const fullCalls = [];
renderProcess(fullRoot, { turnId: "turn_1" }, {
  sessionId: "session_1",
  sealed: true,
}, {
  resolveDiffs: () => [{ filePath: "/tmp/a.js" }],
  processSignature: (_turn, sealed, { diffCount }) => `sig:${sealed}:${diffCount}`,
  prepareView: () => ({ hasContent: true, diffKey: "1" }),
  renderTimeline: (view, opts) => {
    fullCalls.push(["timeline", view.diffKey, opts.sealed, opts.sessionId, opts.turnId]);
    return element("section");
  },
  commitDom: (root, list, opts) => {
    fullCalls.push(["commit", list.tagName, opts.sealed, opts.wasSealed]);
    root.appendChild(list);
  },
  reapplyDiffs: (sessionId, turnId) => fullCalls.push(["diffs", sessionId, turnId]),
});
assert.equal(fullRoot.hidden, false);
assert.equal(fullRoot.dataset.sealed, "true");
assert.equal(fullRoot.dataset.processSig, "sig:true:1");
assert.deepEqual(fullCalls, [
  ["timeline", "1", true, "session_1", "turn_1"],
  ["commit", "SECTION", true, false],
  ["diffs", "session_1", "turn_1"],
]);

const emptyRoot = element();
emptyRoot.children = [element("span")];
renderProcess(emptyRoot, {}, {}, {
  resolveDiffs: () => [],
  processSignature: () => "empty",
  prepareView: () => ({ hasContent: false, diffKey: "0" }),
});
assert.equal(emptyRoot.hidden, true);
assert.deepEqual(emptyRoot.children, []);

const patchedRoot = element();
patchedRoot.dataset.processSig = "sig:false:2";
patchedRoot.dataset.diffKey = "1";
const patchedCalls = [];
renderProcess(patchedRoot, { turnId: "turn_2" }, {
  sessionId: "session_2",
  sealed: false,
}, {
  resolveDiffs: () => [{}, {}],
  processSignature: () => "sig:false:2",
  prepareView: () => ({ hasContent: true, diffKey: "2" }),
  patchDom: () => true,
  renderTimeline: () => {
    throw new Error("fast patch should not rebuild process timeline");
  },
  commitDom: () => {
    throw new Error("fast patch should not commit full process DOM");
  },
  reapplyDiffs: (sessionId, turnId) => patchedCalls.push(["diffs", sessionId, turnId]),
});
assert.equal(patchedRoot.hidden, false);
assert.equal(patchedRoot.dataset.diffKey, "2");
assert.deepEqual(patchedCalls, [["diffs", "session_2", "turn_2"]]);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderProcess"),
  false,
  "turn-view-renderer should delegate process rendering to turn-process-renderer",
);

console.log("turn-process-renderer: ok");
