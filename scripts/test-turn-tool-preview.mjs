#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { toolPreview } from "../src/renderer/modules/turn-tool-preview.js";
import { toolPreview as compatToolPreview } from "../src/renderer/modules/turn-timeline.js";

assert.equal(toolPreview({ name: "Read", input: { file_path: "a.js" } }), "Read a.js");
assert.equal(
  toolPreview({ name: "Bash", partialJson: '{"command":"npm test"}' }),
  "Bash npm test",
  "partialJson should parse when input is still empty",
);
assert.equal(
  toolPreview({ name: "Bash", input: { command: "echo ok" }, partialJson: '{"command":"npm test"}' }),
  "Bash echo ok",
  "explicit input should win over stale partialJson",
);
assert.equal(
  toolPreview({ name: "Bash", partialJson: '{"command"' }),
  "Bash",
  "truncated partialJson should fail open to the regular preview",
);
assert.equal(compatToolPreview({ name: "Read", input: { file_path: "a.js" } }), "Read a.js");

for (const file of [
  "turn-timeline.js",
  "turn-tool-model.js",
  "turn-tool-row.js",
  "turn-subagent-panel.js",
]) {
  const source = readFileSync(
    new URL(`../src/renderer/modules/${file}`, import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\/turn-tool-preview\.js"/, `${file} should import toolPreview from turn-tool-preview`);
}

const timelineSource = readFileSync(
  new URL("../src/renderer/modules/turn-timeline.js", import.meta.url),
  "utf8",
);
assert.doesNotMatch(timelineSource, /function toolPreview\s*\(/);
assert.doesNotMatch(timelineSource, /buildToolPreviewLabel/);

console.log("turn-tool-preview: ok");
