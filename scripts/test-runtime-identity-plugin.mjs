#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pluginUrl = new URL("../resources/opencode-plugins/runtime-identity.js", import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-identity-plugin-"));
const registryPath = path.join(dir, "registry.json");
const previousRegistry = process.env.LILY_RUNTIME_IDENTITY_REGISTRY;
const previousEnabled = process.env.LILY_RUNTIME_IDENTITY_V1;

try {
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      "engine-1": {
        token: "signed-token-1",
        sessionId: "lily-1",
        expiresAt: Date.now() + 60_000,
        revokedAt: null,
      },
    },
  }));
  process.env.LILY_RUNTIME_IDENTITY_REGISTRY = registryPath;
  process.env.LILY_RUNTIME_IDENTITY_V1 = "1";
  const { RuntimeIdentityPlugin } = await import(`${pluginUrl.href}?test=${Date.now()}`);
  const hooks = await RuntimeIdentityPlugin({});
  const before = hooks["tool.execute.before"];
  assert.equal(typeof before, "function");

  const output = { args: { query: "capabilities" } };
  await before({ tool: "lily_tool_broker_lily_capability_list", sessionID: "engine-1" }, output);
  assert.equal(output.args.__lilyRuntimeToken, "signed-token-1");

  const shortName = { args: {} };
  await before({ tool: "lily_tb_lily_capability_status", sessionID: "engine-1" }, shortName);
  assert.equal(shortName.args.__lilyRuntimeToken, "signed-token-1");

  const nativeTool = { args: { filePath: "/tmp/x" } };
  await before({ tool: "read", sessionID: "engine-1" }, nativeTool);
  assert.equal(nativeTool.args.__lilyRuntimeToken, undefined, "native tools are untouched");

  await assert.rejects(
    before({ tool: "lily_tool_broker_lily_capability_list", sessionID: "unknown" }, { args: {} }),
    /LILY_RUNTIME_IDENTITY_UNAVAILABLE/,
    "missing identity fails closed for broker tools",
  );

  process.env.LILY_RUNTIME_IDENTITY_V1 = "0";
  const disabled = { args: {} };
  await before({ tool: "lily_tool_broker_lily_capability_list", sessionID: "unknown" }, disabled);
  assert.equal(disabled.args.__lilyRuntimeToken, undefined, "kill switch preserves the old route");
} finally {
  if (previousRegistry === undefined) delete process.env.LILY_RUNTIME_IDENTITY_REGISTRY;
  else process.env.LILY_RUNTIME_IDENTITY_REGISTRY = previousRegistry;
  if (previousEnabled === undefined) delete process.env.LILY_RUNTIME_IDENTITY_V1;
  else process.env.LILY_RUNTIME_IDENTITY_V1 = previousEnabled;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("runtime-identity-plugin: ok");
