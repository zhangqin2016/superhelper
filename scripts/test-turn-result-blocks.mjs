#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  RESULT_BLOCK_SCHEMA_VERSION,
  buildTurnResultBlocks,
} = require("../src/main/turn-result-blocks");

assert.equal(RESULT_BLOCK_SCHEMA_VERSION, 1);

const blocks = buildTurnResultBlocks({
  artifacts: [
    {
      id: "chart",
      kind: "image",
      path: "/tmp/lily/chart.svg",
      relativePath: "output/chart.svg",
      fileName: "chart.svg",
      mimeType: "image/svg+xml",
      bytes: 128,
      updatedAt: 1000,
    },
    {
      id: "chart-duplicate",
      kind: "image",
      path: "/tmp/lily/chart.svg",
      relativePath: "output/chart.svg",
      fileName: "chart.svg",
      mimeType: "image/svg+xml",
      bytes: 128,
      updatedAt: 1000,
    },
    {
      id: "report",
      kind: "file",
      path: "/tmp/lily/report.pdf",
      relativePath: "output/report.pdf",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      bytes: 2048,
      updatedAt: 2000,
    },
    {
      id: "html-report",
      kind: "file",
      path: "/tmp/lily/report.html",
      relativePath: "output/report.html",
      fileName: "report.html",
      mimeType: "text/html",
      bytes: 4096,
      updatedAt: 3000,
    },
  ],
  contentBlocks: [
    {
      blockType: "image",
      data: "iVBORw0KGgo=",
      mediaType: "image/png",
      alt: "inline image",
    },
  ],
  extraBlocks: [
    {
      id: "table:locations",
      type: "table",
      title: "Locations",
      columns: ["name", "count"],
      rows: [{ name: "Abu Dhabi", count: 8 }],
    },
  ],
});

assert.deepEqual(blocks.map((block) => block.type), ["table", "artifact", "artifact", "artifact", "artifact"]);
assert.equal(blocks.filter((block) => block.path === "/tmp/lily/chart.svg").length, 1);
assert.equal(blocks.find((block) => block.relativePath === "output/chart.svg")?.artifactType, "image");
assert.equal(blocks.find((block) => block.relativePath === "output/report.pdf")?.artifactType, "pdf");
assert.equal(blocks.find((block) => block.relativePath === "output/report.html")?.artifactType, "html");
assert.equal(blocks.find((block) => block.source === "content_block")?.mimeType, "image/png");

console.log("turn-result-blocks: ok");
