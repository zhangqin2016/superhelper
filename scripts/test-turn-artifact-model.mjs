#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  artifactBlocksFromArtifacts,
  inferArtifactType,
  mergeTurnResultBlocks,
  shouldHideImageResultBlock,
  turnResultBlockKey,
} from "../src/renderer/modules/turn-artifact-model.js";
import {
  mergeTurnResultBlocks as compatMergeTurnResultBlocks,
} from "../src/renderer/modules/turn-view-model.js";

assert.equal(inferArtifactType({ path: "/tmp/scene.svg" }), "image");
assert.equal(inferArtifactType({ path: "/tmp/movie.mp4" }), "video");
assert.equal(inferArtifactType({ path: "/tmp/voice.wav" }), "audio");
assert.equal(inferArtifactType({ mimeType: "application/pdf" }), "pdf");
assert.equal(inferArtifactType({ path: "/tmp/report.html" }), "html");
assert.equal(inferArtifactType({ mimeType: "text/markdown" }), "markdown");
assert.equal(inferArtifactType({ path: "/tmp/archive.zip" }), "file");

assert.deepEqual(
  artifactBlocksFromArtifacts([
    { id: "a1", path: "/tmp/report.md", mimeType: "text/markdown", bytes: 12 },
  ]),
  [{
    id: "artifact:a1",
    type: "artifact",
    artifactType: "markdown",
    path: "/tmp/report.md",
    relativePath: "/tmp/report.md",
    fileName: "",
    ext: ".md",
    mimeType: "text/markdown",
    bytes: 12,
    updatedAt: 0,
    source: "",
  }],
);

const merged = mergeTurnResultBlocks(
  [{ type: "file", path: "/tmp/report.html", artifactType: "", mimeType: "", bytes: 0 }],
  [{ path: "/tmp/report.html", mimeType: "text/html", bytes: 4096, relativePath: "output/report.html" }],
);
assert.equal(merged.length, 1);
assert.equal(merged[0].artifactType, "html");
assert.equal(merged[0].mimeType, "text/html");
assert.equal(merged[0].bytes, 4096);
assert.deepEqual(
  compatMergeTurnResultBlocks([{ type: "file", path: "/tmp/report.pdf" }], []),
  mergeTurnResultBlocks([{ type: "file", path: "/tmp/report.pdf" }], []),
  "turn-view-model should keep re-export compatibility for existing callers",
);

assert.equal(
  shouldHideImageResultBlock({ source: "content_block", type: "image" }, { hasInlineImages: false }),
  true,
);
assert.equal(shouldHideImageResultBlock({ path: "/tmp/scene.svg" }, { hasInlineImages: true }), true);
assert.equal(shouldHideImageResultBlock({ path: "/tmp/scene.svg" }, { hasInlineImages: false }), false);
assert.equal(
  turnResultBlockKey({ id: "inline", type: "markdown", text: "hello" }),
  "inline:markdown:::::5:4bj995",
);

const blockRendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-block-renderers.js", import.meta.url),
  "utf8",
);
assert.match(
  blockRendererSource,
  /from "\.\/turn-artifact-model\.js"/,
  "DOM result block renderer should depend on the narrow artifact model",
);
assert.doesNotMatch(
  blockRendererSource,
  /from "\.\/turn-view-model\.js"/,
  "DOM result block renderer should not import the whole turn view model",
);

console.log("turn-artifact-model: ok");
