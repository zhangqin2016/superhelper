// Mail MCP server: tools are exposed with schemas and dispatch correctly.
// Uses the SDK's in-memory transport + client — no engine, no network.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMailMcpServer } = require("../src/main/mcp/mail-mcp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

// Mock store: list shows an account; getAccountWithSecret returns null so
// search/read/send hit the ACCOUNT_NOT_FOUND path (no real IMAP connection).
const mailStore = {
  listAccountsPublic: () => [{ id: "m1", account: "alice@163.com", provider: "imap-smtp", status: "connected" }],
  getAccountWithSecret: () => null,
  saveOAuthToken: () => {},
};

const server = createMailMcpServer(mailStore);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);

const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(clientTransport);

// --- tools are discoverable with the expected names + schemas ---
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, ["list_mail_accounts", "read_mail", "search_mail", "send_mail"]);
const search = tools.find((t) => t.name === "search_mail");
assert.ok(search.description && search.inputSchema?.properties?.accountId, "search_mail advertises an accountId param");
const send = tools.find((t) => t.name === "send_mail");
assert.ok(send.inputSchema?.properties?.to && send.inputSchema?.properties?.subject, "send_mail advertises to/subject");

// --- list_mail_accounts returns the store's accounts ---
const listed = await client.callTool({ name: "list_mail_accounts", arguments: {} });
assert.ok(listed.content[0].text.includes("alice@163.com"), "list returns the connected account");

// --- search dispatches through mail-actions; missing secret → ACCOUNT_NOT_FOUND (no network) ---
const searched = await client.callTool({ name: "search_mail", arguments: { accountId: "m1", limit: 5 } });
assert.ok(searched.content[0].text.includes("ACCOUNT_NOT_FOUND"), "search routes through dispatch");

await client.close();
console.log("mail-mcp: ok");
