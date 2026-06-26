#!/usr/bin/env node
/**
 * Full OPENCODE_CONFIG_CONTENT assembly: model + MCP + permission + instructions.
 * These translations are what carry Lily's MCP tools, permission policy, and
 * system-prompt/skill guidance into the OpenCode engine, so the shapes must
 * match OpenCode's V1 config exactly.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  buildOpencodeConfig,
  buildSharedBaseConfig,
  translateMcpServers,
  translatePermission,
  baseSharedPermission,
} = require("../src/main/runtime/opencode-config-builder.js");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Subagent-nesting cap: OpenCode injects `task: deny` into spawned children ONLY
// if the child agent has no explicit `task` rule. So the shared/ask permission
// must NOT pin `task:"allow"` — doing so defeats the cap and lets subagents spawn
// subagents (unbounded nesting + runaway turns). Top-level keeps task via the
// engine's "*":"allow" default. plan intentionally denies task (no subagents).
{
  assert(!("task" in baseSharedPermission()), "shared serve permission must NOT pin task (defeats subagent nesting cap)");
  assert(!("task" in translatePermission("ask")), "ask mode must NOT pin task=allow (defeats subagent nesting cap)");
  assert(!("task" in translatePermission("full")), "full mode must not pin an explicit task rule");
  assert(translatePermission("plan").task === "deny", "plan stays read-only: task denied");
  const shared = JSON.parse(buildSharedBaseConfig({
    lilyEnv: { LILY_API_BASE_URL: "https://api.deepseek.com", LILY_API_KEY: "sk", LILY_MODEL: "deepseek-chat" },
  }).configContent);
  assert(!("task" in (shared.permission || {})), "built shared config must not pin task");
}

// --- MCP translation (Lily {command,args,env} -> OpenCode local server) ------
{
  const oc = translateMcpServers({
    mail: { command: "/node", args: ["/mail.js", "--x"], env: { K: "v" } },
    playwright: { command: "/node", args: ["/pw.js"] },
    bogus: { args: ["no-command"] },
  });
  assert(oc.mail.type === "local", "mcp server -> type local");
  assert(JSON.stringify(oc.mail.command) === JSON.stringify(["/node", "/mail.js", "--x"]), "command = [cmd, ...args]");
  assert(oc.mail.environment.K === "v", "env -> environment");
  assert(!("environment" in oc.playwright), "no environment when no env");
  assert(!("bogus" in oc), "server without command dropped");
}

// --- permission mode -> per-tool ruleset ------------------------------------
{
  // full uses a "*" catch-all so EVERY permission type (incl. external_directory)
  // is allowed, not just the common tools — otherwise OpenCode's "ask" default
  // still prompts a fully-authorized session.
  assert(translatePermission("full")["*"] === "allow", "full -> wildcard allow");
  // Even full confirms irreversible catastrophes (bash is now a pattern ruleset).
  assert(translatePermission("full").bash["*"] === "allow", "full -> bash allowed by default");
  assert(translatePermission("full").bash["rm -rf /*"] === "ask", "full -> root wipe still asks");
  assert(translatePermission("plan").edit === "deny", "plan -> edit deny");
  assert(translatePermission("plan").read === "allow", "plan -> reads explicitly allowed (no ask-default nag)");
  assert(translatePermission("plan").websearch === "allow", "plan -> research still allowed");
  // ask: automatic inside the workspace, confirm risky shell + out-of-workspace edits.
  assert(translatePermission("ask").bash["*"] === "allow", "ask -> safe shell runs automatically");
  assert(translatePermission("ask").bash["rm -rf*"] === "ask", "ask -> destructive shell confirmed");
  assert(translatePermission("ask").edit["*"] === "allow", "ask -> in-workspace edits automatic");
  assert(translatePermission("ask").edit["../*"] === "ask", "ask -> edits outside the workspace confirmed");
  assert(translatePermission("does-not-exist").bash["*"] === "allow", "unknown mode -> ask default ruleset");
  // disallowedTools force deny even under full's "*" allow — evaluate() takes the
  // LAST matching rule, and the deny keys are appended after "*".
  const full = translatePermission("full", ["WebSearch"]);
  assert(full["*"] === "allow" && full.websearch === "deny", "full + disallowed -> wildcard allow but tool denied");
  const p = translatePermission("ask", ["WebSearch", "WebFetch"]);
  assert(p.websearch === "deny" && p.webfetch === "deny", "disallowedTools -> deny (mapped names)");
}

// --- every OpenCode tier uses the selected main Pro model -------------------
{
  const r = buildOpencodeConfig({
    lilyEnv: {
      LILY_API_BASE_URL: "https://api.deepseek.com", LILY_API_KEY: "sk",
      LILY_MODEL: "deepseek-chat", LILY_MODEL_HAIKU: "deepseek-lite", LILY_SUBAGENT_MODEL: "deepseek-lite",
    },
  });
  const cfg = JSON.parse(r.configContent);
  assert(cfg.small_model === "lily/deepseek-chat", "small_model forced to main model");
  assert(cfg.agent.general.model === "lily/deepseek-chat" && cfg.agent.explore.model === "lily/deepseek-chat", "subagent agents forced to main model");
  // The built-in compaction/title agents ship with NO model -> they would resolve
  // to OpenCode's default opencode/*-free (no creds in our build) and 500. Pinning
  // them keeps native compaction (long-session memory) and titling on the gateway.
  assert(cfg.agent.compaction.model === "lily/deepseek-chat", "compaction agent pinned to distributed model");
  assert(cfg.agent.title.model === "lily/deepseek-chat", "title agent pinned to distributed model");
  assert(r.diagnostics.ignoredTierModels.haiku === "deepseek-lite", "ignored fast tier diagnosed");
}

// --- full config assembly ---------------------------------------------------
{
  const r = buildOpencodeConfig({
    lilyEnv: { LILY_API_BASE_URL: "https://api.deepseek.com", LILY_API_KEY: "sk", LILY_MODEL: "deepseek-chat" },
    mcpServers: { mail: { command: "/node", args: ["/mail.js"], env: {} } },
    permissionMode: "ask",
    disallowedTools: ["WebSearch"],
    instructionsPaths: ["/data/session-guides/s1/AGENT.md", ""],
    pluginPaths: ["/app/resources/opencode-plugins/verify-edit.js", ""],
    skillPaths: ["/data/lily-config/skills", ""],
  });
  assert(r.ok, "config builds ok");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.plugin.length === 1 && cfg.plugin[0].endsWith("verify-edit.js"), "plugin (verification hook) merged, blanks dropped");
  assert(cfg.skills.paths.length === 1 && cfg.skills.paths[0].endsWith("/skills"), "Lily skill paths merged, blanks dropped");
  assert(cfg.provider.lily.options.baseURL === "https://api.deepseek.com", "provider carried");
  assert(cfg.model === "lily/deepseek-chat", "default model carried");
  assert(cfg.mcp.mail.type === "local", "mcp merged in");
  assert(cfg.permission.bash["*"] === "allow" && cfg.permission.websearch === "deny", "permission merged in (ask ruleset + disallowed deny)");
  assert(cfg.instructions.length === 1 && cfg.instructions[0].endsWith("AGENT.md"), "fallback: instructions paths used when no agentPrompt");
  assert(cfg.compaction.auto === true, "native OpenCode auto-compaction explicitly enabled");
  assert(cfg.compaction.prune === true, "native OpenCode tool-output prune explicitly enabled");
  assert(cfg.compaction.reserved === 10000, "native OpenCode compaction reserve pinned for stable defaults");
}

// --- shared config also pins native compaction defaults ---------------------
{
  const r = buildSharedBaseConfig({
    lilyEnv: { LILY_API_BASE_URL: "https://api.deepseek.com", LILY_API_KEY: "sk", LILY_MODEL: "deepseek-chat" },
    skillPaths: ["/data/lily-config/skills", ""],
  });
  const cfg = JSON.parse(r.configContent);
  assert(cfg.compaction.auto === true, "shared serve -> auto compaction enabled");
  assert(cfg.compaction.prune === true, "shared serve -> prune enabled");
  assert(cfg.compaction.tail_turns === 2, "shared serve -> tail turn retention matches OpenCode default");
  assert(cfg.skills.paths.length === 1 && cfg.skills.paths[0].endsWith("/skills"), "shared serve -> Lily skill registry path configured");
  // WHY: without basePrompt, build/plan have no agent.prompt, so OpenCode's
  // request.ts ternary falls back to SystemPrompt.provider() = the coding-CLI
  // baseline (default.txt). That baseline ("answer in <4 lines, one-word answers
  // best", "software engineering tool") is what made the workbench "dumb" on
  // general tasks. This asserts the regression's precondition so the next block
  // proves the fix actually removes it.
  assert(!cfg.agent || !cfg.agent.build || !cfg.agent.build.prompt, "no basePrompt -> coding baseline NOT suppressed (regression precondition)");
}

// --- shared serve SUPPRESSES the coding-CLI baseline for user-facing agents ---
{
  // basePrompt is Lily's own static identity header. Setting it as the build/plan
  // agent prompt makes OpenCode's request.ts use it INSTEAD OF default.txt, so a
  // general request is no longer reframed as a terse coding task. The full
  // per-turn guide still rides body.system; subagents keep the coding baseline.
  const persona = "# 智能工作台全局说明\n你是智能工作台（Lily Workbench）助手。";
  const r = buildSharedBaseConfig({
    lilyEnv: { LILY_API_BASE_URL: "https://api.deepseek.com", LILY_API_KEY: "sk", LILY_MODEL: "deepseek-chat" },
    basePrompt: persona,
  });
  const cfg = JSON.parse(r.configContent);
  assert(cfg.agent.build.prompt === persona, "basePrompt -> build agent prompt set (default.txt suppressed)");
  assert(cfg.agent.plan.prompt === persona, "basePrompt -> plan agent prompt set (default.txt suppressed)");
  // Subagents must NOT get the workbench persona — they do code subtasks and
  // should keep OpenCode's coding baseline (they only get the model pin, if any).
  assert(!cfg.agent.general || !cfg.agent.general.prompt, "subagent general keeps coding baseline (no workbench persona)");
  assert(!cfg.agent.explore || !cfg.agent.explore.prompt, "subagent explore keeps coding baseline (no workbench persona)");
}

// --- agentPrompt makes Lily's guide the AUTHORITATIVE agent prompt -----------
{
  const r = buildOpencodeConfig({
    lilyEnv: { LILY_API_BASE_URL: "https://api.deepseek.com", LILY_API_KEY: "sk", LILY_MODEL: "deepseek-chat" },
    agentPrompt: "You are 莉莉, a general assistant. (Lily's real AGENT.md content goes here.)",
    instructionsPaths: ["/should/be/ignored/AGENT.md"],
  });
  const cfg = JSON.parse(r.configContent);
  assert(cfg.agent.build.prompt.includes("莉莉") && cfg.agent.plan.prompt.includes("莉莉"), "agentPrompt -> build + plan agent prompts (prepended, authoritative)");
  assert(!cfg.instructions, "instructions NOT also set when agentPrompt given (no dup of the 100KB guide)");
}

// --- a broken model config propagates the failure (no half config) ----------
{
  const r = buildOpencodeConfig({ lilyEnv: { LILY_API_BASE_URL: "https://x" } }); // no model
  assert(r.ok === false && /LILY_MODEL/.test(r.reason), "missing model -> ok:false with reason");
}

console.log("opencode-config-builder: ok");
