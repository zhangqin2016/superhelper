#!/usr/bin/env node
"use strict";

/**
 * Stdio entry for Lily's session-scoped tool broker.
 *
 * Without an explicit session context this server exposes only platform-level
 * tools: capability diagnostics, runtime-pack install/list, and the
 * policy-gated lily_character_draft (drafting creates unbound owner-scoped
 * library entities, so it needs no session authority; it executes against the
 * config userData store through the lazy authoring factory wired in
 * tool-broker-mcp, and disappears under a disabled policy or the kill
 * switch). Session-scoped tools such as mail or learned web systems still
 * require explicit context.
 */

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createToolBrokerMcpServer } = require("./tool-broker-mcp");

function parseContextEnv() {
  const raw = process.env.LILY_TOOL_BROKER_CONTEXT || "";
  if (!raw) return { platformOnly: true, activeSkillIds: [] };
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
