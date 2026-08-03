#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { issueRuntimeIdentity } = require("../src/main/runtime-identity.js");
const {
  createRuntimeIdentityContextProvider,
  extractRuntimeIdentityToken,
  withRuntimeIdentityInputSchema,
} = require("../src/main/mcp/tool-broker-mcp.js");

const secret = "b".repeat(64);
const token = issueRuntimeIdentity({
  principalId: "owner:one",
  workspaceId: "workspace-1",
  projectId: "project-1",
  sessionId: "session-1",
  turnId: "turn-1",
  taskRunId: "task-1",
  agentId: "lead",
  attemptId: "attempt-1",
  capabilities: ["character-worlds.write"],
  activeSkillIds: ["lily-runtime-packs"],
  workspacePath: "/workspace/one",
  permissionMode: "ask",
}, {
  secret,
  audience: "tool-broker",
  now: 1_000,
  ttlMs: 5_000,
  nonce: "nonce-1",
});

const args = { query: "test", __lilyRuntimeToken: token };
assert.equal(extractRuntimeIdentityToken(args), token);
assert.equal(args.__lilyRuntimeToken, undefined, "internal token is removed before the handler sees args");

const schema = withRuntimeIdentityInputSchema({ query: { optional: true } });
assert.ok(schema.__lilyRuntimeToken, "broker registrations accept the host-injected identity field");

const provider = createRuntimeIdentityContextProvider({
  fallbackProvider: async () => ({
    platformOnly: true,
    activeSkillIds: [],
    connectorStatus: { mailConnected: true },
    runtime: { browserAvailable: true },
    characterWorlds: { enabled: true },
  }),
  secret,
  audience: "tool-broker",
  now: () => 2_000,
  isRevoked: () => false,
});

const context = await provider({ __lilyRuntimeToken: token });
assert.equal(context.ok, true);
assert.equal(context.platformOnly, false);
assert.equal(context.sessionId, "session-1");
assert.equal(context.projectId, "project-1");
assert.equal(context.workspacePath, "/workspace/one");
assert.equal(context.permissionMode, "ask");
assert.deepEqual(context.activeSkillIds, ["lily-runtime-packs"]);
assert.equal(context.connectorStatus.mailConnected, true, "runtime availability comes from the host context");
assert.equal(context.runtimeIdentity.principalId, "owner:one");

const platform = await provider({});
assert.equal(platform.platformOnly, true, "unsigned calls retain only the explicit platform surface");

await assert.rejects(
  provider({ __lilyRuntimeToken: `${token}x` }),
  /RUNTIME_IDENTITY_INVALID_SIGNATURE/,
);

const revokedProvider = createRuntimeIdentityContextProvider({
  fallbackProvider: async () => ({ platformOnly: true, activeSkillIds: [] }),
  secret,
  audience: "tool-broker",
  now: () => 2_000,
  isRevoked: () => true,
});
await assert.rejects(revokedProvider({ __lilyRuntimeToken: token }), /RUNTIME_IDENTITY_REVOKED/);

console.log("tool-broker-runtime-identity: ok");
