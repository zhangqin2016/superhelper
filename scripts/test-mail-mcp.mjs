// Mail MCP server: tools/schemas/dispatch (in-process) + the stdio proxy that
// the engine launches (spawned, forwarding to a mock connector bridge).
// All headless — no real engine, no real mail.
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMailMcpServer, inProcessRun } = require("../src/main/mcp/mail-mcp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const TOOL_NAMES = ["list_mail_accounts", "read_mail", "search_mail", "send_mail"];

// ---------- Part 1: in-process server via mail-actions ----------
{
  const mailStore = {
    listAccountsPublic: () => [{ id: "m1", account: "alice@163.com", provider: "imap-smtp", status: "connected" }],
    getAccountWithSecret: () => null, // search/read/send → ACCOUNT_NOT_FOUND (no network)
    saveOAuthToken: () => {},
  };
  const server = createMailMcpServer(inProcessRun(mailStore));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(ct);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOL_NAMES);
  const sendTool = tools.find((t) => t.name === "send_mail");
  assert.ok(sendTool.annotations?.destructiveHint, "send_mail is destructive (governed)");
  // Attachments + cc/bcc/html must be sendable (regression: the MCP schema
  // previously exposed only to/subject/text, so attachments were impossible).
  assert.ok(sendTool.inputSchema?.properties?.attachments, "send_mail accepts attachments");
  assert.ok(sendTool.inputSchema?.properties?.cc, "send_mail accepts cc");
  assert.ok(sendTool.inputSchema?.properties?.html, "send_mail accepts html");

  const listed = await client.callTool({ name: "list_mail_accounts", arguments: {} });
  assert.ok(listed.content[0].text.includes("alice@163.com"));
  const searched = await client.callTool({ name: "search_mail", arguments: { accountId: "m1", limit: 5 } });
  assert.ok(searched.content[0].text.includes("ACCOUNT_NOT_FOUND"));
  await client.close();
}

// ---------- Part 2: stdio proxy (as the engine launches it) → mock bridge ----------
{
  const bridge = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = req.headers.authorization === "Bearer test-token";
      const url = new URL(req.url, "http://127.0.0.1");
      let out = { ok: false, error: "NOT_FOUND" };
      if (!auth) out = { ok: false, error: "UNAUTHORIZED" };
      else if (url.pathname === "/v1/mail/accounts") out = { ok: true, accounts: [{ id: "m1", account: "bob@qq.com" }] };
      else if (url.pathname === "/v1/mail/search") out = { ok: true, messages: [{ uid: 7, subject: "hello" }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
  const port = bridge.address().port;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "src/main/mcp/mail-mcp-stdio.js")],
    env: {
      ...process.env,
      LILY_CONNECTOR_BRIDGE_URL: `http://127.0.0.1:${port}`,
      LILY_CONNECTOR_BRIDGE_TOKEN: "test-token",
    },
  });
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOL_NAMES, "stdio server exposes the same tools");
  const listed = await client.callTool({ name: "list_mail_accounts", arguments: {} });
  assert.ok(listed.content[0].text.includes("bob@qq.com"), "stdio proxied list to the bridge");
  const searched = await client.callTool({ name: "search_mail", arguments: { accountId: "m1" } });
  assert.ok(searched.content[0].text.includes("hello"), "stdio proxied search to the bridge");

  await client.close();
  bridge.close();
}

console.log("mail-mcp: ok");
