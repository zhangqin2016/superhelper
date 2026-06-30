"use strict";

const { OpencodeAgentSession } = require("./opencode-agent-session");
const { resolveOpencodeCommand } = require("./agent-command");
const { getActivePermissionMode } = require("./permission-settings");
const { getLogger } = require("./logger");

const log = getLogger("runner-pool");

class SessionRunnerPool {
  constructor() {
    /** @type {Map<string, OpencodeAgentSession>} */
    this._sessions = new Map();
  }

  has(sessionId) {
    return this._sessions.has(sessionId);
  }

  getSessionIds() {
    return [...this._sessions.keys()];
  }

  /**
   * Get-or-create the runner for a session. The app runs the OpenCode engine:
   * this translates Lily's distributed model config into an OpenCode provider
   * override and runs OpencodeAgentSession.
   * @param {string} sessionId
   * @param {string} cwd
   * @param {{ stagingDir?: string, disallowedTools?: string[], resumeSessionId?: string | null, configDir?: string, permissionMode?: string }} [extra]
   */
  ensure(sessionId, cwd, extra = {}, callOpts = {}) {
    const agentCommand = resolveOpencodeCommand();
    if (!agentCommand) {
      throw new Error("OPENCODE_NOT_READY");
    }

    let runner = this._sessions.get(sessionId);
    if (!runner) {
      runner = new OpencodeAgentSession(sessionId);
      this._sessions.set(sessionId, runner);
    }

    const { resolveLilyEnv, buildAgentSpawnEnv } = require("./spawn-env");
    const { buildSharedBaseConfig } = require("./runtime/opencode-config-builder");
    const permissionMode = extra.permissionMode || getActivePermissionMode();
    // The SHARED serve's base config — app-wide only for model/provider +
    // plugins, with Lily extension MCPs scoped to this session's active skills.
    // Other per-session bits are delivered per-request:
    //   - permission MODE  -> enforced host-side (opencode-permission-policy)
    //   - skill guidance   -> injected as hidden context on every prompt
    //     (see `guidance` below)
    // This is what lets ONE serve host every session/directory without config
    // bleed (a single global OPENCODE_CONFIG can only hold one session's config).
    const cfg = buildSharedBaseConfig({
      lilyEnv: resolveLilyEnv(),
      mcpServers: this._opencodeMcpServers(extra.activeSkillIds || []),
      pluginPaths: this._opencodePlugins(),
      skillPaths: this._opencodeSkillPaths(),
      disallowedTools: extra.disallowedTools || [],
      // Static Lily identity header as the primary-agent prompt: suppresses
      // OpenCode's coding-CLI baseline (default.txt) that otherwise mis-frames
      // every turn as a terse software-engineering task. The full per-turn guide
      // still rides body.system (see `guidance` below).
      basePrompt: this._opencodeBasePersona(),
    });
    if (!cfg.ok) {
      // Surface, don't hide: the turn may still run against OpenCode's own
      // config/auth, but the distributed model/MCP won't apply.
      log.warn("opencode config not applied: %s", cfg.reason);
    }
    // Lily's AGENT.md (identity + rules + ENABLED skills) — the authoritative
    // guidance. It rides every prompt as hidden engine context so resumed or
    // migrated OpenCode sessions cannot drift away from current platform rules.
    const guidance = this._opencodeGuideContent(extra.configDir, sessionId);
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

    // OpenCode installs node-based language servers (pyright/tsserver) on demand
    // via an embedded arborist, which honors `npm_config_registry`. Default that
    // to a China-reachable mirror so the code-intelligence loop's first-edit
    // download actually succeeds for our users instead of dead-ending on a slow/
    // blocked registry.npmjs.org (then silently producing no diagnostics).
    // Scoped to the engine env only; respects a registry the user already set,
    // overridable via LILY_NPM_REGISTRY, and disablable with LILY_NPM_REGISTRY=off.
    const npmRegistry = process.env.LILY_NPM_REGISTRY || "https://registry.npmmirror.com";
    if (
      npmRegistry !== "off" &&
      !env.npm_config_registry &&
      !process.env.npm_config_registry &&
      !process.env.NPM_CONFIG_REGISTRY
    ) {
      env.npm_config_registry = npmRegistry;
    }

    // Where the compaction-memory plugin (Bun serve) reads Lily's per-session
    // navigation memory from. Must match where opencode-agent-session writes it.
    try {
      const { userDataPath } = require("./config");
      const { COMPACTION_MEMORY_DIRNAME } = require("./compaction-memory-export");
      env.LILY_COMPACTION_MEMORY_DIR = userDataPath(COMPACTION_MEMORY_DIRNAME);
    } catch {
      /* non-fatal: plugin then finds no dir and leaves compaction untouched */
    }

    runner.ensureProcess(cwd, {
      agentCommand,
      permissionMode,
      model: cfg.model,
      env,
      opencodeConfig: cfg.ok ? cfg.configContent : "",
      guidance,
      configDir: extra.configDir,
      // Seed the OpenCode session id from the persisted conversation so a fresh
      // runner (app restart / cold session) RESUMES the same server-side session
      // instead of starting blank — otherwise reopened conversations lose context.
      resumeSessionId: extra.resumeSessionId || null,
    }, { lazy: Boolean(callOpts.lazy) });

    return runner;
  }

