#!/usr/bin/env node
"use strict";

/**
 * Stdio entry for the mail MCP server, launched by the engine via --mcp-config
 * (run through the app binary with ELECTRON_RUN_AS_NODE=1 so it has the app's
 * node_modules — the MCP SDK — without bundling anything extra).
 *
 * It is a thin proxy: it has no account secrets of its own, so each tool call is
 * forwarded over HTTP to the connector bridge running in the Electron main
 * process (which holds the safeStorage-protected credentials). The bridge URL
 * and bearer token arrive via env.
 */

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createMailMcpServer } = require("./mail-mcp.js");

const BASE = process.env.LILY_CONNECTOR_BRIDGE_URL || "";
const TOKEN = process.env.LILY_CONNECTOR_BRIDGE_TOKEN || "";

// action → bridge endpoint
const ENDPOINT = { accounts: "accounts", search: "search", read: "read", send: "send" };

async function bridgeRun(action, payload) {
  if (!BASE || !TOKEN) return { ok: false, error: "BRIDGE_UNAVAILABLE" };
  const endpoint = ENDPOINT[action];
  if (!endpoint) return { ok: false, error: "UNSUPPORTED_ACTION" };
  try {
    const res = await fetch(`${BASE}/v1/mail/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: "BRIDGE_REQUEST_FAILED", message: err?.message || String(err) };
  }
}

async function main() {
  const server = createMailMcpServer(bridgeRun);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[mail-mcp] ${err?.stack || err}\n`);
  process.exit(1);
});
