"use strict";

/**
 * A learned web system as a Model Context Protocol server.
 *
 * Each capability the system learned (capability-map.json) becomes one native,
 * typed MCP tool: the model calls it by name with schema-validated arguments,
 * and the injected `run(capabilityId, params)` executes it deterministically
 * (API-first browser-free HTTP, or browser fallback) — instead of the model
 * authoring an operation plan and trial-and-erroring it.
 *
 * Generic + injected `run`, mirroring mail-mcp: the same tool definitions work
 * in-process or via the stdio proxy. One server per learned system keeps tool
 * names local (no cross-system collision); the host activates only the relevant
 * system's server per context (mcp_toggle / --mcp-config), so the active tool
 * set stays small even with ~10 learned systems.
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");

function asText(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

/** MCP-safe tool name: `<system>__<capability>`, letters/digits/underscore. */
function toolNameForCapability(systemId, capabilityId) {
  const norm = (v, fallback) => {
    const s = String(v || "")
      .replace(/^web\./, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return s || fallback;
  };
  return `${norm(systemId, "system")}__${norm(capabilityId, "action")}`.slice(0, 64);
}

/** Map one learned param to a zod schema (typed validation the protocol enforces). */
function zodForParam(prop) {
  const type = String(prop?.type || "string").toLowerCase();
  let schema;
  if (type === "enum") {
    const options = (Array.isArray(prop?.options) ? prop.options : [])
      .map((o) => String(o?.value ?? o?.label ?? o ?? "").trim())
      .filter(Boolean);
    schema = options.length ? z.enum(options) : z.string();
  } else if (type === "number") {
    schema = z.number();
  } else if (type === "boolean") {
    schema = z.boolean();
  } else {
    schema = z.string(); // string | date | file
  }
  const label = String(prop?.label || prop?.name || "").trim();
  return label ? schema.describe(label) : schema;
}

/** Build the tool inputSchema (zod shape) from a capability's params. */
function buildToolInputSchema(capability) {
  const props = capability?.params?.properties || {};
  const required = new Set(Array.isArray(capability?.params?.required) ? capability.params.required : []);
  const shape = {};
  for (const [id, prop] of Object.entries(props)) {
    let schema = zodForParam(prop);
    if (!required.has(id)) schema = schema.optional();
    shape[id] = schema;
  }
  return shape;
}

/** Risk → MCP tool annotations so the engine's permission flow gates writes. */
function annotationsForRisk(risk) {
  if (risk === "submit" || risk === "destructive") return { destructiveHint: true, openWorldHint: true };
  if (risk === "read") return { readOnlyHint: true, openWorldHint: true };
  return { openWorldHint: true };
}

function buildDescription(systemName, capability) {
  const intents = Array.isArray(capability?.intents) ? capability.intents.filter(Boolean) : [];
  const parts = [
    `${capability?.title || capability?.id || "Action"} — operate ${systemName || "the system"}.`,
  ];
  if (intents.length) parts.push(`Examples: ${intents.slice(0, 5).join(" / ")}.`);
  if (capability?.risk && capability.risk !== "read") parts.push(`(risk: ${capability.risk}; user confirmation enforced)`);
  return parts.join(" ");
}

/** Pure: the tool definitions for a system's capabilities (testable without a server). */
function buildSystemTools(systemId, systemName, capabilities) {
  return (Array.isArray(capabilities) ? capabilities : []).map((capability) => ({
    name: toolNameForCapability(systemId, capability?.id || capability?.action),
    capabilityId: capability?.id || capability?.action || "",
    description: buildDescription(systemName, capability),
    inputSchema: buildToolInputSchema(capability),
    annotations: annotationsForRisk(capability?.risk),
  }));
}

/**
 * @param {{ systemId: string, systemName?: string, capabilities: object[],
 *   run: (capabilityId: string, params: object) => Promise<any> }} opts
 * @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer}
 */
function createWebSystemMcpServer({ systemId, systemName, capabilities, run }) {
  const server = new McpServer({ name: `lily-web-${systemId}`, version: "1.0.0" });
  for (const tool of buildSystemTools(systemId, systemName, capabilities)) {
    if (!tool.name || !tool.capabilityId) continue;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args) => asText(await run(tool.capabilityId, args || {})),
    );
  }
  return server;
}

module.exports = {
  toolNameForCapability,
  zodForParam,
  buildToolInputSchema,
  annotationsForRisk,
  buildSystemTools,
  createWebSystemMcpServer,
  asText,
};
