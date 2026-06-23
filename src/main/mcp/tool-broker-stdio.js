#!/usr/bin/env node
"use strict";

/**
 * Stdio entry for Lily's session-scoped tool broker.
 *
 * Current production use is behind LILY_TOOL_BROKER=1 while we finish the
 * request-context bridge from the shared OpenCode server. Without an explicit
 * context this server fails closed and exposes no Lily extension tools.
 */

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createToolBrokerMcpServer } = require("./tool-broker-mcp");

function parseContextEnv() {
  const raw = process.env.LILY_TOOL_BROKER_CONTEXT || "";
  if (!raw) return { ok: false, error: "SESSION_CONTEXT_MISSING" };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "SESSION_CONTEXT_INVALID" };
    return parsed;
  } catch {
    return { ok: false, error: "SESSION_CONTEXT_INVALID" };
  }
}

async function main() {
  const context = parseContextEnv();
  const server = await createToolBrokerMcpServer({ context });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[tool-broker-mcp] ${err?.stack || err}\n`);
  process.exit(1);
});
