#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const { createToolBrokerMcpServer } = require("../src/main/mcp/tool-broker-mcp.js");

async function clientForServer(server) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(ct);
  return client;
}

{
  let context = {
    sessionId: "s1",
    activeSkillIds: ["lily-runtime-packs", "lily-mail-assistant"],
    connectorStatus: { mailConnected: false },
  };
  const server = await createToolBrokerMcpServer({ contextProvider: async () => context });
  const client = await clientForServer(server);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["lily_capability_list", "lily_capability_status", "runtime_pack_install", "runtime_pack_list"],
    "tools/list always exposes platform capabilities",
  );
  assert.ok(!tools.some((tool) => tool.name.startsWith("mail_")), "mail tools hidden when bridge is unavailable");

  context = { ...context, activeSkillIds: [] };
  const result = await client.callTool({ name: "runtime_pack_list", arguments: {} });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true, "platform tools remain callable after optional skills change");
  await client.close();
}

{
  const server = await createToolBrokerMcpServer({
    context: { ok: false, error: "SESSION_NOT_FOUND" },
  });
  const client = await clientForServer(server);
  const { tools } = await client.listTools();
  assert.deepEqual(tools, [], "failed context registers no tools");
  await client.close();
}

{
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "src/main/mcp/tool-broker-stdio.js")],
    env: { ...process.env, LILY_TOOL_BROKER_CONTEXT: "" },
  });
  const client = new Client({ name: "stdio-platform-test", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["lily_capability_list", "lily_capability_status", "runtime_pack_install", "runtime_pack_list"],
    "stdio broker without session context exposes only platform capabilities",
  );
  await client.close();
}

{
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "src/main/mcp/tool-broker-stdio.js")],
    env: { ...process.env, LILY_TOOL_BROKER_CONTEXT: JSON.stringify({ sessionId: "s1", activeSkillIds: ["lily-runtime-packs"] }) },
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["lily_capability_list", "lily_capability_status", "runtime_pack_install", "runtime_pack_list"],
    "stdio broker reads explicit context and exposes platform capabilities",
  );
  await client.close();
}

console.log("PASS: test-tool-broker-mcp (6 tests)");
