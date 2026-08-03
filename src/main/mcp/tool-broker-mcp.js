"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");
const { allToolDefinitions, asTextJson, buildBrokerTools, findBrokerTool } = require("./tool-broker-registry");
const { createLazyDraftAuthoring } = require("../character-worlds/agent-draft-tools");

const RUNTIME_TOKEN_FIELD = "__lilyRuntimeToken";

function normalizeContextProvider(contextOrProvider) {
  if (typeof contextOrProvider === "function") return contextOrProvider;
  return async () => contextOrProvider || { ok: false, error: "SESSION_CONTEXT_MISSING" };
}

// Broker servers that get no explicit character-worlds wiring (the stdio
// subprocess in production, tests that only pass a context) receive the lazy
// per-process authoring factory so lily_character_draft can execute against
// the config userData store. Construction is deferred to the first draft
// call; failure fails closed inside the tool handler.
function withDraftAuthoringFallback(registryDeps) {
  const deps = { ...(registryDeps || {}) };
  if (!deps.characterWorldsService && !deps.characterAuthoringService
    && typeof deps.resolveDraftAuthoring !== "function") {
    deps.resolveDraftAuthoring = createLazyDraftAuthoring();
  }
  return deps;
}

function extractRuntimeIdentityToken(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const token = String(args[RUNTIME_TOKEN_FIELD] || "").trim();
  delete args[RUNTIME_TOKEN_FIELD];
  return token;
}

function withRuntimeIdentityInputSchema(inputSchema = {}) {
  return {
    ...(inputSchema || {}),
    [RUNTIME_TOKEN_FIELD]: z.string().max(8_192).optional()
      .describe("Lily host runtime identity; injected automatically and never supplied by the model"),
  };
}

function createRuntimeIdentityContextProvider({
  fallbackProvider,
  secret,
  audience = "tool-broker",
  now = () => Date.now(),
  isRevoked = () => false,
} = {}) {
  const fallback = normalizeContextProvider(fallbackProvider);
  return async (args) => {
    const token = extractRuntimeIdentityToken(args);
    const base = await fallback();
    if (!token) return base;
    const { redactRuntimeIdentity, verifyRuntimeIdentity } = require("../runtime-identity");
    const identity = verifyRuntimeIdentity(token, {
      secret,
      audience,
      now: now(),
      isRevoked,
    });
    return {
      ...base,
      ok: true,
      platformOnly: false,
      principalId: identity.principalId,
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      taskRunId: identity.taskRunId,
      agentId: identity.agentId,
      attemptId: identity.attemptId,
      workspacePath: identity.workspacePath === "workspace:none" ? "" : identity.workspacePath,
      permissionMode: identity.permissionMode,
      activeSkillIds: identity.activeSkillIds,
      runtimeIdentity: redactRuntimeIdentity(identity),
    };
  };
}

async function callToolWithVisibilityCheck(contextProvider, toolName, args, deps, extra) {
  const context = await contextProvider(args, extra);
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
async function createToolBrokerMcpServer({ context, contextProvider, registryDeps, runtimeIdentity } = {}) {
  const fallbackProvider = normalizeContextProvider(contextProvider || context);
  const provider = runtimeIdentity?.secret
    ? createRuntimeIdentityContextProvider({
        fallbackProvider,
        secret: runtimeIdentity.secret,
        audience: runtimeIdentity.audience || "tool-broker",
        now: runtimeIdentity.now,
        isRevoked: runtimeIdentity.isRevoked,
      })
    : fallbackProvider;
  const initialContext = await provider();
  const deps = withDraftAuthoringFallback(registryDeps);
  const server = new McpServer({ name: "lily-tool-broker", version: "1.0.0" });

  const registeredTools = runtimeIdentity?.secret
    ? allToolDefinitions(initialContext || {}, deps).filter((tool) => !tool.handler?.unavailableCode)
    : buildBrokerTools(initialContext, deps);
  for (const tool of registeredTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: runtimeIdentity?.secret
          ? withRuntimeIdentityInputSchema(tool.inputSchema || {})
          : tool.inputSchema || {},
        annotations: tool.annotations || {},
      },
      async (args, extra) => callToolWithVisibilityCheck(provider, tool.name, args, deps, extra),
    );
  }
  if (typeof server.setToolRequestHandlers === "function") {
    server.setToolRequestHandlers();
  }

  return server;
}

module.exports = {
  callToolWithVisibilityCheck,
  createRuntimeIdentityContextProvider,
  createToolBrokerMcpServer,
  extractRuntimeIdentityToken,
  withRuntimeIdentityInputSchema,
};
