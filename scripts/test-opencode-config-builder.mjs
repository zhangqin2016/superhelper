#!/usr/bin/env node
/**
 * Full OPENCODE_CONFIG_CONTENT assembly: model + MCP + permission + instructions.
 * These translations are what carry Lily's MCP tools, permission policy, and
 * system-prompt/skill guidance into the OpenCode engine, so the shapes must
 * match OpenCode's V1 config exactly.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildOpencodeConfig, translateMcpServers, translatePermission } = require("../src/main/runtime/opencode-config-builder.js");

function assert(cond, msg) { if (!cond) throw new Error(msg); }

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
  assert(translatePermission("bypassPermissions").bash === "allow", "bypass -> allow");
  assert(translatePermission("acceptEdits").edit === "allow", "acceptEdits -> edit allow");
  assert(translatePermission("plan").edit === "deny", "plan -> edit deny");
  assert(translatePermission("default").bash === "ask", "default -> bash ask");
  // disallowedTools force deny, with Claude->OpenCode name mapping.
  const p = translatePermission("default", ["WebSearch", "WebFetch"]);
  assert(p.websearch === "deny" && p.webfetch === "deny", "disallowedTools -> deny (mapped names)");
}

// --- model tiers -> small_model + subagent agent models ---------------------
{
  const r = buildOpencodeConfig({
    lilyEnv: {
      LILY_API_BASE_URL: "https://api.deepseek.com", LILY_API_KEY: "sk",
      LILY_MODEL: "deepseek-chat", LILY_MODEL_HAIKU: "deepseek-lite", LILY_SUBAGENT_MODEL: "deepseek-lite",
    },
  });
  const cfg = JSON.parse(r.configContent);
  assert(cfg.small_model === "lily/deepseek-lite", "haiku tier -> small_model");
  assert(cfg.agent.general.model === "lily/deepseek-lite" && cfg.agent.explore.model === "lily/deepseek-lite", "subagent tier -> subagent agents");
}

// --- full config assembly ---------------------------------------------------
{
  const r = buildOpencodeConfig({
    lilyEnv: { LILY_API_BASE_URL: "https://api.deepseek.com", LILY_API_KEY: "sk", LILY_MODEL: "deepseek-chat" },
    mcpServers: { mail: { command: "/node", args: ["/mail.js"], env: {} } },
    permissionMode: "default",
    disallowedTools: ["WebSearch"],
    instructionsPaths: ["/data/session-guides/s1/AGENT.md", ""],
    pluginPaths: ["/app/resources/opencode-plugins/verify-edit.js", ""],
  });
  assert(r.ok, "config builds ok");
  const cfg = JSON.parse(r.configContent);
  assert(cfg.plugin.length === 1 && cfg.plugin[0].endsWith("verify-edit.js"), "plugin (verification hook) merged, blanks dropped");
  assert(cfg.provider.lily.options.baseURL === "https://api.deepseek.com", "provider carried");
  assert(cfg.model === "lily/deepseek-chat", "default model carried");
  assert(cfg.mcp.mail.type === "local", "mcp merged in");
  assert(cfg.permission.bash === "ask" && cfg.permission.websearch === "deny", "permission merged in");
  assert(cfg.instructions.length === 1 && cfg.instructions[0].endsWith("AGENT.md"), "fallback: instructions paths used when no agentPrompt");
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
