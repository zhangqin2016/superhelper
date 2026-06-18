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

// version is stable (no mass re-derivation)
assert.equal(BLOCK_SCHEMA_VERSION, 1);

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
  ],
  contentBlocks: [{ blockType: "image", data: "AAAA", mediaType: "image/webp" }],
});

const types = blocks.map((b) => `${b.type}:${b.artifactType || b.chartType || ""}`);
assert.deepEqual(types, ["chart:pie", "artifact:image", "artifact:image"]);
// the two artifact:image differ (file vs content image) so both kept; the dup
// file path collapsed to one:
assert.equal(blocks.filter((b) => b.path === "/ws/out.png").length, 1, "dup file path deduped");
assert.ok(blocks.every((b) => b.id), "every block has an id");

console.log("block-protocol: ok");
