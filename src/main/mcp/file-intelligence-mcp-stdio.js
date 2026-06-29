#!/usr/bin/env node
"use strict";

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createFileIntelligenceMcpServer } = require("./file-intelligence-mcp");

async function main() {
  const server = createFileIntelligenceMcpServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[file-intelligence-mcp] ${err?.stack || err}\n`);
  process.exit(1);
});
