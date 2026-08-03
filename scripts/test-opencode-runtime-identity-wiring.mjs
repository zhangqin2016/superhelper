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
  async createSession() { this.sessionID = "engine-session-1"; return this.sessionID; }
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
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("opencode-runtime-identity-wiring: ok");
