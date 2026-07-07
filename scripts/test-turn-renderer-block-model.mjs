#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  artifactDisplayName,
  artifactSourceUrl,
  bytesText,
  dataUrl,
  fileUrlFromPath,
} from "../src/renderer/modules/turn-renderer-block-model.js";

assert.equal(fileUrlFromPath("https://example.com/a.png"), "https://example.com/a.png");
assert.equal(fileUrlFromPath("app-blob://inline"), "app-blob://inline");
assert.equal(fileUrlFromPath("/tmp/generated image.png"), "app-file://media/%2Ftmp%2Fgenerated%20image.png");
assert.equal(fileUrlFromPath("C:\\Users\\me\\scene.png"), "app-file://media/C%3A%5CUsers%5Cme%5Cscene.png");
assert.equal(fileUrlFromPath("file:///tmp/generated%20image.png"), "app-file://media/%2Ftmp%2Fgenerated%20image.png");
assert.equal(fileUrlFromPath("relative/path.png"), "relative/path.png");

assert.equal(dataUrl({ data: "abc", mimeType: "image/jpeg" }), "data:image/jpeg;base64,abc");
assert.equal(dataUrl({ data: "app-blob://inline" }), "app-blob://inline");
assert.equal(dataUrl({}), "");
assert.equal(artifactSourceUrl({ data: "abc", mimeType: "image/png", path: "/tmp/ignored.png" }), "data:image/png;base64,abc");
assert.equal(artifactSourceUrl({ path: "/tmp/generated.png" }), "app-file://media/%2Ftmp%2Fgenerated.png");

assert.equal(bytesText(12), "12 B");
assert.equal(bytesText(1536), "1.5 KB");
assert.equal(bytesText(2 * 1024 * 1024), "2.0 MB");
assert.equal(bytesText(0), "");
assert.equal(artifactDisplayName({ relativePath: "out/report.md" }), "out/report.md");
assert.equal(artifactDisplayName({}, "Untitled"), "Untitled");

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-block-renderers.js", import.meta.url),
  "utf8",
);
assert.match(rendererSource, /from "\.\/turn-renderer-block-model\.js"/);
assert.doesNotMatch(rendererSource, /function fileUrlFromPath\s*\(/);
assert.doesNotMatch(rendererSource, /function bytesText\s*\(/);
assert.doesNotMatch(rendererSource, /function displayName\s*\(/);
assert.doesNotMatch(rendererSource, /function dataUrl\s*\(/);

console.log("turn-renderer-block-model: ok");
