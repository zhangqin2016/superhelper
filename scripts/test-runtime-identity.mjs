#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_TTL_MS,
  issueRuntimeIdentity,
  redactRuntimeIdentity,
  runtimeIdentityInstallSecret,
  verifyRuntimeIdentity,
} = require("../src/main/runtime-identity.js");
const { createRuntimeIdentityRegistry } = require("../src/main/runtime-identity-registry.js");

const secret = "a".repeat(64);
const identity = {
  principalId: "owner:user-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  sessionId: "session-1",
  turnId: "turn-1",
  taskRunId: "task-1",
  agentId: "lead",
  attemptId: "attempt-1",
  capabilities: ["runtime-pack.read", "character-worlds.write"],
};
assert.equal(DEFAULT_TTL_MS, 7 * 24 * 60 * 60 * 1_000, "long tasks keep broker authority for the supported maximum lease");

const token = issueRuntimeIdentity(identity, {
  secret,
  audience: "tool-broker",
  now: 1_000,
  ttlMs: 5_000,
  nonce: "nonce-1",
});
const verified = verifyRuntimeIdentity(token, {
  secret,
  audience: "tool-broker",
  now: 2_000,
});
assert.equal(verified.sessionId, identity.sessionId);
assert.equal(verified.principalId, identity.principalId);
assert.deepEqual(verified.capabilities, [...identity.capabilities].sort());
assert.equal(Object.isFrozen(verified), true, "verified identities are immutable");
assert.equal(Object.isFrozen(verified.capabilities), true, "capability arrays are immutable");

const parts = token.split(".");
assert.equal(parts.length, 3);
const tamperedPayload = Buffer.from(JSON.stringify({ ...verified, sessionId: "session-2" })).toString("base64url");
assert.throws(
  () => verifyRuntimeIdentity(`${parts[0]}.${tamperedPayload}.${parts[2]}`, { secret, audience: "tool-broker", now: 2_000 }),
  /RUNTIME_IDENTITY_INVALID_SIGNATURE/,
);
assert.throws(
  () => verifyRuntimeIdentity(token, { secret, audience: "other", now: 2_000 }),
  /RUNTIME_IDENTITY_AUDIENCE_MISMATCH/,
);
assert.throws(
  () => verifyRuntimeIdentity(token, { secret, audience: "tool-broker", now: 6_001 }),
  /RUNTIME_IDENTITY_EXPIRED/,
);
assert.throws(
  () => verifyRuntimeIdentity(token, {
    secret,
    audience: "tool-broker",
    now: 2_000,
    expected: { sessionId: "session-2" },
  }),
  /RUNTIME_IDENTITY_SCOPE_MISMATCH/,
);
assert.throws(
  () => verifyRuntimeIdentity(token, {
    secret,
    audience: "tool-broker",
    now: 2_000,
    isRevoked: (candidate) => candidate.nonce === "nonce-1",
  }),
  /RUNTIME_IDENTITY_REVOKED/,
);

const redacted = redactRuntimeIdentity(verified);
assert.equal(redacted.sessionId, "session-1");
assert.equal(redacted.signature, undefined);
assert.equal(redacted.token, undefined);
assert.equal(redacted.nonce, "nonce-1");

assert.throws(
  () => issueRuntimeIdentity({ ...identity, sessionId: "x".repeat(300) }, { secret, audience: "tool-broker" }),
  /RUNTIME_IDENTITY_FIELD_INVALID/,
);
assert.throws(
  () => issueRuntimeIdentity(identity, { secret: "short", audience: "tool-broker" }),
  /RUNTIME_IDENTITY_SECRET_INVALID/,
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-identity-"));
try {
  const installSecretPath = path.join(dir, "identity.secret");
  const installSecret = runtimeIdentityInstallSecret({ filePath: installSecretPath });
  assert.equal(runtimeIdentityInstallSecret({ filePath: installSecretPath }), installSecret, "install secret survives process restart reads");
  assert.ok(Buffer.from(installSecret, "base64url").length >= 32);
  const filePath = path.join(dir, "registry.json");
  let now = 2_000;
  const registry = createRuntimeIdentityRegistry({ filePath, now: () => now });
  registry.grant({
    engineSessionId: "engine-1",
    token,
    sessionId: "session-1",
    nonce: "nonce-1",
    expiresAt: 6_000,
  });
  assert.equal(registry.resolve("engine-1"), token);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).sessions["engine-1"].token, token);

  const second = createRuntimeIdentityRegistry({ filePath, now: () => now });
  assert.equal(second.resolve("engine-1"), token, "registry is process-independent");
  assert.equal(second.revoke("engine-1", "test"), true);
  assert.equal(registry.resolve("engine-1"), "", "revocation is visible across instances");

  registry.grant({
    engineSessionId: "engine-expired",
    token: "expired-token",
    sessionId: "session-expired",
    nonce: "nonce-expired",
    expiresAt: 2_100,
  });
  now = 2_101;
  assert.equal(registry.resolve("engine-expired"), "");
  assert.equal(registry.prune(), 1);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".tmp-")).length, 0, "atomic writes leave no temp files");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("runtime-identity: ok");
