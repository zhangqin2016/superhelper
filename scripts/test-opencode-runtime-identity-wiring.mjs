#!/usr/bin/env node

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
const { buildToolBrokerMcpEntry } = require("../src/main/mcp-config.js");
const { createRuntimeIdentityRegistry } = require("../src/main/runtime-identity-registry.js");
const { verifyRuntimeIdentity } = require("../src/main/runtime-identity.js");
const { SessionRunnerPool } = require("../src/main/session-runner-pool.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-opencode-runtime-identity-"));
const registryPath = path.join(dir, "registry.json");
const secret = "c".repeat(64);

class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.sessionID = "";
    this.process = { exitCode: null, signalCode: null, killed: false };
    this.sent = [];
  }

  async start() {}
  async createSession() { this.sessionID = this.sessionIDToCreate || "engine-session-1"; return this.sessionID; }
  subscribe() {}
  async sendPrompt(payload) { this.sent.push(payload); }
  async getSessionStatus() { return "busy"; }
  terminate() {}
}

try {
  const broker = buildToolBrokerMcpEntry({ platformOnly: true }, {
    runtimeIdentity: { secret, registryPath },
  });
  assert.equal(broker.env.LILY_RUNTIME_IDENTITY_SECRET, secret);
  assert.equal(broker.env.LILY_RUNTIME_IDENTITY_REGISTRY, registryPath);
  assert.equal(broker.env.LILY_RUNTIME_IDENTITY_V1, "1");

  const pool = new SessionRunnerPool();
  assert.ok(
    pool._opencodePlugins().some((file) => file.endsWith("runtime-identity.js")),
    "shared OpenCode serve loads the identity injection plugin",
  );

  const server = new FakeServer();
  const runner = new OpencodeAgentSession("lily-session-1", { createServer: () => server });
  runner.ensureProcess(dir, {
    agentCommand: "/fake/opencode",
    opencodeConfig: "{}",
    runtimeIdentity: {
      secret,
      registryPath,
      audience: "tool-broker",
      principalId: "owner:user-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      sessionId: "lily-session-1",
      workspacePath: dir,
      permissionMode: "ask",
      activeSkillIds: ["lily-runtime-packs"],
    },
  }, { lazy: true });

  assert.equal(runner.sendUserMessage({
    text: "run",
    files: [],
    turnId: "turn-1",
    taskRunId: "task-1",
    attemptId: "attempt-1",
  }), true);

  for (let i = 0; i < 50 && server.sent.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(server.sent.length, 1);
  const registry = createRuntimeIdentityRegistry({ filePath: registryPath });
  const token = registry.resolve("engine-session-1");
  assert.ok(token, "turn dispatch grants the engine session a scoped token before prompt execution");
  const identity = verifyRuntimeIdentity(token, { secret, audience: "tool-broker" });
  assert.equal(identity.sessionId, "lily-session-1");
  assert.equal(identity.turnId, "turn-1");
  assert.equal(identity.taskRunId, "task-1");
  assert.equal(identity.attemptId, "attempt-1");
  assert.deepEqual(identity.activeSkillIds, ["lily-runtime-packs"]);

  runner.terminate();
  assert.equal(registry.resolve("engine-session-1"), "", "terminating a runner revokes its engine grant");

  // A PRE-TURN compaction runs before the turn is dispatched, so the engine
  // session has no grant yet. Hook-bridge plugins resolve this registry on every
  // engine event and fail closed without a token: the 2026-09-15 field case where
  // every first compaction of a resumed session died with
  // PUBLIC_HOOK_BRIDGE_IDENTITY_UNAVAILABLE. The token must exist BEFORE
  // summarize runs, not after the prompt is sent.
  const compactServer = new FakeServer();
  compactServer.sessionIDToCreate = "engine-session-2";
  let tokenDuringSummarize = null;
  compactServer.summarize = async () => {
    tokenDuringSummarize = createRuntimeIdentityRegistry({ filePath: registryPath }).resolve("engine-session-2");
  };
  const compactRunner = new OpencodeAgentSession("lily-session-2", { createServer: () => compactServer });
  compactRunner.ensureProcess(dir, {
    agentCommand: "/fake/opencode",
    opencodeConfig: "{}",
    runtimeIdentity: {
      secret, registryPath, audience: "tool-broker", principalId: "owner:user-1",
      workspaceId: "workspace-1", projectId: "project-1", sessionId: "lily-session-2",
      workspacePath: dir, permissionMode: "ask", activeSkillIds: [],
    },
  }, { lazy: true });

  assert.equal(await compactRunner.compactContext({ reason: "pre_turn_token_pressure" }), true);
  assert.ok(tokenDuringSummarize, "pre-turn compaction grants the engine identity BEFORE summarize runs");
  const compactIdentity = verifyRuntimeIdentity(tokenDuringSummarize, { secret, audience: "tool-broker" });
  assert.equal(compactIdentity.sessionId, "lily-session-2");
  assert.equal(compactIdentity.agentId, "compaction", "the grant is attributed to compaction, not a turn");
  compactRunner.terminate();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("opencode-runtime-identity-wiring: ok");
