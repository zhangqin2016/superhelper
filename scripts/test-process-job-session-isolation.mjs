#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PROCESS_JOB_OPERATIONS,
  buildProcessJobTurnGuidance,
  verifyProcessJobScope,
} = require("../src/main/long-task/turn-scope.js");

const secret = Buffer.alloc(32, 11).toString("base64url");
const scopeA = { ownerScope: "owner-a", sessionId: "session-a", projectId: "project-a", turnId: "turn-a" };
const scopeB = { ownerScope: "owner-a", sessionId: "session-b", projectId: "project-a", turnId: "turn-b" };
const guidance = buildProcessJobTurnGuidance({ secret, scope: scopeA, now: () => 1_000 });
assert.match(guidance, /Process Job Scope/);
assert.match(guidance, /scopeToken/);
const token = guidance.match(/`([^`]+\.[^`]+)`/)?.[1];
assert(token, "guidance carries opaque signed token");

const verified = verifyProcessJobScope({ scopeToken: token }, { secret, operation: "start", now: () => 1_000 });
assert.equal(verified.ok, true);
assert.deepEqual(verified.scope, scopeA);
assert.equal(PROCESS_JOB_OPERATIONS.includes("stop"), true);

const foreignExpectation = verifyProcessJobScope({ scopeToken: token }, {
  secret,
  operation: "status",
  expectedScope: scopeB,
  now: () => 1_000,
});
assert.equal(foreignExpectation.error, "SCOPE_MISMATCH");
assert.equal(JSON.stringify(verified).includes(secret), false, "secret never appears in verified output");

console.log("process-job-session-isolation: ok");
