#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderInlineTextEntry } from "../src/renderer/modules/turn-inline-text.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    dataset: {},
  };
}

globalThis.document = {
  createElement(tagName) {
    return element(tagName);
  },
};

assert.equal(
  renderInlineTextEntry({ id: "empty", text: "   " }),
  null,
  "blank inline text entries should not render DOM",
);

const liveEvents = [];
const liveNode = renderInlineTextEntry({ id: "live_1", text: " hello " }, true, {
  renderStreaming(root, text) {
    liveEvents.push(["stream", root.className, text]);
  },
  renderContent() {
    throw new Error("live text should not use full content render");
  },
});
assert.equal(liveNode.className, "assistant-turn-inline-text markdown-body");
assert.equal(liveNode.dataset.textId, "live_1");
assert.deepEqual(liveEvents, [["stream", "assistant-turn-inline-text markdown-body", "hello"]]);

const sealedEvents = [];
const sealedNode = renderInlineTextEntry({ id: "sealed_1", text: " **done** " }, false, {
  renderStreaming() {
    throw new Error("sealed text should not use streaming render");
  },
  renderContent(root, text) {
    sealedEvents.push(["content", root.className, text]);
  },
});
assert.equal(sealedNode.dataset.textId, "sealed_1");
assert.deepEqual(sealedEvents, [["content", "assistant-turn-inline-text markdown-body", "**done**"]]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderInlineTextEntry"),
  false,
  "turn-view-renderer should consume the inline text renderer instead of owning it",
);

console.log("turn-inline-text: ok");
