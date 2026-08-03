"use strict";

const { migrateAgentTaskGraphSchema } = require("./agent-task-graph-store");
const { migratePublicHookSchema } = require("./public-hook-store");
const { migrateRuntimeCheckpointSchema } = require("./runtime-checkpoint-store");
const { migrateMessageRecoveryIndex, migrateRuntimeEventCompactionIndex } = require("./runtime-performance-schema-migration");

module.exports = {
  migrateAgentTaskGraphSchema,
  migrateMessageRecoveryIndex,
  migratePublicHookSchema,
  migrateRuntimeCheckpointSchema,
  migrateRuntimeEventCompactionIndex,
};
