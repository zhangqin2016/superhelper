#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncNarrativeImages } from "../src/renderer/modules/turn-narrative-images.js";

function imageNode(key) {
  return {
    key,
    removed: false,
    remove() {
      this.removed = true;
    },
  };
}

function root({ imageKey = "", existing = [] } = {}) {
  return {
    dataset: { imageKey },
    appended: [],
    existing,
    querySelectorAll(selector) {
      assert.equal(selector, ".assistant-content-image");
      return this.existing;
    },
    appendChild(node) {
      this.appended.push(node);
    },
  };
}

const created = [];
globalThis.document = {
  createElement(tagName) {
    assert.equal(tagName, "img");
    const node = { tagName, className: "", alt: "", src: "" };
    created.push(node);
    return node;
  },
};

const unchanged = root({ imageKey: "same", existing: [imageNode("old")] });
syncNarrativeImages(unchanged, [{ src: "data:image/png;base64,abc", alt: "Preview" }], "same");
assert.equal(unchanged.appended.length, 0, "same image key should not re-append inline images");
assert.equal(unchanged.existing[0].removed, false, "same image key should not remove existing inline images");

const stale = imageNode("stale");
const changed = root({ imageKey: "old", existing: [stale] });
syncNarrativeImages(changed, [
  { src: "data:image/png;base64,one", alt: "One" },
  { src: "data:image/png;base64,two" },
], "new");

assert.equal(changed.dataset.imageKey, "new", "new image key should be cached on the narrative root");
assert.equal(stale.removed, true, "changed image key should remove stale inline images");
assert.equal(changed.appended.length, 2, "changed image key should append all prepared inline images");
assert.equal(created[0].className, "assistant-content-image");
assert.equal(created[0].alt, "One");
assert.equal(created[0].src, "data:image/png;base64,one");
assert.equal(created[1].alt, "Assistant image", "missing alt should keep the legacy fallback");
assert.equal(created[1].src, "data:image/png;base64,two");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function syncNarrativeImages"),
  false,
  "turn-view-renderer should consume the narrative image sync helper instead of owning it",
);

console.log("turn-narrative-images: ok");
