#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  inlineImageKeyForContentBlocks,
  inlineImagesForNarrative,
} from "../src/renderer/modules/turn-narrative-inline-images.js";

const contentBlocks = [
  { blockType: "text", text: "ignored" },
  { blockType: "image", data: "iVBORw0KGgo=", mediaType: "image/png", alt: "chart" },
  { blockType: "image", data: "app-blob://inline-image", mediaType: "image/png", alt: "resolved" },
  { blockType: "image", data: "", mediaType: "image/png", alt: "empty" },
];

assert.equal(
  inlineImageKeyForContentBlocks(contentBlocks),
  "image/png:12|image/png:23",
  "inline image key should include only renderable image data and preserve legacy mediaType:length format",
);
assert.deepEqual(
  inlineImagesForNarrative(contentBlocks),
  [
    { src: "data:image/png;base64,iVBORw0KGgo=", alt: "chart" },
    { src: "app-blob://inline-image", alt: "resolved" },
  ],
  "inline image view should wrap raw base64 while passing resolved URLs through",
);
assert.deepEqual(
  inlineImagesForNarrative([{ blockType: "image", data: "abc", mimeType: "image/jpeg" }]),
  [{ src: "data:image/jpeg;base64,abc", alt: "" }],
  "inline image view should fall back to mimeType before defaulting to png",
);

const viewModelSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-model.js", import.meta.url),
  "utf8",
);
assert.match(viewModelSource, /from "\.\/turn-narrative-inline-images\.js"/);
assert.doesNotMatch(viewModelSource, /function inlineImageSrc\s*\(/);
assert.doesNotMatch(viewModelSource, /function inlineImagesForNarrative\s*\(/);
assert.doesNotMatch(viewModelSource, /function narrativeImageKey\s*\(/);

console.log("turn-narrative-inline-images: ok");
