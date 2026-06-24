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
assert.match(hint, /OpenCode native subagents/);
assert.match(hint, /session\.idle/);

console.log("subagent-isolation-policy: ok");
