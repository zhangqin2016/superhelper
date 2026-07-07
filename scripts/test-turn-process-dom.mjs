#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commitProcessDom } from "../src/renderer/modules/turn-process-dom.js";

function node(tagName = "DIV") {
  return {
    tagName,
    open: false,
    children: [],
    replacedWith: null,
    cloned: false,
    appendChild(child) {
      this.children.push(child);
    },
    replaceChildren(child) {
      this.replacedWith = child;
      this.children = [child];
    },
    cloneNode() {
      return { ...node(this.tagName), cloned: true };
    },
    isEqualNode() {
      return false;
    },
  };
}

const calls = [];
const sealedRoot = node();
const sealedList = node("SECTION");
commitProcessDom(sealedRoot, sealedList, { sealed: true, wasSealed: false }, {
  collectOpenState: (root) => {
    calls.push(["collect", root === sealedRoot]);
    return { kept: true };
  },
  restoreOpenState: (root, state, options) => {
    calls.push(["restore", root === sealedRoot, state, options]);
  },
  morph: () => {
    throw new Error("sealed commit should not morph");
  },
});
assert.equal(sealedRoot.replacedWith, sealedList);
assert.deepEqual(calls, [
  ["collect", true],
  ["restore", true, { kept: true }, { collapseFinishedThinking: true }],
]);

let disposed = false;
const liveRoot = node("DIV");
const liveList = node("SECTION");
let morphOptions = null;
commitProcessDom(liveRoot, liveList, { sealed: false, wasSealed: false }, {
  morph: (from, to, options) => {
    assert.equal(from, liveRoot);
    assert.equal(to.cloned, true);
    assert.equal(to.children[0], liveList);
    morphOptions = options;
  },
});
assert.equal(morphOptions.childrenOnly, true);
const fromDetails = { tagName: "DETAILS", open: true, isEqualNode: () => false };
const toDetails = { tagName: "DETAILS", open: false };
assert.equal(morphOptions.onBeforeElUpdated(fromDetails, toDetails), true);
assert.equal(toDetails.open, true, "live morph should preserve expanded details");
morphOptions.onNodeDiscarded({ __disposeRenderer: () => { disposed = true; } });
assert.equal(disposed, true);
morphOptions.onNodeDiscarded({ __disposeRenderer: () => { throw new Error("ignore"); } });

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function commitProcessDom"),
  false,
  "turn-view-renderer should delegate process DOM commits to turn-process-dom",
);

console.log("turn-process-dom: ok");
