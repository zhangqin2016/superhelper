// Typed block protocol: validation, forward-compat, first-class extraBlocks.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  BLOCK_SCHEMA_VERSION,
  BLOCK_TYPES,
  normalizeBlock,
  buildResultBlocks,
} = require("../src/main/block-protocol.js");

// version bumps when the artifact/result-block contract learns a new persisted type.
assert.equal(BLOCK_SCHEMA_VERSION, 2);

// normalizeBlock: missing type -> null
assert.equal(normalizeBlock(null), null);
assert.equal(normalizeBlock({}), null);

// normalizeBlock: ensures an id
const md = normalizeBlock({ type: "markdown", text: "hi" });
assert.equal(md.type, "markdown");
assert.ok(md.id, "id is generated");

// forward-compat: unknown type passes through (newer producer, older renderer)
const future = normalizeBlock({ type: "timeline-3d", payload: 1 });
assert.equal(future.type, "timeline-3d");
assert.ok(future.id);

// extraBlocks are first-class + validated; invalid ones dropped
const blocks = buildResultBlocks({
  extraBlocks: [
    { type: BLOCK_TYPES.CHART, chartType: "pie", id: "c1" },
    { nope: true }, // no type -> dropped
  ],
  artifacts: [
    { path: "/ws/out.png", mimeType: "image/png", bytes: 10 },
    { path: "/ws/out.png", mimeType: "image/png" }, // dup path -> deduped
    { path: "/ws/promo.mp4", mimeType: "video/mp4", kind: "video" },
    { path: "/ws/voice.wav", mimeType: "audio/wav", kind: "audio" },
  ],
  contentBlocks: [{ blockType: "image", data: "AAAA", mediaType: "image/webp" }],
});

const types = blocks.map((b) => `${b.type}:${b.artifactType || b.chartType || ""}`);
assert.deepEqual(types, ["chart:pie", "artifact:image", "artifact:video", "artifact:audio", "artifact:image"]);
// the two artifact:image differ (file vs content image) so both kept; the dup
// file path collapsed to one:
assert.equal(blocks.filter((b) => b.path === "/ws/out.png").length, 1, "dup file path deduped");
assert.ok(blocks.every((b) => b.id), "every block has an id");

// Regression: the same file declared via an extraBlock whose type diverges from
// the artifact-derived type (e.g. "file" before enrichment vs "html" after) MUST
// still collapse to one block — duplicate cards were rendering otherwise.
const sameFile = buildResultBlocks({
  extraBlocks: [{ type: BLOCK_TYPES.ARTIFACT, artifactType: "file", path: "/ws/page.html", id: "x" }],
  artifacts: [{ path: "/ws/page.html", ext: ".html", mimeType: "text/html" }],
});
assert.equal(
  sameFile.filter((b) => b.path === "/ws/page.html").length,
  1,
  "same path with divergent artifactType dedups to one block",
);

console.log("block-protocol: ok");
