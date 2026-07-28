#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  STATIC_TOOL_DEFINITIONS,
  buildBrokerTools,
} = require("../src/main/mcp/tool-broker-registry.js");

// The shared platform broker has no immutable originating Lily session. Exposing
// schedule mutation or listing here can bind a delayed tool call to whichever
// conversation happens to be active and can disclose another session's tasks.
assert.equal(
  STATIC_TOOL_DEFINITIONS.some((tool) => tool.id === "schedule_task_create"),
  false,
  "unscoped shared broker must not expose scheduled-task creation",
);
assert.equal(
  STATIC_TOOL_DEFINITIONS.some((tool) => tool.id === "schedule_task_list"),
  false,
  "unscoped shared broker must not expose scheduled-task listing",
);
assert.equal(
  buildBrokerTools({ platformOnly: true }).some((tool) => tool.group === "scheduled-tasks"),
  false,
  "platform-only broker must contain no scheduled-task capability",
);

console.log("scheduled-task-bridge: ok");
