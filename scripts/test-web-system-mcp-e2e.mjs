#!/usr/bin/env node
/**
 * End-to-end proof of the top-tier operating path: a learned system's capability
 * is a typed MCP tool; the model CALLS it (schema-validated args); the server's
 * deterministic handler runs it via execute_web_playbook over plain HTTP (no
 * browser) and returns the real result. Drives a real MCP client over stdio
 * against the real stdio server, hitting a local mock API — the whole chain
 * minus a real site/browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SKILL = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts");
const stdioServer = path.join(ROOT, "src/main/mcp/web-system-mcp-stdio.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-mcp-e2e-"));

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/leaves")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: 1, days: 2, status: "open" }]));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let client;
try {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;

  // A minimal installed learned system.
  const sysDir = path.join(tmp, "learned-demo-erp");
  fs.mkdirSync(path.join(sysDir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(SKILL, "execute_web_playbook.cjs"), path.join(sysDir, "scripts/execute_web_playbook.cjs"));
  const contract = { id: "list-leaves", method: "GET", endpoint: `${base}api/leaves`, risk: "read", contentType: "query" };
  fs.writeFileSync(path.join(sysDir, "api-map.json"), JSON.stringify({ schemaVersion: 1, contracts: [contract] }));
  fs.writeFileSync(path.join(sysDir, "web-system-playbook.json"), JSON.stringify({
    schemaVersion: 1, id: "demo-erp", baseUrl: base, allowedDomains: ["127.0.0.1"],
    apiContracts: [contract],
    actions: [{ action: "web.query-leaves", title: "Query leaves", risk: "read", confirmation: "none", metadata: { apiContractRefs: ["list-leaves"] } }],
  }));
  fs.writeFileSync(path.join(sysDir, "capability-map.json"), JSON.stringify({
    schemaVersion: 1, systemId: "demo-erp", systemName: "Demo ERP",
    capabilities: [{
      id: "web.query-leaves", action: "web.query-leaves", title: "Query leaves", risk: "read",
      intents: ["查请假"],
      params: { required: [], optional: ["status"], properties: { status: { id: "status", type: "enum", label: "Status", options: [{ value: "open" }, { value: "closed" }] } } },
      execution: { apiContractRefs: ["list-leaves"], preferred: "api-first" },
    }],
  }));

  client = new Client({ name: "lily-e2e-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [stdioServer, "--system", sysDir] });
  await client.connect(transport);

  // 1) The learned capability is exposed as a typed tool with its param schema.
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "demo_erp__query_leaves");
  assert(tool, `expected typed tool demo_erp__query_leaves, got ${tools.map((t) => t.name).join(",")}`);
  assert(tool.inputSchema && tool.inputSchema.properties && "status" in tool.inputSchema.properties, "tool exposes the learned param schema");

  // 2) Calling the tool runs deterministically over HTTP and returns the real API result.
  const result = await client.callTool({ name: "demo_erp__query_leaves", arguments: { status: "open" } });
  const payload = JSON.parse(result.content[0].text);
  assert(payload.ok === true, `tool call should succeed, got ${JSON.stringify(payload)}`);
  assert(payload.transport === "http", `must execute over HTTP (no browser), got transport=${payload.transport}`);
  assert(payload.apiResponses?.[0]?.status === 200, "real API response captured");
  assert(JSON.stringify(payload.apiResponses[0].body) === JSON.stringify([{ id: 1, days: 2, status: "open" }]), "model received the real system data via the tool");

  console.log("PASS: test-web-system-mcp-e2e (5 tests)");
} finally {
  if (client) { try { await client.close(); } catch {} }
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
