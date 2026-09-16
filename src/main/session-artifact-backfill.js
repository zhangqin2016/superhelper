"use strict";

const { buildTurnArtifacts } = require("./turn-artifacts");
const { buildTurnResultBlocks, RESULT_BLOCK_SCHEMA_VERSION } = require("./turn-result-blocks");

// 5 (2026-09-16): artifact lists are re-derived so conversations recorded
// before the deliverable-relevance pass stop showing Lily's own scratch
// files and OS temp files as products. [gate: deliverable-relevance]
const ARTIFACT_SCHEMA_VERSION = 5;

function backfillMessageArtifacts(message, workspacePath = "") {
  const record = message?.record;
  if (!record || typeof record !== "object") return false;
  let changed = false;

  const assistantText = String(record.assistantText ?? message.content ?? "");
  if (record.artifactSchemaVersion !== ARTIFACT_SCHEMA_VERSION || !Array.isArray(record.artifacts)) {
    const artifacts = buildTurnArtifacts({
      assistantText,
      fileChanges: Array.isArray(record.fileChanges) ? record.fileChanges : [],
      tools: Array.isArray(record.tools) ? record.tools : [],
      workspacePath,
      startedAt: record.startedAt || 0,
    });
    record.artifacts = artifacts;
    record.artifactSchemaVersion = ARTIFACT_SCHEMA_VERSION;
    changed = true;
  }

  if (changed || record.resultBlockSchemaVersion !== RESULT_BLOCK_SCHEMA_VERSION || !Array.isArray(record.resultBlocks)) {
    record.resultBlocks = buildTurnResultBlocks({
      artifacts: Array.isArray(record.artifacts) ? record.artifacts : [],
      contentBlocks: Array.isArray(record.contentBlocks) ? record.contentBlocks : [],
      extraBlocks: Array.isArray(record.resultBlocks) ? record.resultBlocks : [],
    });
    record.resultBlockSchemaVersion = RESULT_BLOCK_SCHEMA_VERSION;
    changed = true;
  }

  return changed;
}

module.exports = {
  ARTIFACT_SCHEMA_VERSION,
  RESULT_BLOCK_SCHEMA_VERSION,
  backfillMessageArtifacts,
};
