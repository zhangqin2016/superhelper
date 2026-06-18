"use strict";

/**
 * Compatibility facade — the canonical contract now lives in block-protocol.js.
 * Existing callers (turn-archive, session-artifact-backfill) keep importing
 * these names unchanged.
 */

const {
  BLOCK_SCHEMA_VERSION,
  buildResultBlocks,
  dedupeResultBlocks,
} = require("./block-protocol");

module.exports = {
  RESULT_BLOCK_SCHEMA_VERSION: BLOCK_SCHEMA_VERSION,
  buildTurnResultBlocks: buildResultBlocks,
  dedupeResultBlocks,
};
