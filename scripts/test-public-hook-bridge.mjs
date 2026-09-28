#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPublicHookRuntime } = require("../src/main/public-hooks.js");
const { createPublicHookBridge } = require("../src/main/public-hook-bridge.js");
const { createRuntimeIdentityRegistry } = require("../src/main/runtime-identity-registry.js");
const { issueRuntimeIdentity } = require("../src/main/runtime-identity.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-hook-bridge-"));
const registryPath = path.join(dir, "registry.json");
const secret = "b".repeat(64);
const now = Date.now();
const token = issueRuntimeIdentity({
  principalId: "profile:1",
  workspaceId: "workspace:1",
  projectId: "project:1",
  sessionId: "session:1",
  turnId: "turn:1",
  taskRunId: "task:1",
  agentId: "lead",
  attemptId: "attempt:1",
}, { secret, audience: "tool-broker", now, ttlMs: 60_000, nonce: "nonce:1" });
createRuntimeIdentityRegistry({ filePath: registryPath }).grant({
  engineSessionId: "engine:1",
  token,
  sessionId: "session:1",
  nonce: "nonce:1",
  expiresAt: now + 60_000,
});

const seen = [];
const runtime = createPublicHookRuntime({
  executors: {
    prompt: async (_hook, event) => {
      seen.push(event);
      return { allow: event.payload.tool !== "bash", reason: "blocked bash", contextAppend: "preserve this" };
    },
  },
});
runtime.register({ id: "tool-policy", event: "tool.before", type: "prompt", mode: "security", canMutate: true });
runtime.register({ id: "compact-memory", event: "compaction.before", type: "prompt", mode: "observe", canMutate: true });
const bridge = createPublicHookBridge({ runtime, registryPath, secret });

try {
  const { url } = await bridge.start();
  const invoke = (event, tool = "read") => fetch(`${url}/v1/hooks/execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ event, engineSessionId: "engine:1", tool, args: { path: "/tmp/a" } }),
  }).then((response) => response.json());
  assert.equal((await invoke("tool.before", "read")).allow, true);
  assert.equal((await invoke("tool.before", "bash")).allow, false);
  assert.equal(seen[0].payload.sessionId, "session:1", "bridge scope comes from the signed identity");
  const compaction = await invoke("compaction.before");
  assert.equal(compaction.contextAppend, "preserve this");

  const previous = {
    registry: process.env.LILY_RUNTIME_IDENTITY_REGISTRY,
    bridge: process.env.LILY_PUBLIC_HOOK_BRIDGE_URL,
  };
  process.env.LILY_RUNTIME_IDENTITY_REGISTRY = registryPath;
  process.env.LILY_PUBLIC_HOOK_BRIDGE_URL = url;
  try {
    const pluginUrl = `${pathToFileURL(path.resolve("resources/opencode-plugins/public-hooks-bridge.js")).href}?t=${Date.now()}`;
    const plugin = await import(pluginUrl);
    const hooks = await plugin.PublicHooksBridgePlugin();
    await assert.rejects(
      () => hooks["tool.execute.before"]({ sessionID: "engine:1", tool: "bash" }, { args: {} }),
      /PUBLIC_HOOK_DENIED/,
      "native tool pre-hook enforces a security denial",
    );
    const output = { context: ["existing"] };
    await hooks["experimental.session.compacting"]({ sessionID: "engine:1" }, output);
    assert.deepEqual(output.context, ["preserve this", "existing"]);

    // A subagent's child session (and its own child) acts under the granted
    // ancestor: every tool call a subagent made failed here before (2026-09-28).
    const parents = { "child:1": "engine:1", "grandchild:1": "child:1", "orphan:1": "" };
    const lookups = [];
    const client = { session: { get: async ({ path: { id } }) => { lookups.push(id); return { data: { parentID: parents[id] || "" } }; } } };
    const withParents = await (await import(`${pluginUrl}&parents`)).PublicHooksBridgePlugin({ client });
    await withParents["tool.execute.before"]({ sessionID: "child:1", tool: "read" }, { args: {} });
    await withParents["tool.execute.before"]({ sessionID: "grandchild:1", tool: "read" }, { args: {} });
    await assert.rejects(
      () => withParents["tool.execute.before"]({ sessionID: "child:1", tool: "bash" }, { args: {} }),
      /PUBLIC_HOOK_DENIED/,
      "and the hooks that govern the turn govern its subagents too",
    );
    const childCall = seen.filter((event) => event.payload.tool === "bash").at(-1);
    assert.equal(childCall.payload.sessionId, "session:1", "the subagent is scoped to the turn that dispatched it");
    const lookupsBefore = lookups.length;
    await withParents["tool.execute.before"]({ sessionID: "child:1", tool: "read" }, { args: {} });
    assert.equal(lookups.length, lookupsBefore, "a known parent is not looked up again");
    await assert.rejects(
      () => withParents["tool.execute.before"]({ sessionID: "orphan:1", tool: "read" }, { args: {} }),
      /PUBLIC_HOOK_BRIDGE_IDENTITY_UNAVAILABLE/,
      "a session with no granted ancestor still fails closed",
    );
    await assert.rejects(
      () => hooks["tool.execute.before"]({ sessionID: "child:1", tool: "read" }, { args: {} }),
      /PUBLIC_HOOK_BRIDGE_IDENTITY_UNAVAILABLE/,
      "and without the engine client nothing is inferred",
    );
  } finally {
    if (previous.registry === undefined) delete process.env.LILY_RUNTIME_IDENTITY_REGISTRY;
    else process.env.LILY_RUNTIME_IDENTITY_REGISTRY = previous.registry;
    if (previous.bridge === undefined) delete process.env.LILY_PUBLIC_HOOK_BRIDGE_URL;
    else process.env.LILY_PUBLIC_HOOK_BRIDGE_URL = previous.bridge;
  }
} finally {
  await bridge.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("public-hook-bridge: ok");
