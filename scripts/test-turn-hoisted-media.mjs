#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendHoistedGeneratedMedia } from "../src/renderer/modules/turn-hoisted-media.js";

function node(className = "") {
  return {
    className,
    removed: false,
    remove() {
      this.removed = true;
    },
  };
}

function host({ prev = null } = {}) {
  return {
    hidden: true,
    prev,
    appended: [],
    querySelector(selector) {
      assert.equal(selector, ":scope > .assistant-hoisted-media");
      return this.prev;
    },
    appendChild(child) {
      this.appended.push(child);
    },
  };
}

function article(hostNode = null) {
  return {
    querySelector(selector) {
      assert.equal(selector, '[data-role="artifacts"]');
      return hostNode;
    },
  };
}

const created = [];
globalThis.document = {
  createElement(tagName) {
    assert.equal(tagName, "div");
    const el = node();
    created.push(el);
    return el;
  },
};

appendHoistedGeneratedMedia(article(null), [{ type: "image" }], {
  renderMedia() {
    throw new Error("should not render without host");
  },
});

const previous = node("assistant-hoisted-media");
const emptyHost = host({ prev: previous });
appendHoistedGeneratedMedia(article(emptyHost), [], {
  renderMedia() {
    throw new Error("should not render without blocks");
  },
});
assert.equal(previous.removed, true, "existing hoisted media should be removed before syncing");
assert.equal(emptyHost.appended.length, 0, "empty media blocks should not append a wrapper");
assert.equal(emptyHost.hidden, true, "empty media blocks should leave artifacts hidden");

const mediaHost = host();
const rendered = [];
appendHoistedGeneratedMedia(article(mediaHost), [{ type: "image", files: [] }], {
  sessionId: "session_1",
  renderMedia(root, blocks, options) {
    rendered.push({ root, blocks, options });
  },
});
assert.equal(mediaHost.appended.length, 1, "generated media should append one hoisted wrapper");
assert.equal(mediaHost.appended[0].className, "assistant-hoisted-media");
assert.equal(mediaHost.hidden, false, "generated media should make the artifacts host visible");
assert.deepEqual(rendered[0].blocks, [{ type: "image", files: [] }]);
assert.deepEqual(rendered[0].options, { sessionId: "session_1" });

const errorHost = host();
appendHoistedGeneratedMedia(article(errorHost), [{ type: "image" }], {
  renderMedia() {
    throw new Error("media render failed");
  },
});
assert.equal(errorHost.appended.length, 0, "media render failure should not append a broken wrapper");
assert.equal(errorHost.hidden, true, "media render failure should leave artifacts hidden");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function appendHoistedGeneratedMedia"),
  false,
  "turn-view-renderer should consume the hoisted media helper instead of owning it",
);

console.log("turn-hoisted-media: ok");
