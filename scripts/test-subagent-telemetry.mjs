#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  SLOW_SUBAGENT_MS,
  VERY_SLOW_SUBAGENT_MS,
  buildSubagentTelemetry,
  isSubagentTool,
  subagentTitle,
} = require("../src/main/subagent-telemetry.js");

assert.equal(isSubagentTool({ name: "Task" }), true);
assert.equal(isSubagentTool({ name: "Read" }), false);
assert.equal(subagentTitle({ input: { description: "Find Huawei meeting dead code" } }), "Find Huawei meeting dead code");

const record = {
  tools: [
    {
      id: "task_1",
      name: "Task",
      status: "done",
      input: { description: "Find Huawei meeting dead code", prompt: "Search all Huawei meeting code paths" },
      result: "complete report",
      durationMs: VERY_SLOW_SUBAGENT_MS + 1000,
    },
    {
      id: "read_1",
      name: "Read",
      status: "done",
      parentToolUseId: "task_1",
      durationMs: 1200,
    },
    {
      id: "task_2",
      name: "Task",
      status: "done",
      input: { description: "small audit" },
      durationMs: SLOW_SUBAGENT_MS - 1000,
    },
  ],
};

const telemetry = buildSubagentTelemetry(record);
assert.equal(telemetry.count, 2);
assert.equal(telemetry.slowCount, 1);
assert.equal(telemetry.verySlowCount, 1);
assert.equal(telemetry.subagents[0].childToolCount, 1);
assert.equal(telemetry.subagents[0].childTools[0].name, "Read");
assert.match(telemetry.subagents[0].inputPreview, /Huawei meeting/);

console.log("subagent-telemetry: ok");
