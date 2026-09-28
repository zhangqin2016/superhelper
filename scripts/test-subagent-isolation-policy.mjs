#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildSubagentIsolationHint,
  shouldUseSubagentIsolation,
} = require("../src/main/subagent-isolation-policy.js");

assert.equal(
  shouldUseSubagentIsolation({ text: "hello", turnPolicy: { rigor: "fast" } }),
  false,
  "small turns stay direct",
);
// 2026-09-28 audit: wording no longer decides; only a coverage task (where
// sharding by term pays) gets the note, and WHEN to start a Task is the model's.
assert.equal(
  shouldUseSubagentIsolation({ text: "彻底分析整个链路，不要漏", turnPolicy: { rigor: "fast" } }),
  false,
  "broad wording alone no longer triggers it",
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
assert.doesNotMatch(hint, /\d{2,}\s*(?:ms|seconds|candidate files)|Do not start Task before/, "no hardcoded thresholds or dispatch bans");
// The prompt MUST match the engine's depth-1 cap (config-builder injects task:deny
// into every spawned child). Telling the model nested Task is allowed makes it waste
// steps on denied attempts and invites the runaway "subtask spawns subtasks" incident.
assert.match(hint, /Subagents cannot spawn their own Task subagents/);
assert.match(hint, /MAIN agent to dispatch/);
assert.doesNotMatch(hint, /Nested Task is allowed/);
assert.match(hint, /compact handoff/);
assert.match(hint, /leads, not proof/);
assert.match(hint, /session\.idle/);

console.log("subagent-isolation-policy: ok");
