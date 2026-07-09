"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { asTextJson, buildBrokerTools, findBrokerTool } = require("./tool-broker-registry");

function normalizeContextProvider(contextOrProvider) {
  if (typeof contextOrProvider === "function") return contextOrProvider;
  return async () => contextOrProvider || { ok: false, error: "SESSION_CONTEXT_MISSING" };
}

async function callToolWithVisibilityCheck(contextProvider, toolName, args, deps) {
  const context = await contextProvider();
  const tool = findBrokerTool(context, toolName, deps);
  if (!tool) {
    return asTextJson({
      ok: false,
      error: "TOOL_NOT_AVAILABLE_FOR_SESSION",
      tool: toolName,
      sessionId: context?.sessionId || null,
    });
  }
  const handler = typeof tool.handler === "function"
    ? tool.handler
    : async () => ({ ok: false, error: "TOOL_HANDLER_MISSING" });
  return asTextJson(await handler(args || {}, context, deps));
}

/**
 * Create a Lily tool-broker MCP server for one resolved session context.
 *
 * The initial context controls `tools/list`. Each call re-resolves context and
 * checks visibility again before executing the handler.
 */
async function createToolBrokerMcpServer({ context, contextProvider, registryDeps } = {}) {
  const provider = normalizeContextProvider(contextProvider || context);
  const initialContext = await provider();
  const server = new McpServer({ name: "lily-tool-broker", version: "1.0.0" });

  for (const tool of buildBrokerTools(initialContext, registryDeps)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema || {},
        annotations: tool.annotations || {},
      },
      async (args) => callToolWithVisibilityCheck(provider, tool.name, args, registryDeps),
    );
  }
  if (typeof server.setToolRequestHandlers === "function") {
    server.setToolRequestHandlers();
  }

  return server;
}

module.exports = {
  callToolWithVisibilityCheck,
  createToolBrokerMcpServer,
};
