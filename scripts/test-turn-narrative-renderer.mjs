#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderNarrative } from "../src/renderer/modules/turn-narrative-renderer.js";

function element(tagName) {
  return {
    tagName,
    className: "",
    dataset: {},
    hidden: false,
    textContent: "",
    children: [],
    removed: false,
    appendChild(child) {
      this.children.push(child);
    },
    prepend(child) {
      this.children.unshift(child);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    remove() {
      this.removed = true;
    },
    querySelector(selector) {
      if (selector !== ".assistant-turn-narrative-text") return null;
      return this.children.find((child) => child.className === "assistant-turn-narrative-text markdown-body") || null;
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
root.dataset.imageKey = "old";
renderNarrative(root, { turnId: "turn_1" }, {
  sealed: false,
  narrative: {
    visible: true,
    text: "hello",
    inlineImages: [{ url: "image.png" }],
    inlineImageKey: "img_1",
  },
}, {
  scheduleMarkdown: (node, text, turnId, options) => calls.push(["markdown", node.className, text, turnId, options]),
  syncImages: (node, images, key) => calls.push(["images", node === root, images, key]),
});

assert.equal(root.hidden, false);
assert.equal(root.children[0].className, "assistant-turn-narrative-text markdown-body");
assert.deepEqual(calls[0], ["markdown", "assistant-turn-narrative-text markdown-body", "hello", "turn_1", { sealed: false }]);
assert.deepEqual(calls[1], ["images", true, [{ url: "image.png" }], "img_1"]);

renderNarrative(root, { turnId: "turn_1" }, {
  sealed: true,
  narrative: {
    visible: true,
    text: "",
    inlineImages: [],
    inlineImageKey: "",
  },
}, {
  forgetMarkdown: (turnId) => calls.push(["forget", turnId]),
  syncImages: (node, images, key) => calls.push(["images-empty", images, key]),
});
assert.equal(root.children[0].removed, true, "empty narrative text should remove the text node");
assert.deepEqual(calls.at(-2), ["forget", "turn_1"]);

renderNarrative(root, { turnId: "turn_2" }, {
  narrative: {
    visible: false,
    text: "hidden",
  },
}, {
  syncImages: () => {
    throw new Error("hidden narratives should return before syncing images");
  },
});
assert.equal(root.hidden, true);
assert.equal(root.children.length, 0);
assert.equal(root.dataset.imageKey, undefined);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-renderer.js", import.meta.url),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderNarrative"),
  false,
  "turn-view-renderer should delegate narrative rendering to turn-narrative-renderer",
);

console.log("turn-narrative-renderer: ok");
