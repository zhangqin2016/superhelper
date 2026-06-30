#!/usr/bin/env node
"use strict";

const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createProcessJobsMcpServer } = require("./process-jobs-mcp");

async function main() {
  const server = createProcessJobsMcpServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[process-jobs-mcp] ${err?.stack || err}\n`);
  process.exit(1);
});
