#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ARTIFACT_SCHEMA_VERSION,
  RESULT_BLOCK_SCHEMA_VERSION,
  backfillMessageArtifacts,
} = require("../src/main/session-artifact-backfill");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lily-artifact-backfill-"));
try {
  const svgPath = path.join(workspace, "output", "location-pie-chart.svg");
  fs.mkdirSync(path.dirname(svgPath), { recursive: true });
  fs.writeFileSync(svgPath, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");

  const message = {
    role: "assistant",
    content: "SVG 文件：output/location-pie-chart.svg",
    record: {
      assistantText: "SVG 文件：output/location-pie-chart.svg",
      terminal: "turn.completed",
    },
  };

  assert.equal(backfillMessageArtifacts(message, workspace), true);
  assert.equal(message.record.artifactSchemaVersion, ARTIFACT_SCHEMA_VERSION);
  assert.equal(message.record.artifacts.length, 1);
  assert.equal(message.record.artifacts[0].kind, "image");
  assert.equal(message.record.artifacts[0].relativePath, "output/location-pie-chart.svg");
  assert.equal(message.record.resultBlockSchemaVersion, RESULT_BLOCK_SCHEMA_VERSION);
  assert.equal(message.record.resultBlocks.length, 1);
  assert.equal(message.record.resultBlocks[0].type, "artifact");
  assert.equal(message.record.resultBlocks[0].artifactType, "image");
  assert.equal(message.record.resultBlocks[0].relativePath, "output/location-pie-chart.svg");

  assert.equal(backfillMessageArtifacts(message, workspace), false);
  assert.equal(message.record.artifacts.length, 1);
  assert.equal(message.record.resultBlocks.length, 1);

  const mdPath = path.join(workspace, "output", "张钦_八字命理全面分析_2026.md");
  fs.writeFileSync(mdPath, "# 命理全面分析\n");
  const legacyMessage = {
    role: "assistant",
    content: "报告已生成完毕，保存在 output/张钦_八字命理全面分析_2026.md。",
    record: {
      assistantText: "报告已生成完毕，保存在 output/张钦_八字命理全面分析_2026.md。",
      terminal: "turn.completed",
      artifactSchemaVersion: 1,
      artifacts: [],
      resultBlockSchemaVersion: RESULT_BLOCK_SCHEMA_VERSION,
      resultBlocks: [],
    },
  };
  assert.equal(backfillMessageArtifacts(legacyMessage, workspace), true);
  assert.equal(legacyMessage.record.artifacts.length, 1);
  assert.equal(legacyMessage.record.artifacts[0].mimeType, "text/markdown");
  assert.equal(legacyMessage.record.resultBlocks.length, 1);
  assert.equal(legacyMessage.record.resultBlocks[0].artifactType, "markdown");

  const noRecord = { role: "assistant", content: "output/location-pie-chart.svg" };
  assert.equal(backfillMessageArtifacts(noRecord, workspace), false);

  console.log("session-artifact-backfill: ok");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
