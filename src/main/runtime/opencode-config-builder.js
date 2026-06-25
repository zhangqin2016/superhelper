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
const DEFAULT_COMPACTION = Object.freeze({
  auto: true,
  prune: true,
  reserved: 10_000,
  tail_turns: 2,
});

function applySkillPaths(config, skillPaths) {
  const paths = (skillPaths || []).filter(Boolean);
  if (!paths.length) return;
  config.skills = { ...(config.skills || {}), paths };
}

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

// Shell commands that are genuinely risky — confirmed even in "ask" mode's
// otherwise-automatic workspace shell. Matched (via OpenCode's Wildcard) against
// the parsed command source AND the command-prefix glob the shell tool presents.
const DESTRUCTIVE_BASH = [
  "rm -rf*", "rm -fr*", "rm -r *",
  "sudo *",
  "git push*", "git reset --hard*", "git clean -f*",
  "npm publish*", "pnpm publish*", "yarn publish*",
  "mkfs*", "dd *", "shutdown*", "reboot*",
  "curl * | sh*", "curl * | bash*", "wget * | sh*", "wget * | bash*",
];

// Irreversible catastrophes — confirmed even under full autonomy. Deliberately
// narrow (root/home wipe, raw disk ops) so "Auto" stays prompt-free for real work.
const CATASTROPHIC_BASH = [
  "rm -rf /*", "rm -fr /*", "rm -rf ~*", "rm -rf ~/*", "rm -rf $HOME*",
  "mkfs*", "dd *of=/dev*",
];

/** A per-tool rule object: catch-all FIRST, specific "ask" patterns AFTER, so
 *  evaluate() (last match wins) lets the specific patterns override the default. */
function bashRules(baseAction, askPatterns) {
  const rules = { "*": baseAction };
  for (const p of askPatterns) rules[p] = "ask";
  return rules;
}

/**
 * Map a Lily permission mode + disallowedTools to an OpenCode per-tool ruleset.
 * OpenCode permissions are per-tool and pattern-aware (Action | {pattern: Action});
 * the shell tool keys on "bash" (command source + prefix), edit/write on "edit"
 * (workspace-RELATIVE path — outside the workspace begins with "../"), read on
 * "read". We exploit that for path/command-scoped rules instead of one flat action.
 */
function translatePermission(mode, disallowedTools) {
  let base;
  switch (mode) {
    case "full":
      // Autonomous: allow everything, but still confirm irreversible disasters
      // (disk wipe, root/home deletion). Normal work stays prompt-free.
      base = { "*": "allow", bash: bashRules("allow", CATASTROPHIC_BASH) };
      break;
    case "plan":
      // Read-only: navigation + research allowed (explicitly, so reads don't hit
      // OpenCode's "ask" default), all mutations denied.
      base = {
        read: "allow", grep: "allow", glob: "allow", list: "allow", lsp: "allow",
        webfetch: "allow", websearch: "allow",
        edit: "deny", bash: "deny", task: "deny",
      };
      break;
    case "ask":
    default:
      // Balanced default: normal work INSIDE this workspace runs automatically;
      // confirm only genuinely risky shell commands and edits OUTSIDE the
      // workspace (relative path starts with "../"). Reads/research are free.
      base = {
        read: "allow", grep: "allow", glob: "allow", list: "allow", lsp: "allow",
        webfetch: "allow", websearch: "allow",
        task: "allow",
        edit: { "*": "allow", "../*": "ask" },
        external_directory: "ask",
        bash: bashRules("allow", DESTRUCTIVE_BASH),
      };
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
 *   skillPaths?: string[],
 * }} opts
 * @returns {{ ok: boolean, reason?: string, model: object|null, configContent: string|null }}
 */
function buildOpencodeConfig(opts = {}) {
  const modelCfg = resolveOpencodeModelConfig(opts.lilyEnv || {});
  if (!modelCfg.ok) {
    return { ok: false, reason: modelCfg.reason, model: modelCfg.model, configContent: null, diagnostics: modelCfg.diagnostics || null };
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

  config.compaction = { ...DEFAULT_COMPACTION, ...(config.compaction || {}) };
  applySkillPaths(config, opts.skillPaths);

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

  return { ok: true, model: modelCfg.model, configContent: JSON.stringify(config), diagnostics: modelCfg.diagnostics || null };
}

/**
 * Permission policy for the SINGLE SHARED serve: reads/research run free; every
 * mutation is "ask", so the host receives a permission event and enforces the
 * session's MODE by auto-responding (see opencode-permission-policy). One policy
 * for all sessions — the per-session mode lives host-side, never in the serve.
 */
function baseSharedPermission() {
  return {
    read: "allow", grep: "allow", glob: "allow", list: "allow", lsp: "allow",
    webfetch: "allow", websearch: "allow", task: "allow",
    edit: "ask", write: "ask", bash: "ask", external_directory: "ask",
  };
}

/**
 * The config for the app's ONE shared serve — only truly app-wide pieces:
 * provider(s) + model tiers, the UNION of all skills' MCP servers, local
 * plugins, and the single "ask every mutation" base permission. Per-session
 * bits (skill guidance, permission mode) are delivered per-request + host-side,
 * NOT baked here — that's what lets one serve host every session/directory
 * without cross-session config bleed.
 * @param {{ lilyEnv: Record<string,string>, mcpServers?: object, pluginPaths?: string[], skillPaths?: string[], disallowedTools?: string[] }} opts
 * @returns {{ ok:boolean, reason?:string, model:object|null, configContent:string|null }}
 */
function buildSharedBaseConfig(opts = {}) {
  const modelCfg = resolveOpencodeModelConfig(opts.lilyEnv || {});
  if (!modelCfg.ok) {
    return { ok: false, reason: modelCfg.reason, model: modelCfg.model, configContent: null, diagnostics: modelCfg.diagnostics || null };
  }
  const config = JSON.parse(modelCfg.configContent); // { $schema, model, provider }

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

  config.compaction = { ...DEFAULT_COMPACTION, ...(config.compaction || {}) };
  applySkillPaths(config, opts.skillPaths);

  config.permission = baseSharedPermission();
  // App-wide disabled tools (e.g. WebSearch/WebFetch) — a constant policy, so it
  // belongs in the shared base. Denied outright (no host-side gate needed).
  for (const t of opts.disallowedTools || []) {
    config.permission[TOOL_NAME_MAP[t] || String(t).toLowerCase()] = "deny";
  }

  const plugins = (opts.pluginPaths || []).filter(Boolean);
  if (plugins.length) config.plugin = plugins;

  return { ok: true, model: modelCfg.model, configContent: JSON.stringify(config), diagnostics: modelCfg.diagnostics || null };
}

module.exports = {
  buildOpencodeConfig,
  buildSharedBaseConfig,
  baseSharedPermission,
  translateMcpServers,
  translatePermission,
  applySkillPaths,
  DEFAULT_COMPACTION,
  DESTRUCTIVE_BASH,
  CATASTROPHIC_BASH,
};
