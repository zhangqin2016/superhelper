"use strict";

const crypto = require("node:crypto");
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
   * @param {{ lazy?: boolean, requireFreshConfig?: boolean }} [callOpts]
   */
  ensure(sessionId, cwd, extra = {}, callOpts = {}) {
    const agentCommand = resolveOpencodeCommand();
    if (!agentCommand) {
      throw new Error("OPENCODE_NOT_READY");
    }

    let runner = this._sessions.get(sessionId);
    const basePrompt = this._opencodeBasePersona();
    if (!String(basePrompt || "").trim()) {
      if (this._hasLastKnownGoodRunner(runner) && !callOpts.requireFreshConfig) {
        log.warn("opencode base persona unavailable; keeping last-known-good runner for session %s", sessionId);
        return this._reuseLastKnownGoodRunner(runner, cwd, callOpts);
      }
      throw new Error("LILY_BASE_PERSONA_UNAVAILABLE");
    }

    const { resolveLilyEnv, buildAgentSpawnEnv } = require("./spawn-env");
    const { buildSharedBaseConfig } = require("./runtime/opencode-config-builder");
    const permissionMode = extra.permissionMode || getActivePermissionMode();
    const lilyEnv = resolveLilyEnv();
    // Capability grading (能力分档): only a probed "lite" grade changes anything —
    // standard/full/absent run today's exact config (capability-gate Rule 13).
    // Kill switch: LILY_ENABLE_CAPABILITY_GRADING=0 pins every model to standard.
    const capabilityGrade = process.env.LILY_ENABLE_CAPABILITY_GRADING === "0"
      ? ""
      : String(lilyEnv.LILY_MODEL_CAPABILITY_GRADE || "");
    const liteGrade = capabilityGrade === "lite";
    // The SHARED serve's base config — app-wide only for model/provider +
    // plugins, with Lily extension MCPs scoped to this session's active skills.
    // Other per-session bits are delivered per-request:
    //   - permission MODE  -> enforced host-side (opencode-permission-policy)
    //   - skill guidance   -> injected as hidden context on every prompt
    //     (see `guidance` below)
    // This is what lets ONE serve host every session/directory without config
    // bleed (a single global OPENCODE_CONFIG can only hold one session's config).
    const cfg = buildSharedBaseConfig({
      lilyEnv,
      mcpServers: this._opencodeMcpServers(extra.activeSkillIds || [], {
        toolCompat: lilyEnv.LILY_OPENCODE_TOOL_COMPAT === "1",
        capabilityGrade,
      }),
      pluginPaths: this._opencodePlugins(),
      skillPaths: this._opencodeSkillPaths(extra.activeSkillIds || [], sessionId),
      // lite: no subagents — a weak model cannot drive nested agent loops, and
      // a dead subagent turn reads worse than doing the work inline.
      disallowedTools: liteGrade
        ? [...new Set([...(extra.disallowedTools || []), "task"])]
        : extra.disallowedTools || [],
      // Static Lily identity header as the primary-agent prompt: suppresses
      // OpenCode's coding-CLI baseline (default.txt) that otherwise mis-frames
      // every turn as a terse software-engineering task. The full per-turn guide
      // still rides body.system (see `guidance` below).
      basePrompt,
      subagentPrompt: this._opencodeSubagentPersona(),
    });
    if (!cfg.ok) {
      const reason = String(cfg.reason || "UNKNOWN").trim() || "UNKNOWN";
      if (this._hasLastKnownGoodRunner(runner) && !callOpts.requireFreshConfig) {
        log.warn(
          "opencode config invalid (%s); keeping last-known-good runner for session %s",
          reason,
          sessionId,
        );
        return this._reuseLastKnownGoodRunner(runner, cwd, callOpts);
      }
      throw new Error(`OPENCODE_CONFIG_INVALID:${reason}`);
    }

    if (!runner) {
      runner = new OpencodeAgentSession(sessionId);
      this._sessions.set(sessionId, runner);
    }
    const modelConfigFingerprint = this._modelConfigFingerprint(cfg.configContent);
    const modelConfigDiagnostics = this._modelConfigDiagnostics(cfg.configContent);
    const modelRouteAudit = cfg.diagnostics?.modelRoute || null;
    if (modelRouteAudit) {
      log.info(
        `model route audit: route=${modelRouteAudit.route || "-"} provider=${modelRouteAudit.provider || "-"} base=${modelRouteAudit.baseUrl || "-"} key=${modelRouteAudit.keyKind || "-"} fp=${modelConfigFingerprint || "-"}`,
      );
    }
    if (modelConfigDiagnostics) {
      log.info(
        "opencode model config audit: fp=%s model=%s provider=%s providerOptions=%s modelOptions=%s",
        modelConfigFingerprint || "-",
        modelConfigDiagnostics.model || "-",
        modelConfigDiagnostics.provider || "-",
        modelConfigDiagnostics.providerOptions || "-",
        modelConfigDiagnostics.modelOptions || "-",
      );
    }
    // Lily's AGENT.md (identity + rules + ENABLED skills) — the authoritative
    // guidance. It rides every prompt as hidden engine context so resumed or
    // migrated OpenCode sessions cannot drift away from current platform rules.
    // Probed model recipes (e.g. "this model only volunteers tool calls when
    // shown an example") append their calibrated hints here.
    const guidance = this._appendModelRecipeHints(
      this._opencodeGuideContent(extra.configDir, sessionId),
      capabilityGrade === String(lilyEnv.LILY_MODEL_CAPABILITY_GRADE || "")
        ? lilyEnv
        : { ...lilyEnv, LILY_MODEL_CAPABILITY_GRADE: capabilityGrade },
    );
    // Reuse Lily's full engine env so skill SCRIPTS run identically under OpenCode
    // (DASHSCOPE_*/VISION_*/ALIYUN_BAILIAN_* for media skills, the curated PATH
    // with bundled node/python, connector-bridge for mail). OpenCode ignores the
    // Claude-specific ANTHROPIC_*/CLAUDE_* vars; our model is the "lily" provider.
    let env;
    try {
      env = buildAgentSpawnEnv({ configDir: extra.configDir, lilyEnv });
    } catch {
      env = {};
    }

    // lite grade: tighter system-guide budget through the EXISTING truncation
    // mechanism — min(probed limit, 8000). A weak model drowns in a 30k-char
    // guide; the probed limit still wins when the gateway allows even less.
    if (liteGrade) {
      const probedMax = Number(lilyEnv.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS);
      const liteMax = Number.isFinite(probedMax) && probedMax > 0 ? Math.min(probedMax, 8000) : 8000;
      env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS = String(liteMax);
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

    // Model-aware budget for the context-window-guard plugin: derive it from the
    // ACTIVE model's real context window (server-delivered LILY_CONTEXT_WINDOW_TOKENS)
    // minus the output reserve, so the guard caps history to what THIS model can
    // actually hold — deepseek's ~1M and a 128k custom model each get the right
    // ceiling instead of one hardcoded guess (never over-trims a big model, never
    // overflows a small one). resolveContextBudget falls back to a safe default
    // window when unknown; fail-open leaves the plugin's own conservative default.
    try {
      const { resolveContextBudget } = require("./context-budget-manager");
      const windowTokens = Number(lilyEnv.LILY_CONTEXT_WINDOW_TOKENS) || undefined;
      const budget = resolveContextBudget({ contextWindowTokens: windowTokens });
      // The guard only trims TRUNCATABLE content (tool io + text); the system
      // prompt and tool schemas also consume the window but can't be trimmed
      // there. Reserve a proportional 15% headroom for that non-trimmable
      // overhead so bounding the trimmable slots to this budget keeps the TOTAL
      // request under the window. Proportional (not a fixed subtraction) so it
      // scales safely from a 32k model to a 1M one.
      const guardBudget = Math.floor(budget.usableInputTokens * 0.85);
      if (!env.LILY_CONTEXT_TOKEN_BUDGET && guardBudget > 0) {
        env.LILY_CONTEXT_TOKEN_BUDGET = String(guardBudget);
      }
    } catch {
      /* guard keeps its own conservative default */
    }

    runner.ensureProcess(cwd, {
      agentCommand,
      permissionMode,
      model: cfg.model,
      modelRouteAudit,
      modelConfigFingerprint,
      env,
      opencodeConfig: cfg.configContent,
      guidance,
      configDir: extra.configDir,
      refreshManagedModelConfig: async () => {
        const refreshed = await require("./ipc-utils").refreshRemoteConfigForSend({
          force: true,
          timeoutMs: 45_000,
          repairManagedService: true,
          reason: "gateway_token_invalid",
        });
        if (!refreshed?.ok) return refreshed;
        try {
          this.ensure(sessionId, cwd, extra, { lazy: true, requireFreshConfig: true });
          return { ok: true };
        } catch (err) {
          const error = err?.message || String(err) || "OPENCODE_CONFIG_REFRESH_FAILED";
          log.warn("managed model config refresh could not apply fresh config: %s", error);
          return { ok: false, error };
        }
      },
      // Seed the OpenCode session id from the persisted conversation so a fresh
      // runner (app restart / cold session) RESUMES the same server-side session
      // instead of starting blank — otherwise reopened conversations lose context.
      resumeSessionId: extra.resumeSessionId || null,
    }, { lazy: Boolean(callOpts.lazy) });

    return runner;
  }

  _hasLastKnownGoodRunner(runner) {
    const options = runner?.spawnOptions;
    return Boolean(
      options &&
      String(options.agentCommand || "").trim() &&
      String(options.opencodeConfig || "").trim() &&
      String(options.modelConfigFingerprint || "").trim()
    );
  }

  _reuseLastKnownGoodRunner(runner, cwd, callOpts = {}) {
    // Lazy warm-up may keep a cached runner dormant. A real/non-lazy send must
    // still restart it from the exact proven options when the fresh persona or
    // config source is temporarily unavailable; merely returning a dead object
    // makes the fallback look healthy while the turn cannot start.
    if (!callOpts.lazy) {
      runner.ensureProcess(cwd, runner.spawnOptions, { lazy: false });
    }
    return runner;
  }

  _modelConfigFingerprint(configContent = "") {
    const subset = this._modelConfigSubset(configContent);
    if (!subset) return "";
    return crypto.createHash("sha256").update(JSON.stringify(subset)).digest("hex").slice(0, 16);
  }

  _modelConfigSubset(configContent = "") {
    try {
      const parsed = JSON.parse(String(configContent || "{}"));
      const agentModels = {};
      for (const [name, agent] of Object.entries(parsed.agent || {})) {
        if (agent && typeof agent === "object" && agent.model) agentModels[name] = agent.model;
      }
      return {
        model: parsed.model || "",
        small_model: parsed.small_model || "",
        provider: parsed.provider || {},
        agentModels,
      };
    } catch {
      return null;
    }
  }

  _modelConfigDiagnostics(configContent = "") {
    const subset = this._modelConfigSubset(configContent);
    if (!subset) return null;
    const modelRef = String(subset.model || "");
    const slash = modelRef.indexOf("/");
    const provider = slash >= 0 ? modelRef.slice(0, slash) : "";
    const model = slash >= 0 ? modelRef.slice(slash + 1) : modelRef;
    const providerCfg = provider ? subset.provider?.[provider] || null : null;
    const modelCfg = providerCfg?.models?.[model] || null;
    const providerOptions = Object.keys(providerCfg?.options || {})
      .filter((key) => !/key|token|authorization/i.test(key))
      .sort();
    const modelOptions = Object.keys(modelCfg?.options || {}).sort();
    return {
      model: subset.model || "",
      provider,
      providerOptions: providerOptions.length ? providerOptions.join(",") : "-",
      modelOptions: modelOptions.length ? modelOptions.join(",") : "-",
    };
  }

  /** The small, static Lily identity header used as the OpenCode primary-agent
   *  prompt. Sourced from Lily's OWN i18n strings (no invented persona). "" on
   *  any failure; cold or requireFreshConfig ensure() rejects that result so
   *  OpenCode's coding baseline cannot answer in place of Lily, while a normal
   *  ensure keeps a proven runner's last-known-good persona/config unchanged. */
  _opencodeBasePersona() {
    try {
      return require("./skill-manager").buildAgentBasePersona() || "";
    } catch (err) {
      log.warn("opencode base persona unavailable: %s", err?.message || String(err));
      return "";
    }
  }

  _opencodeSubagentPersona() {
    try {
      const persona = require("./skill-manager").buildAgentSubagentPersona() || "";
      return this._appendSubagentProtocolHints(persona);
    } catch (err) {
      log.warn("opencode subagent persona unavailable: %s", err?.message || String(err));
      return "";
    }
  }

  /** Compact tool-protocol appendix for SUBAGENTS. The full AGENT.md guidance
   *  only rides the PARENT prompt's body.system, so a subagent used to get the
   *  whole lily_* MCP toolset mounted with zero rules on how to use it — the
   *  classic failure being a child blindly reading a huge file into context.
   *  Deliberately tiny (a distilled fraction of the parent protocols) so weak
   *  gateways with small system budgets are never at risk. Kill switch:
   *  LILY_SUBAGENT_PROTOCOL_HINTS=0. */
  _appendSubagentProtocolHints(persona) {
    if (process.env.LILY_SUBAGENT_PROTOCOL_HINTS === "0") return persona;
    const base = String(persona || "").trim();
    if (!base) return persona;
    const hints = [
      "## Tool Protocol (compact)",
      "",
      "- Large/unknown files: never read whole files blindly. Use lily_file_intelligence inspect_file first, then sample/extract/query by goal. State your coverage; never claim full coverage from samples.",
      "- Long-running processes (servers, watchers, background commands): use lily_process_jobs (job_start with cwd + healthcheck, verify via job_status/job_logs). Short foreground commands stay on normal tools.",
      "- If a lily_* tool is unavailable or fails, fall back to normal tools and say so — do not block or fabricate results.",
    ].join("\n");
    return `${base}\n\n${hints}`;
  }

  /** Probed model recipes/grade → calibrated guide hints. `toolCallHint` means the
   *  probe demonstrated this model only volunteers tool calls when the system
   *  text carries an explicit native-call example — so the guide always ships
   *  one. Titled "## Tool Protocol …" so the budget truncation's guardrail
   *  rule keeps it alive on tight system budgets. Confirmed lite receives its
   *  independent execution protocol; bad/missing recipes leave every non-lite
   *  guide untouched. */
  _appendModelRecipeHints(guidance, lilyEnv = {}) {
    const liteGrade = String(lilyEnv.LILY_MODEL_CAPABILITY_GRADE || "") === "lite";
    let recipes = {};
    try {
      recipes = JSON.parse(lilyEnv.LILY_MODEL_RECIPES || "{}") || {};
    } catch {
      // The confirmed grade is independent evidence from the optional recipe
      // payload. A corrupt recipe must not suppress lite's execution support;
      // non-lite models still fail open to today's untouched guide.
      if (!liteGrade) return guidance;
    }
    try {
      const lines = [];
      if (recipes.toolCallHint === true) {
        lines.push(
          "- To use a tool, you MUST invoke it as a NATIVE structured function call through the tool-calling interface. Never describe or write the call as text, XML, or JSON inside your reply.",
          "- Example: to read a file, CALL the tool named read with arguments {\"filePath\": \"/absolute/path\"} via a function call — not by writing it out.",
          "- Make one tool call at a time and wait for its result before the next step.",
        );
      }
      // Probed output ceiling: only LOW-ceiling models get a concrete chunking
      // threshold (strong models with ample ceilings carry no recipe and pay
      // nothing — the chunked-write rule stays reactive for them).
      const ceiling = Number(recipes.outputTokenCeiling);
      if (Number.isFinite(ceiling) && ceiling > 0 && ceiling <= 8192) {
        const approxLines = Math.max(60, Math.floor(ceiling / 15));
        lines.push(
          `- Your single-response output ceiling is about ${ceiling} tokens (~${approxLines} lines of code/text). Any file longer than that MUST be written in chunks: write the skeleton or first section, then APPEND the rest with edit calls — never attempt it in one write.`,
        );
      }
      const base = String(guidance || "").trim();
      if (!base) return guidance;
      const appendices = [];
      if (lines.length && !base.includes("## Tool Protocol (model recipe)")) {
        appendices.push(["## Tool Protocol (model recipe)", "", ...lines].join("\n"));
      }
      if (liteGrade && !base.includes("## Execution Protocol (lite support)")) {
        appendices.push([
          "## Execution Protocol (lite support)",
          "",
          "- Work one verified step at a time. Call one tool, read its result, then choose the next step.",
          "- Use lily_tool_broker to discover platform capability before claiming a task is unavailable.",
          "- Keep going until the requested deliverable is verified; report a concrete blocker instead of stopping early.",
        ].join("\n"));
      }
      if (!appendices.length) return guidance;
      return `${base}\n\n${appendices.join("\n\n")}`;
    } catch {
      return guidance;
    }
  }

  /** Lily's active MCP servers (mail/playwright/web) as a {name:{command,args,env}}
   *  map, for translation into OpenCode's mcp config. Empty on any failure. */
  _opencodeMcpServers(activeSkillIds = null, { toolCompat = false, capabilityGrade = "" } = {}) {
    try {
      const fs = require("node:fs");
      const { bundleRuntimeDir } = require("./bundle-locator");
      const { writeActiveMcpConfig } = require("./mcp-config");
      const { getEffectiveRuntimePackDir } = require("./runtime-packs");
      const out = require("./config").userDataPath("opencode-mcp.json");
      // OpenCode owns one app-wide serve and one stdio MCP child. MCP calls do
      // not carry the originating Lily conversation, so embedding sessionId or
      // active skills here would both change serveSignature per conversation
      // and risk reusing the wrong session in another view. Keep this transport
      // explicitly platform-only. Callers with an actually isolated transport
      // can still pass real context directly to writeActiveMcpConfig.
      const sharedBrokerContext = { platformOnly: true, activeSkillIds: [] };
      const written = writeActiveMcpConfig(
        bundleRuntimeDir(),
        out,
        activeSkillIds,
        sharedBrokerContext,
        { webAutomationPackDir: getEffectiveRuntimePackDir("web-automation") },
      );
      if (!written) return {};
      let servers = JSON.parse(fs.readFileSync(out, "utf8")).mcpServers || {};
      // Capability grading is additive. Lite models receive tighter execution
      // guidance, but retain the same executable MCP surface as the strong
      // default. Dropping whole servers here made browser, mail, process-job,
      // and learned-system tasks impossible with no strong-model fallback.
      if (!toolCompat) return servers;
      // Tool-shape compat (the probe found this gateway rejects tool names
      // longer than ~35 chars): OpenCode names MCP tools `<serverKey>_<tool>`,
      // so shorter server keys keep every Lily tool name inside the limit.
      // Applied only when the active model's compatibility profile asks for it.
      const compatKeys = {
        lily_tool_broker: "lily_tb",
        lily_file_intelligence: "lily_fi",
        lily_process_jobs: "lily_pj",
      };
      const renamed = {};
      for (const [key, value] of Object.entries(servers)) {
        renamed[compatKeys[key] || key] = value;
      }
      return renamed;
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
      return ["verify-edit.js", "compaction-memory.js", "loop-detector.js", "subtask-guard.js", "large-output-guard.js", "filepart-text-coercion.js", "context-window-guard.js"].map(resolve).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Lily-owned skill isolation is enforced by the per-session AGENT.md and MCP
   *  broker scope. Do not mount the global installed-skill directory into
   *  OpenCode's native registry: the shared serve config is app-wide, so a global
   *  skill path lets inactive or other-workspace learned skills appear in an
   *  unrelated conversation. */
  _opencodeSkillPaths(_activeSkillIds = [], _sessionId = "") {
    return [];
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
