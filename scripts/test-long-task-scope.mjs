#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { issueScopeToken, verifyScopeToken } = require("../src/main/long-task/scope-token.js");

const secret = Buffer.alloc(32, 7).toString("base64url");
let now = 1_000_000;
const scope = {
  ownerScope: "account:user-a",
  sessionId: "session-a",
  projectId: "project-a",
  turnId: "turn-a",
};
const token = issueScopeToken({
  secret,
  scope,
  operations: ["start", "status", "logs", "stop", "list"],
  ttlMs: 60_000,
  now: () => now,
});

const verified = verifyScopeToken(token, { secret, operation: "start", now: () => now });
assert.equal(verified.ok, true);
assert.deepEqual(verified.scope, scope);
assert.equal(Object.isFrozen(verified.scope), true);

assert.equal(verifyScopeToken(token, { secret, operation: "admin", now: () => now }).ok, false);
assert.equal(verifyScopeToken(`${token.slice(0, -1)}x`, { secret, operation: "start", now: () => now }).error, "INVALID_SCOPE_TOKEN");
assert.equal(verifyScopeToken(token, { secret: Buffer.alloc(32, 8).toString("base64url"), operation: "start", now: () => now }).ok, false);

now += 60_001;
assert.equal(verifyScopeToken(token, { secret, operation: "status", now: () => now }).error, "SCOPE_TOKEN_EXPIRED");

assert.throws(() => issueScopeToken({ secret: "short", scope, operations: ["start"] }), /secret/i);
assert.throws(() => issueScopeToken({ secret, scope: { ...scope, sessionId: "" }, operations: ["start"] }), /scope/i);

console.log("long-task-scope: ok");