  /** The small, static Lily identity header used as the OpenCode primary-agent
   *  prompt. Sourced from Lily's OWN i18n strings (no invented persona). "" on
   *  any failure — then OpenCode falls back to its coding baseline (degraded but
   *  functional), so this never blocks a session from starting. */
  _opencodeBasePersona() {
    try {
      return require("./skill-manager").buildAgentBasePersona() || "";
    } catch (err) {
      log.warn("opencode base persona unavailable: %s", err?.message || String(err));
      return "";
    }
  }

  /** Lily's active MCP servers (mail/playwright/web) as a {name:{command,args,env}}
   *  map, for translation into OpenCode's mcp config. Empty on any failure. */
  _opencodeMcpServers(activeSkillIds = null) {
    try {
      const fs = require("node:fs");
      const { bundleRuntimeDir } = require("./bundle-locator");
      const { writeActiveMcpConfig } = require("./mcp-config");
      const out = require("./config").userDataPath("opencode-mcp.json");
      const written = writeActiveMcpConfig(bundleRuntimeDir(), out, activeSkillIds);
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
      return ["verify-edit.js", "compaction-memory.js", "loop-detector.js"].map(resolve).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Lily-installed skills directory for the engine's native `skill` registry.
   *  AGENT.md tells the model which skills are enabled; this path makes those
   *  same skills discoverable to the runtime tool instead of text-only guidance. */
  _opencodeSkillPaths() {
    try {
      const path = require("node:path");
      const { agentConfigDir } = require("./config");
      return [path.join(agentConfigDir(), "skills")];
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
      const { appendLargeInputProtocolGuidance } = require("./large-input-protocol");
      const { appendProcessJobProtocolGuidance } = require("./process-job-protocol");
      let dir = configDir;
      if (!dir) dir = require("./config").sessionGuideDir(sessionId);
      const guide = path.join(dir, "AGENT.md");
      const base = fs.existsSync(guide) ? fs.readFileSync(guide, "utf8") : "";
      return appendProcessJobProtocolGuidance(appendLargeInputProtocolGuidance(base));
    } catch {
      return "";
    }
  }

  get(sessionId) {
    return this._sessions.get(sessionId) || null;
  }

  diagnostics(sessionId) {
    const runner = this._sessions.get(sessionId);
    return runner?.diagnostics?.() || null;
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
      runner.setPermissionMode(modeId);
      // OpenCode can't hot-swap the permission ruleset. Restart IDLE runners now so
      // the new mode applies immediately; leave a busy runner alone — its current
      // turn finishes uninterrupted and the next send rebuilds the config with the
      // new mode (ensureProcess/_ensureStarted restarts on the config change).
      if (runner.isAlive() && !runner.isBusy()) {
        runner.terminate();
        restarted.push(sessionId);
      }
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
    // Runners now only DETACH from the shared serve; the serve outlives any one
    // session, so the actual process must be killed here (app-quit teardown).
    try {
      require("./runtime/opencode-shared-server").resetSharedServer();
    } catch {
      /* best effort — OS reaps the child on exit anyway */
    }
  }
}

module.exports = { SessionRunnerPool };
