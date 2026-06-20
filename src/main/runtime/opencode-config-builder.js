"use strict";

/**
 * Assemble the full OPENCODE_CONFIG_CONTENT (V1 config) that makes the OpenCode
 * engine behave like Lily's Claude setup: the distributed model (provider), the
 * MCP servers, the permission policy, and the system prompt + skill guidance
 * (via `instructions` pointing at Lily's session AGENT.md).
 *
 * Verified against vendored OpenCode 1.17.8 V1 config schema:
 *   provider.<id>        custom openai-compatible model (see opencode-model-config)
 *   mcp.<name>           { type:"local", command:[cmd,...args], environment }
 *   permission.<tool>    "ask" | "allow" | "deny"
 *   instructions[]       file paths whose contents become ambient instructions
 */

const { resolveOpencodeModelConfig } = require("./opencode-model-config");

/** Subagent agent names whose model maps to Lily's LILY_SUBAGENT_MODEL tier. */
const SUBAGENT_AGENTS = ["general", "explore"];

/**
 * Lily MCP shape ({name:{command, args, env}}, all stdio) -> OpenCode mcp
 * ({name:{type:"local", command:[cmd,...args], environment}}).
 */
function translateMcpServers(mcpServers) {
  const out = {};
  for (const [name, s] of Object.entries(mcpServers || {})) {
    if (!s || !s.command) continue;
    const command = [s.command, ...(Array.isArray(s.args) ? s.args : [])];
    out[name] = { type: "local", command };
    if (s.env && Object.keys(s.env).length) out[name].environment = s.env;
  }
  return out;
}

/** Claude tool names -> OpenCode tool names (for disallowedTools + modes). */
const TOOL_NAME_MAP = {
  WebSearch: "websearch",
  WebFetch: "webfetch",
  Bash: "bash",
  Edit: "edit",
  Write: "write",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
};

/**
 * Map a Lily permission mode + disallowedTools to an OpenCode per-tool ruleset.
 * Approximate — OpenCode is per-tool ask/allow/deny, Lily modes are coarser.
 */
function translatePermission(mode, disallowedTools) {
  let base;
  switch (mode) {
    case "bypassPermissions":
      base = { bash: "allow", edit: "allow", write: "allow", webfetch: "allow", websearch: "allow" };
      break;
    case "acceptEdits":
      base = { edit: "allow", write: "allow", bash: "ask" };
      break;
    case "plan":
      // Plan-first: no mutations until approved.
      base = { edit: "deny", write: "deny", bash: "deny" };
      break;
    case "dontAsk":
      // No prompts; risky ops skipped rather than asked.
      base = { bash: "deny", edit: "deny", write: "deny" };
      break;
    case "auto":
      base = { bash: "ask", edit: "allow" };
      break;
    case "default":
    default:
      base = { bash: "ask", edit: "ask", write: "ask" };
      break;
  }
  for (const t of disallowedTools || []) {
    base[TOOL_NAME_MAP[t] || String(t).toLowerCase()] = "deny";
  }
  return base;
}

/**
 * @param {{
 *   lilyEnv: Record<string,string>,
 *   mcpServers?: Record<string, {command:string, args?:string[], env?:Record<string,string>}>,
 *   permissionMode?: string,
 *   disallowedTools?: string[],
 *   instructionsPaths?: string[],
 * }} opts
 * @returns {{ ok: boolean, reason?: string, model: object|null, configContent: string|null }}
 */
function buildOpencodeConfig(opts = {}) {
  const modelCfg = resolveOpencodeModelConfig(opts.lilyEnv || {});
  if (!modelCfg.ok) {
    return { ok: false, reason: modelCfg.reason, model: modelCfg.model, configContent: null };
  }
  const config = JSON.parse(modelCfg.configContent); // { $schema, model, provider }

  // Model tiers: small/fast model for title/summary; subagents get the subagent
  // tier. (All tier ids are already declared under the provider by the model config.)
  const pid = modelCfg.model.providerID;
  const tiers = modelCfg.tiers || {};
  if (tiers.haiku) config.small_model = `${pid}/${tiers.haiku}`;
  if (tiers.subagent) {
    config.agent = config.agent || {};
    for (const name of SUBAGENT_AGENTS) {
      config.agent[name] = { ...(config.agent[name] || {}), model: `${pid}/${tiers.subagent}` };
    }
  }

  const mcp = translateMcpServers(opts.mcpServers);
  if (Object.keys(mcp).length) config.mcp = mcp;

  const permission = translatePermission(opts.permissionMode, opts.disallowedTools);
  if (Object.keys(permission).length) config.permission = permission;

  // Lily's persona/rules/skills live in its AGENT.md. As `instructions` (appended
  // after OpenCode's coding base prompt) it loses to the "you are a coding CLI"
  // framing. As the primary AGENT prompt (prepended, authoritative) it governs —
  // turning the engine from a code agent into Lily. This is Lily's OWN content,
  // not invented text. Applied to the user-facing primary agents (build/plan).
  const agentPrompt = typeof opts.agentPrompt === "string" ? opts.agentPrompt.trim() : "";
  if (agentPrompt) {
    config.agent = config.agent || {};
    for (const name of ["build", "plan"]) {
      config.agent[name] = { ...(config.agent[name] || {}), prompt: agentPrompt };
    }
  } else {
    const instructions = (opts.instructionsPaths || []).filter(Boolean);
    if (instructions.length) config.instructions = instructions;
  }

  // Local plugin files (e.g. the post-edit verification hook). Absolute paths
  // are loaded as "file" plugins by OpenCode (no npm install).
  const plugins = (opts.pluginPaths || []).filter(Boolean);
  if (plugins.length) config.plugin = plugins;

  return { ok: true, model: modelCfg.model, configContent: JSON.stringify(config) };
}

module.exports = { buildOpencodeConfig, translateMcpServers, translatePermission };
