"use strict";

const { migrateAgentTaskGraphSchema } = require("./agent-task-graph-store");
const { migratePublicHookSchema } = require("./public-hook-store");
const { migrateRuntimeCheckpointSchema } = require("./runtime-checkpoint-store");
const { migrateMessageRecoveryIndex, migrateRuntimeEventCompactionIndex } = require("./runtime-performance-schema-migration");
const { migrateTaskLifecycleSchema } = require("./task-lifecycle-store");
const { migrateTaskContextRegistrySchema } = require("./task-context-registry-store");
const { migrateParentClosureSchema } = require("./parent-closure-schema-migration");

module.exports = {
  migrateAgentTaskGraphSchema,
  migrateMessageRecoveryIndex,
  migratePublicHookSchema,
  migrateRuntimeCheckpointSchema,
  migrateRuntimeEventCompactionIndex,
  migrateTaskLifecycleSchema,
  migrateTaskContextRegistrySchema,
  migrateParentClosureSchema,
};
