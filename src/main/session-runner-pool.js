"use strict";

const { AgentSession } = require("./agent-session");
const { OpencodeAgentSession } = require("./opencode-agent-session");
const { resolveAgentCommand, resolveOpencodeCommand } = require("./agent-command");
const { getActivePermissionMode } = require("./permission-settings");
const { getLogger } = require("./logger");

const log = getLogger("runner-pool");

/** Which engine to run: persisted user choice (engine-settings), overridable by
 *  the LILY_ENGINE env var. Defaults to the Claude CLI. */
function selectedEngine() {
  return require("./engine-settings").getEngine();
}

class SessionRunnerPool {
  constructor() {
    /** @type {Map<string, AgentSession>} */
    this._sessions = new Map();
  }

  has(sessionId) {
    return this._sessions.has(sessionId);
  }

  getSessionIds() {
    return [...this._sessions.keys()];
  }

  /**
   * @param {string} sessionId
   * @param {string} cwd
   * @param {{ stagingDir?: string, disallowedTools?: string[], resumeSessionId?: string | null, configDir?: string, permissionMode?: string }} [extra]
   */
  ensure(sessionId, cwd, extra = {}, callOpts = {}) {
    if (selectedEngine() === "opencode") {
      return this._ensureOpencode(sessionId, cwd, extra, callOpts);
    }

    const agentCommand = resolveAgentCommand();
    if (!agentCommand) {
      throw new Error("AGENT_NOT_READY");
    }

    let runner = this._sessions.get(sessionId);
    if (!runner) {
      runner = new AgentSession(sessionId);
      this._sessions.set(sessionId, runner);
    }

    runner.ensureProcess(cwd, {
      agentCommand,
      permissionMode: extra.permissionMode || getActivePermissionMode(),
      disallowedTools: extra.disallowedTools || [],
      stagingDir: extra.stagingDir,
      resumeSessionId: extra.resumeSessionId || null,
      configDir: extra.configDir,
    }, { lazy: Boolean(callOpts.lazy) });

    return runner;
  }

  /** OpenCode-engine variant of ensure(); translates Lily's distributed model
   *  config into an OpenCode provider override and runs OpencodeAgentSession. */
  _ensureOpencode(sessionId, cwd, extra = {}, callOpts = {}) {
    const agentCommand = resolveOpencodeCommand();
    if (!agentCommand) {
      throw new Error("OPENCODE_NOT_READY");
    }

    let runner = this._sessions.get(sessionId);
    if (runner && !(runner instanceof OpencodeAgentSession)) {
      runner.terminate();
      this._sessions.delete(sessionId);
      runner = null;
    }
    if (!runner) {
      runner = new OpencodeAgentSession(sessionId);
      this._sessions.set(sessionId, runner);
    }

    const { resolveLilyEnv, buildAgentSpawnEnv } = require("./spawn-env");
    const { buildOpencodeConfig } = require("./runtime/opencode-config-builder");
    const permissionMode = extra.permissionMode || getActivePermissionMode();
    // Assemble the full OpenCode config: distributed model + MCP servers
    // (mail/playwright/web) + permission policy + system-prompt/skill guidance.
    const cfg = buildOpencodeConfig({
      lilyEnv: resolveLilyEnv(),
      mcpServers: this._opencodeMcpServers(),
      permissionMode,
      disallowedTools: extra.disallowedTools || [],
      // Lily's AGENT.md (identity + rules + skills) as the AUTHORITATIVE agent
      // prompt — without this OpenCode's coding-CLI persona dominates and the
      // model treats every request as a codebase task.
      agentPrompt: this._opencodeGuideContent(extra.configDir, sessionId),
      pluginPaths: this._opencodePlugins(),
    });
    if (!cfg.ok) {
      // Surface, don't hide: the turn may still run against OpenCode's own
      // config/auth, but the distributed model/MCP/instructions won't apply.
      log.warn("opencode config not applied: %s", cfg.reason);
    }
    // Reuse Lily's full engine env so skill SCRIPTS run identically under OpenCode
    // (DASHSCOPE_*/VISION_*/ALIYUN_BAILIAN_* for media skills, the curated PATH
    // with bundled node/python, connector-bridge for mail). OpenCode ignores the
    // Claude-specific ANTHROPIC_*/CLAUDE_* vars; our model is the "lily" provider.
    let env;
    try {
      env = buildAgentSpawnEnv({ configDir: extra.configDir });
    } catch {
      env = {};
    }

    runner.ensureProcess(cwd, {
      agentCommand,
      permissionMode,
      model: cfg.model,
      env,
      opencodeConfig: cfg.ok ? cfg.configContent : "",
      configDir: extra.configDir,
    }, { lazy: Boolean(callOpts.lazy) });

    return runner;
  }

