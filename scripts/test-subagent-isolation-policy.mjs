#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MAIN_FIRST_DISPATCH_THRESHOLDS,
  buildSubagentIsolationHint,
  shouldUseSubagentIsolation,
} = require("../src/main/subagent-isolation-policy.js");

assert.equal(
  shouldUseSubagentIsolation({ text: "hello", turnPolicy: { rigor: "fast" } }),
  false,
  "small turns stay direct",
);
assert.equal(
  shouldUseSubagentIsolation({ text: "彻底分析整个链路，不要漏", turnPolicy: { rigor: "fast" } }),
  true,
  "broad investigation wording triggers isolation",
);
assert.equal(
  shouldUseSubagentIsolation({ text: "看一下", turnPolicy: { rigor: "coverage" } }),
  true,
  "coverage policy triggers isolation",
);

const hint = buildSubagentIsolationHint({
  text: "彻底找出所有 session.idle 问题",
  turnPolicy: {
    rigor: "coverage",
    sourceCoverage: { explicitTerms: ["session.idle", "runtime-event-bus"] },
  },
});
assert.match(hint, /Subagent Context Isolation/);
assert.match(hint, /Main-First Dispatch Gate/);
assert.match(hint, /Lily subagents/);
assert.match(hint, /deterministic local tools/);
assert.match(hint, /Do not start Task before this candidate map exists/);
assert.match(hint, /pure keyword search/);
assert.match(hint, new RegExp(`<${MAIN_FIRST_DISPATCH_THRESHOLDS.candidateFiles} candidate files`));
assert.match(hint, new RegExp(`${MAIN_FIRST_DISPATCH_THRESHOLDS.subsystems}\\+ independent subsystems`));
assert.match(hint, /parent should keep doing other deterministic work/);
assert.match(hint, new RegExp(`under ${MAIN_FIRST_DISPATCH_THRESHOLDS.subagentTargetSeconds} seconds`));
assert.match(hint, /Each Task prompt must include/);
// The prompt MUST match the engine's depth-1 cap (config-builder injects task:deny
// into every spawned child). Telling the model nested Task is allowed makes it waste
// steps on denied attempts and invites the runaway "subtask spawns subtasks" incident.
assert.match(hint, /Subagents cannot spawn their own Task subagents/);
assert.match(hint, /MAIN agent dispatches them/);
assert.doesNotMatch(hint, /Nested Task is allowed/);
assert.match(hint, /session\.idle/);

console.log("subagent-isolation-policy: ok");