  /** Lily's active MCP servers (mail/playwright/web) as a {name:{command,args,env}}
   *  map, for translation into OpenCode's mcp config. Empty on any failure. */
  _opencodeMcpServers() {
    try {
      const fs = require("node:fs");
      const { bundleRuntimeDir } = require("./bundle-locator");
      const { writeActiveMcpConfig } = require("./mcp-config");
      const out = require("./config").userDataPath("opencode-mcp.json");
      const written = writeActiveMcpConfig(bundleRuntimeDir(), out);
      if (!written) return {};
      return JSON.parse(fs.readFileSync(out, "utf8")).mcpServers || {};
    } catch (err) {
      log.warn("opencode mcp assembly failed: %s", err?.message || String(err));
      return {};
    }
  }

  /** Local OpenCode plugins to load (the post-edit verification hook), as
   *  absolute paths. Looks in packaged resources first, then the repo. */
  _opencodePlugins() {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const { PROJECT_ROOT } = require("./config");
      const resolve = (name) => {
        const rel = path.join("resources", "opencode-plugins", name);
        const candidates = [];
        if (typeof process.resourcesPath === "string") candidates.push(path.join(process.resourcesPath, rel));
        candidates.push(path.join(PROJECT_ROOT, rel));
        return candidates.find((p) => fs.existsSync(p)) || null;
      };
      return ["verify-edit.js"].map(resolve).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** The session's AGENT.md CONTENT (Lily global instructions + ALL enabled skill
   *  guidance) — used as the authoritative OpenCode agent prompt. Prefers the
   *  configDir the caller resolved via writeSessionAgentGuide. "" if unavailable. */
  _opencodeGuideContent(configDir, sessionId) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      let dir = configDir;
      if (!dir) dir = require("./config").sessionGuideDir(sessionId);
      const guide = path.join(dir, "AGENT.md");
      return fs.existsSync(guide) ? fs.readFileSync(guide, "utf8") : "";
    } catch {
      return "";
    }
  }

  get(sessionId) {
    return this._sessions.get(sessionId) || null;
  }

  sendMessage(sessionId, payload) {
    const runner = this._sessions.get(sessionId);
    if (!runner) throw new Error("NO_RUNNER");
    return runner.sendUserMessage(payload);
  }

  interrupt(sessionId) {
    this._sessions.get(sessionId)?.interrupt();
  }

  /**
   * @param {string} modeId
   * @returns {{ ok: boolean, restarted: string[] }}
   */
  applyPermissionMode(modeId, filter = null) {
    /** @type {string[]} */
    const restarted = [];
    for (const sessionId of this.getSessionIds()) {
      if (filter && !filter(sessionId)) continue;
      const runner = this._sessions.get(sessionId);
      if (!runner) continue;
      if (runner.isAlive() && runner.setPermissionMode(modeId)) continue;
      if (runner.isAlive()) {
        runner.terminate();
      }
      restarted.push(sessionId);
    }
    return { ok: true, restarted };
  }

  /**
   * @param {Record<string, string>} envPatch
   */
  applyLiveEnvironment(envPatch) {
    return require("./runner-live-config").applyLiveEnvToPool(this, envPatch);
  }

  terminateIdleAll() {
    require("./runner-live-config").terminateIdleRunners(this);
  }

  terminateSession(sessionId) {
    const runner = this._sessions.get(sessionId);
    if (!runner) return;
    runner.terminate();
    this._sessions.delete(sessionId);
  }

  terminateAll() {
    for (const sessionId of [...this._sessions.keys()]) {
      this.terminateSession(sessionId);
    }
  }
}

module.exports = { SessionRunnerPool };
