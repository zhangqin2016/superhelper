"use strict";

/**
 * OpenCode-engine session runner. Drop-in peer of AgentSession (agent-session.js)
 * for the OpenCode engine: same orchestrator integration contract —
 *   orchestrator.ingest(sessionId, drafts)         // streaming
 *   orchestrator.notifyRunnerDone(sessionId, p)    // turn finished
 *   orchestrator.notifyRunnerError(sessionId, msg) // turn failed
 *   bindOrchestrator(orchestrator)
 * and the same public methods turn-orchestrator / session-runner-pool call.
 *
 * Transport (HTTP/SSE + the serve process) is OpencodeServerManager. Raw
 * OpenCode events are reduced directly into Lily runtime drafts by
 * opencode-runtime-reducer; there is no Claude-style stream-json/action adapter
 * in this path.
 */
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { OpencodeServerManager } = require("./runtime/opencode-server-manager");
const {
  createOpencodeRuntimeState,
  reduceOpencodeRuntimeEvent,
  resetOpencodeRuntimeState,
} = require("./runtime/opencode-runtime-reducer");
const { decidePermission } = require("./runtime/opencode-permission-policy");
const { truncateToolResultForUi } = require("./cli-process-payload");
const { getLogger } = require("./logger");
const { isReplaySafeTool } = require("./tool-semantics");
const { createOpencodeSubagentRuntime } = require("./opencode-subagent-runtime");
const { createOpencodeTurnLiveness } = require("./opencode-turn-liveness");
const { createOpencodeHistoryRecovery } = require("./opencode-history-recovery");
const { grantOpencodeRuntimeIdentity, revokeOpencodeRuntimeIdentity } = require("./opencode-runtime-identity");
const {
  buildAttachmentFallbackPromptPayload,
  enrichPermissionFailureMessage,
  errorCauseFromEffect,
  isManagedGatewayAuthFailure,
  isManagedModelConfigStale,
  isRecoverableModelConnectionFailure,
  isSafeReplayableModelFailure,
  isVisibleFailureRecoverable,
  shouldDropResumeAfterVisibleFailure,
  shouldIsolateAttachmentFallback,
  shouldRebuildEngineForRetry,
  transientClassificationText,
} = require("./opencode-session-failure-policy");
const {
  TODO_COMPLETION_GATE_MAX_ATTEMPTS, buildTodoContinuationPrompt,
  detectIncompleteDeliverable, nativeTodoSnapshot,
  normalizeTodoStatus, todoTitle,
} = require("./opencode-todo-completion-policy");
const requiredToolCompletion = require("./required-tool-completion-gate");
const log = getLogger("opencode-agent-session");
function rawToolFromEvent(ev = {}) {
  const p = ev.properties || {};
  if (ev.type === "message.part.updated") {
    const part = p.part || {};
    if (part.type !== "tool") return null;
    const state = part.state || {};
    const id = String(part.callID || part.id || "");
    if (!id) return null;
    return {
      id,
      name: part.tool || "unknown",
      input: state.input && typeof state.input === "object" ? state.input : {},
      title: state.title || part.title || "",
      status: state.status || "",
    };
  }
  if (String(ev.type || "").startsWith("session.next.tool.")) {
    const id = String(p.callID || p.id || "");
    if (!id) return null;
    let status = "running";
    if (ev.type === "session.next.tool.success") status = "completed";
    else if (ev.type === "session.next.tool.failed") status = "error";
    return {
      id,
      name: p.tool || p.name || "unknown",
      input: p.input && typeof p.input === "object" ? p.input : {},
      title: p.title || p.metadata?.title || "",
      status,
    };
  }
  return null;
}

function isReplaySafeToolName(name) {
  return isReplaySafeTool(name);
}

function isTurnOwnedEngineEvent(ev) {
  const type = String(ev?.type || "");
  const props = ev?.properties || {};
  if (type.startsWith("message.")) return true;
  if (type.startsWith("permission.") || type.startsWith("question.")) return true;
  if (type.startsWith("session.")) {
    return Boolean(props.sessionID || props.sessionId || props.info?.id || props.session?.id);
  }
  return false;
}

class OpencodeAgentSession extends EventEmitter {
  static INTERRUPT_ABORT_TIMEOUT_MS = 5_000;

  /**
   * @param {string} sessionId App session id (not the OpenCode server session id).
   * @param {{ createServer?: (opts: object) => OpencodeServerManager }} [deps] Injectable for tests.
   */
  constructor(sessionId, deps = {}) {
    super();
    this.sessionId = sessionId;
    this._createServer = deps.createServer || ((opts) => new OpencodeServerManager(opts));
    this._refreshManagedModelConfig = typeof deps.refreshManagedModelConfig === "function"
      ? deps.refreshManagedModelConfig
      : null;
    /** @type {OpencodeServerManager | null} */
    this._server = null;
    this._eventState = createOpencodeRuntimeState();
    this.cwd = null;
    this.spawnOptions = null;
    this.agentResumeId = null;
    this.busy = false;
    this._abortSettling = false;
    this._turnSettled = true;
    this._starting = null;
    this._sawActivity = false;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe = new Map();
    this._activeTools = new Map();
    this.collectedOutput = "";
    /** Completion gate (Pillar 3-B) fires at most ONCE per turn — guards against loops. */
    this._gatedThisTurn = false;
    this._latestTodos = [];
    this._latestTodosSignature = "";
    this._todoCompletionGateAttempts = 0;
    requiredToolCompletion.reset(this);
    /** @type {Map<string, { rawRequestId: string, sessionID: string }>} pending permission request ids awaiting a host reply. */
    this._pendingPermissions = new Map();
    /** @type {Map<string, { questions: Array, rawRequestId: string, sessionID: string }>} pending question id -> its questions (for answer mapping). */
    this._pendingQuestions = new Map();
    this._subagentRuntime = createOpencodeSubagentRuntime({
      getServer: () => this._server,
      getPermissionContext: () => ({
        mode: this.spawnOptions?.permissionMode || "ask",
        cwd: this.cwd,
        taskContract: this._activeTaskContract,
      }),
      pendingPermissions: this._pendingPermissions,
      pendingQuestions: this._pendingQuestions,
      ingest: (drafts) => this._ingest(drafts),
      onProgress: () => {
        this._sawActivity = true;
        this._armResponseTimer();
        this._armProgressNoticeTimer();
        this._armIdleProbe();
      },
    });
    this._turnLiveness = createOpencodeTurnLiveness({
      sessionId: this.sessionId,
      activeTools: this._activeTools,
      getState: () => ({
        busy: this.busy,
        turnSettled: this._turnSettled,
        collectedOutput: this.collectedOutput,
      }),
      getConfig: () => ({
        responseTimeoutMs: OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS,
        activeToolLeaseMs: OpencodeAgentSession.ACTIVE_TOOL_LEASE_MS,
        progressNoticeMs: OpencodeAgentSession.PROGRESS_NOTICE_MS,
        turnWatchdogMs: OpencodeAgentSession.TURN_WATCHDOG_MS,
        healthProbeMs: OpencodeAgentSession.HEALTH_PROBE_MS,
        healthMaxFails: OpencodeAgentSession.HEALTH_MAX_FAILS,
      }),
      getServer: () => this._server,
      hasKnownSubagents: () => this._subagentRuntime.hasKnownSubagents(),
      ingest: (drafts) => this._ingest(drafts),
      recoverStalledFinal: () => this._recoverStalledFinalFromOfficialState(),
      completeTurn: (payload) => this._completeTurn(payload),
      onServerError: (err) => this._onServerError(err),
    });
    this._historyRecovery = createOpencodeHistoryRecovery({
      getServer: () => this._server,
      getTurnStartedAt: () => this._turnStartedAt,
      getPendingPromptPayload: () => this._pendingPromptPayload,
      getSessionStatus: () => this._getSessionStatus(),
      getSyncTimeoutMs: () => OpencodeAgentSession.STALLED_HISTORY_SYNC_MS,
      onSupplementalOutput: ({ official, missing }) => {
        this.collectedOutput = official;
        this._ingest([{ type: "assistant.delta", payload: { text: missing } }]);
      },
    });
    this._orchestrator = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._idleSettleTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._idleProbeTimer = null;
    this._pendingCompletePayload = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._dispatchFailureTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._promptAcceptanceTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._promptDispatchPendingTimer = null;
    this._pendingDispatchFailure = null;
    this._pendingPromptPayload = null;
    this._promptDispatchPending = false;
    this._turnAcceptedEmitted = false;
    this._activeTaskContract = null;
    this._dispatchRetryCount = 0;
    this._transientReplayCount = 0;
    this._engineSessionWasResumed = false;
    this._activeModelConfigFingerprint = this._activeToolConfigFingerprint = "";
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._transientFailureTimer = null;
    this._pendingTransientFailure = null;
    this._turnStartedAt = 0;
    this._abortSettling = false;
  }

  bindOrchestrator(orchestrator) {
    this._orchestrator = orchestrator;
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * @param {string} cwd
   * @param {{ agentCommand: string, permissionMode?: string, model?: {providerID:string, modelID:string}|null, modelRouteAudit?: object|null, modelConfigFingerprint?: string, agent?: string|null, configDir?: string, dataDir?: string }} options
   */
  ensureProcess(cwd, options, callOpts = {}) {
    if (!cwd || !options?.agentCommand) throw new Error("RUNNER_MISSING_ARGS");
    if (!fs.existsSync(cwd)) throw new Error(`Working directory not found: ${cwd}`);
    // A prior OpenCode session id (from sessionManager) lets us resume the model's
    // conversation across app restarts against the persistent per-session DB.
    if (options.resumeSessionId && !this.agentResumeId) {
      this.agentResumeId = options.resumeSessionId;
    }
    this.cwd = cwd;
    const previousOptions = this.spawnOptions || {};
    const nextFingerprint = String(options.modelConfigFingerprint || "");
    const activeFingerprint = String(this._activeModelConfigFingerprint || "");
    const previousFingerprint = String(previousOptions.modelConfigFingerprint || "");
    this.spawnOptions = options;
    if (
      this._server &&
      !this.busy &&
      nextFingerprint &&
      activeFingerprint &&
      nextFingerprint !== activeFingerprint
    ) {
      this._restartIdleEngineForModelConfigChange(activeFingerprint, nextFingerprint);
    } else if (
      this._server &&
      !this.busy &&
      nextFingerprint &&
      previousFingerprint &&
      nextFingerprint !== previousFingerprint &&
      !activeFingerprint
    ) {
      this._restartIdleEngineForModelConfigChange(previousFingerprint, nextFingerprint);
    } else if (require("./opencode-config-freshness").toolConfigChanged(this, options, previousOptions)) {
      this.recycleIdleEngine("tool_config_changed");
    }
    if (callOpts.lazy) return;
    void this._ensureStarted();
  }

  _restartIdleEngineForModelConfigChange(previousFingerprint = "", nextFingerprint = "") {
    const server = this._server;
    const previousResumeId = this.agentResumeId || server?.sessionID || "";
    log.warn(
      "opencode model config changed — restarting idle engine session: %s -> %s",
      this._logFingerprint(previousFingerprint || "-"),
      this._logFingerprint(nextFingerprint || "-"),
    );
    try {
      server?.terminate?.();
    } catch {
      // best effort; the next prompt will create a fresh server view.
    }
    if (this._server === server) this._server = null;
    this._starting = null;
    this.agentResumeId = null;
    this._engineSessionWasResumed = false;
    this._activeModelConfigFingerprint = "";
    this.emit("engine-session-invalidated", {
      reason: "model_config_changed",
      errorCode: "",
      previousResumeId,
      resetResume: true,
    });
  }

  /** App-level SQLite path for the shared OpenCode serve. OpenCode session rows
   *  are already keyed by their `ses_...` id; using a per-Lily-session DB with a
   *  shared serve made multi-session resume depend on whichever session started
   *  the serve first. */
  _dataDir() {
    if (this.spawnOptions?.dataDir) return this.spawnOptions.dataDir;
    try {
      return require("./config").opencodeDbPath();
    } catch {
      return path.join(os.tmpdir(), "lily-opencode", "opencode.db");
    }
  }

  /** Idempotently start the serve process, create a session, and subscribe.
   *  The server is REUSED across turns — that's what threads the conversation
   *  (every turn POSTs to the same session id, so OpenCode keeps full context).
   *  Do NOT restart it just because the config string changed: AGENT.md varies
   *  per turn (workspace digest, learned context), so a config-diff restart fired
   *  every turn and broke continuity ("every question treated as new"). A genuine
   *  permission-mode change applies via applyPermissionMode terminating the idle
   *  runner, after which this spawns fresh and resumes the same session id. */
  _ensureStarted() {
    if (this._server && this._server.sessionID) {
      // Trust the fast path only while the serve process is actually running:
      // a crashed serve can linger as an object with an exit code before the
      // exit handler clears it, and returning it here made the very next send
      // fail instantly ("engine process failed to start") instead of starting
      // a fresh engine.
      const proc = this._server.process;
      const dead = Boolean(proc && (proc.exitCode != null || proc.signalCode != null || proc.killed));
      if (!dead) return Promise.resolve(this._server);
      log.warn("opencode serve object was dead at fast path; starting fresh");
      this._server = null;
    }
    if (this._starting) return this._starting;
    // SNAPSHOT the spawn options: terminate() nulls this.spawnOptions, and it
    // can race an async start continuation (idle recycling, session
    // invalidation, safe-replay). The bare property read here produced the
    // field TypeError "Cannot read properties of null (reading 'agentCommand')",
    // which the broad request-failed classifier then mislabeled as a NETWORK
    // interruption. A recycled runner must fail honestly and retryably.
    const spawnOptions = this.spawnOptions;
    if (!spawnOptions?.agentCommand) {
      return Promise.reject(new Error(
        "RUNNER_TERMINATED: the engine runner was recycled before the turn could start",
      ));
    }
    this._starting = (async () => {
      const server = this._createServer({
        serverCommand: spawnOptions.agentCommand,
        cwd: this.cwd,
        dataDir: this._dataDir(),
        env: spawnOptions.env || {},
        model: spawnOptions.model || null,
        agent: spawnOptions.agent || null,
        resumeSessionID: this.agentResumeId || null,
        configContent: spawnOptions.opencodeConfig || "",
      });
      server.on("event", (ev) => this._handleEvent(ev));
      server.on("exit", ({ code }) => this._onServerExit(code));
      server.on("error", (err) => this._onServerError(err));
      await server.start();
      const id = await server.createSession();
      server.subscribe();
      this._server = server;
      this._engineSessionWasResumed = Boolean(server.wasResumed);
      this._activeModelConfigFingerprint = String(spawnOptions.modelConfigFingerprint || "");
      this._activeToolConfigFingerprint = String(spawnOptions.toolConfigFingerprint || "");
      // Guidance is delivered with each prompt, not only with fresh sessions:
      // OpenCode resume history may predate the current Lily rules/skill set, and
      // session-level skill toggles can change between turns.
      this._guidancePending = Boolean(this.spawnOptions?.guidance);
      this.agentResumeId = id;
      this.emit("agent-resume-id", id);
      // Started — clear the "starting" flag so isAlive() keys on the live process,
      // not a resolved start promise that never gets reset (which would mask a
      // later crash and report a dead engine as alive).
      this._starting = null;
      return server;
    })();
    this._starting.catch((err) => {
      this._starting = null;
      // Surfaced by the preflight's RUNNER_ERROR detail (ipc-utils reads it) —
      // without this the user only ever saw the generic "failed to start".
      this.lastSpawnError = this._sanitize(err?.message || String(err || ""));
      log.warn("opencode start failed: %s", err?.message || String(err));
      if (this.busy && !this._turnSettled) this._failTurn(this._sanitize(err?.message), err);
    });
    return this._starting;
  }

  isAlive() {
    // "Alive" includes the async startup window: the Claude runner spawns
    // synchronously, but OpenCode's `serve` comes up over HTTP, so ensureProcess
    // returns before the server is ready. Treating an in-flight start as alive
    // lets the orchestrator's spawn:true preflight pass (otherwise every send
    // fails "Unable to start the assistant process").
    const p = this._server && this._server.process;
    // Verify the child is actually running — not just that a (possibly dead)
    // process object lingers. A crashed serve leaves the object set with a
    // non-null exitCode; without this check isAlive() reported it as alive.
    const running = Boolean(p && p.exitCode == null && p.signalCode == null && !p.killed);
    return running || Boolean(this._starting);
  }

  isBusy() {
    return this.busy || this._abortSettling;
  }

  /** Drop the idle engine server so the NEXT send spawns a fresh serve
   *  process — fresh gateway sockets — and resumes the same engine session.
   *  Field case: a load-balanced gateway with connection affinity pinned the
   *  engine's keep-alive pool to a dead backend pod during a rolling swap, so
   *  every request (and every same-runner rescue retry) rode the same dead
   *  socket and came back empty, while NEW connections reached healthy pods.
   *  Preserves agentResumeId (unlike a config-change restart) — the recycled
   *  engine continues the same conversation. */
  recycleIdleEngine(reason = "") {
    if (this.isBusy()) return false;
    const server = this._server;
    const resumeId = this.agentResumeId || server?.sessionID || null;
    revokeOpencodeRuntimeIdentity(this, resumeId, "runner_recycled");
    if (server) {
      try {
        server.terminate();
      } catch {
        // Best effort; a dead process object is dropped either way.
      }
      if (this._server === server) this._server = null;
    }
    this._starting = null;
    this._activeModelConfigFingerprint = this._activeToolConfigFingerprint = "";
    if (resumeId) this.agentResumeId = resumeId;
    log.info("idle engine recycled (%s): next send gets fresh gateway connections", reason || "-");
    return true;
  }

  diagnostics() {
    const livenessTimers = this._turnLiveness.diagnostics();
    return {
      sessionId: this.sessionId,
      cwd: this.cwd || "",
      alive: this.isAlive(),
      busy: this.busy,
      abortSettling: this._abortSettling,
      turnSettled: this._turnSettled,
      sawActivity: this._sawActivity,
      collectedOutputLength: this.collectedOutput.length,
      modelRoute: this.spawnOptions?.modelRouteAudit || null,
      pendingPermissions: this._pendingPermissions.size,
      pendingQuestions: this._pendingQuestions.size,
      pendingComplete: Boolean(this._pendingCompletePayload),
      timers: {
        response: livenessTimers.response,
        progressNotice: livenessTimers.progressNotice,
        idleSettle: Boolean(this._idleSettleTimer),
        idleProbe: Boolean(this._idleProbeTimer),
        promptAcceptance: Boolean(this._promptAcceptanceTimer),
        promptDispatchPending: Boolean(this._promptDispatchPendingTimer),
        health: livenessTimers.health,
      },
      promptDispatchPending: Boolean(this._promptDispatchPending),
      server: this._server?.diagnostics?.() || null,
    };
  }

  // --- outbound ------------------------------------------------------------

  sendUserMessage(payload) {
    if (this.isBusy()) return false;
    const text = typeof payload === "string" ? payload : payload?.text;
    const files = typeof payload === "object" && payload?.files ? payload.files : [];
    if (!text && (!files || files.length === 0)) return false;

    this.busy = true;
    this._turnSettled = false;
    this._sawActivity = false;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    this._activeTools.clear();
    this._turnLiveness.resetProgressNotice();
    this._gatedThisTurn = false;
    this._latestTodos = [];
    this._latestTodosSignature = "";
    this._todoCompletionGateAttempts = 0;
    requiredToolCompletion.reset(this, typeof payload === "object" ? payload?.requiredSuccessfulTools : []);
    this._dispatchRetryCount = 0;
    this._transientReplayCount = 0;
    this._engineSessionWasResumed = Boolean(this._server?.wasResumed || this._engineSessionWasResumed);
    this.collectedOutput = "";
    this._turnStartedAt = Date.now();
    this._pendingTransientFailure = null;
    this._promptDispatchPending = false;
    this._turnAcceptedEmitted = false;
    this._activeTaskContract = typeof payload === "object" ? payload?.taskContract || null : null;
    this._nonInteractiveTurn = typeof payload === "object" && payload?.nonInteractive === true;
    this._clearTransientFailureTimer();
    this._clearIdleProbeTimer();
    // First engine message id of this turn — the rewind anchor. Reverting to it
    // undoes the whole exchange (the engine anchors back to the preceding user msg).
    this._turnEngineMessageId = null;
    this._armResponseTimer();
    this._armProgressNoticeTimer();
    this._armHealthProbe();
    this._armTurnWatchdog();

    (async () => {
      try {
        const server = await this._ensureStarted();
        grantOpencodeRuntimeIdentity(this, server, typeof payload === "object" ? payload : {});
        // Refresh the cross-session memory the compaction plugin injects, keyed by
        // the engine session id (now that the server is started). Snapshotting at
        // turn start means a mid-turn compaction sees the latest durable facts.
        this._refreshCompactionMemory(server);
        // Skill guidance rides every user turn as hidden engine context. This
        // keeps resumed/migrated sessions and skill changes aligned with Lily's
        // current rules instead of relying on stale OpenCode history.
        const guidance = this.spawnOptions?.guidance || "";
        this._pendingPromptPayload = {
          text,
          files,
          guidance,
          allowImageFileParts: typeof payload === "object" && payload?.allowImageFileParts === true,
          characterContext: typeof payload === "object" ? payload?.characterContext || null : null,
          onCharacterApplication: (application) => {
            this._ingest([{ type: "character.application", payload: application }]);
          },
        };
        this._promptDispatchPending = true;
        this._armPromptDispatchPendingCheck();
        await server.sendPrompt(this._pendingPromptPayload);
        this._promptDispatchPending = false;
        this._clearPromptDispatchPendingCheck();
        this._markTurnAccepted("prompt_async_returned");
        this._armPromptAcceptanceCheck();
      } catch (err) {
        this._promptDispatchPending = false;
        this._clearPromptDispatchPendingCheck();
        // The turn is driven by SSE (session.idle/events). If events already
        // arrived, a hiccup on the blocking message POST is NOT a turn failure —
        // let SSE finish. promptAsync can surface a transport error after OpenCode
        // already accepted the turn, so give the event stream a short proof window
        // before declaring the prompt lost.
        log.warn("opencode prompt dispatch failed: %s", err?.message || String(err));
        if (this.busy && !this._turnSettled && !this._sawActivity && !this._sawEngineEvent) {
          this._scheduleDispatchFailure(err);
        }
      }
    })();
    return true;
  }

  /** Steer ("插话"): inject a message into the RUNNING turn instead of aborting or
   *  queuing for after. The engine appends the user message and the in-flight prompt
   *  loop picks it up at its next step (verified against OpenCode's SessionPrompt
   *  loop, which re-reads the latest messages each iteration). Deliberately does NOT
   *  reset turn state — the active turn keeps owning the SSE/lifecycle. Returns false
   *  when not steerable so the caller degrades to queue (never worse than today).
   *  @param {{ text?: string, files?: Array<object> } | string} payload */
  async steer(payload) {
    if (!this.busy || this._turnSettled) return false;
    const text = typeof payload === "string" ? payload : payload?.text;
    const files = typeof payload === "object" && payload?.files ? payload.files : [];
    if (!text && (!files || files.length === 0)) return false;
    try {
      const server = this._server || (await this._ensureStarted());
      if (!server) return false;
      const guidance = this.spawnOptions?.guidance || "";
      await server.sendPrompt({
        text,
        files,
        guidance,
        allowImageFileParts: typeof payload === "object" && payload?.allowImageFileParts === true,
      });
      // A steer IS progress: keep the no-progress watchdog from killing the turn.
      this._sawActivity = true;
      this._armResponseTimer();
      this._armProgressNoticeTimer();
      return true;
    } catch (err) {
      log.warn("opencode steer dispatch failed: %s", err?.message || String(err));
      return false;
    }
  }

  /** Host-side auto-decision for a gated tool (no user dialog). reply is the
   *  engine response: "once" (allow this call) or "reject" (deny). The serve
   *  asked; the session's mode answered. */
  _autoRespondPermission(requestId, reply) {
    void this._server
      ?.respondPermission(requestId, { reply })
      .catch((err) => log.warn("auto permission reply failed: %s", err?.message || String(err)));
  }

  respondPermission(requestId, decision = {}) {
    const pending = this._pendingPermissions.get(requestId);
    if (!pending) return false;
    this._pendingPermissions.delete(requestId);
    const reply = decision.allow ? (decision.remember ? "always" : "once") : "reject";
    void this._server
      ?.respondPermission(pending.rawRequestId || requestId, { reply, message: decision.message }, { sessionID: pending.sessionID })
      .catch((err) => log.warn("permission reply failed: %s", err?.message || String(err)));
    this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: false } }]);
    return true;
  }

  // OpenCode has no Claude-style hooks; user questions use the `question` tool
  // (wired in a later slice). Keep the surface so the orchestrator calls no-op.
  /**
   * Answer a `question` tool prompt. `response` is the host shape
   * { answers, response? }; we coerce it to OpenCode's string[][] (one array of
   * selected labels per question, in order).
   */
  respondUserQuestion(requestId, response = {}) {
    const pending = this._pendingQuestions.get(requestId);
    if (!pending) return false;
    this._pendingQuestions.delete(requestId);
    const answers = toOpencodeAnswers(response, pending.questions || []);
    void this._server
      ?.respondQuestion(pending.rawRequestId || requestId, answers, { sessionID: pending.sessionID })
      .catch((err) => log.warn("question reply failed: %s", err?.message || String(err)));
    this._ingest([{ type: "user_question.resolved", payload: { requestId } }]);
    return true;
  }

  respondHook() { return false; }
  reloadSkills() { return false; }

  // Write Lily's curated navigation memory to the file the compaction plugin reads
  // (resources/opencode-plugins/compaction-memory.js), keyed by the engine session
  // id. Fail-safe: any error just means the plugin finds nothing and the engine
  // compacts as usual — never breaks a turn.
  _refreshCompactionMemory(server) {
    try {
      const engineSessionId = server?.sessionID || this._server?.sessionID || "";
      if (!engineSessionId) return;
      const { userDataPath } = require("./config");
      const { COMPACTION_MEMORY_DIRNAME, writeCompactionMemoryFile } = require("./compaction-memory-export");
      const summary = require("./session-memory").readSessionSummary(this.sessionId);
      if (!summary) return;
      writeCompactionMemoryFile(userDataPath(COMPACTION_MEMORY_DIRNAME), engineSessionId, summary);
    } catch (err) {
      log.warn("compaction memory refresh failed: %s", err?.message || String(err));
    }
  }

  async compactContext(body = {}) {
    if (this.isBusy()) return false;
    try {
      const server = this._server || (await this._ensureStarted());
      if (!server?.summarize) return false;
      // Pre-turn compaction calls the model to summarize a large context. If that
      // call HANGS (slow/stuck gateway, oversized context), an unbounded await
      // freezes the turn forever at "Preparing to compact…". Bound it and let the
      // timeout fall into the catch below → return false → the caller fails open
      // and runs the turn WITHOUT compaction (baseline), never stuck.
      await runWithTimeout(server.summarize(body), compactionTimeoutMs(), "COMPACTION_TIMEOUT");
      try {
        require("./session-memory").markSessionCompacted(this.sessionId, {
          runtime: "opencode",
          mode: "native",
          reason: body.reason || "",
        });
      } catch (err) {
        log.warn("session compaction memory update failed: %s", err?.message || String(err));
      }
      return true;
    } catch (err) {
      const errorMessage = err?.message || String(err);
      const providerID = body?.providerID || "";
      const modelID = body?.modelID || "";
      const reason = body?.reason || "";
      log.warn(
        `opencode context compaction failed: session=${this.sessionId} cwd=${this.cwd || ""} provider=${providerID || "-"} model=${modelID || "-"} reason=${reason || "-"} error=${errorMessage}`,
      );
      try {
        require("./session-memory").markSessionCompactionFailed(this.sessionId, {
          runtime: "opencode",
          mode: "native",
          reason,
          providerID,
          modelID,
          code: err?.name || "",
          error: errorMessage,
        });
      } catch (memoryErr) {
        log.warn(`session compaction failure memory update failed: ${memoryErr?.message || String(memoryErr)}`);
      }
      return false;
    }
  }

  updateEnvironmentVariables() {
    // OpenCode reads provider/model/search config when the shared serve starts.
    // Report "not applied" so callers rebuild idle runners instead of pretending
    // a model/API change reached an already-running serve.
    return false;
  }

  setPermissionMode(mode) {
    if (this.spawnOptions) this.spawnOptions.permissionMode = mode;
    // Permission is now enforced host-side (decidePermission reads permissionMode
    // live on each gated tool call), so a mode change applies IMMEDIATELY — no
    // serve restart, no session-resume dance. Report applied-live.
    return true;
  }

  interrupt() {
    this._clearPendingPermissions();
    if (this._server && !this._abortSettling) {
      const server = this._server;
      this._abortSettling = true;
      void this._abortWithTimeout(server)
        .catch((err) => log.warn("opencode abort failed: %s", err?.message || String(err)))
        .finally(() => {
          this._abortSettling = false;
        });
    }
    if (this.busy && !this._turnSettled) {
      // interrupt() is only ever called for a user-initiated stop, so mark it as
      // such: the orchestrator distinguishes a user interrupt (turn.interrupted)
      // from an engine-side abort (turn.failed) by interruptedByUser. Without this
      // flag a user stop was misclassified as completed/failed.
      this._completeTurn({
        code: null,
        output: this.collectedOutput.trim(),
        interrupted: true,
        interruptedByUser: true,
      });
    }
  }

  terminate() {
    this._clearIdleSettleTimer();
    this._clearIdleProbeTimer();
    this._pendingCompletePayload = null;
    this._clearDispatchFailureTimer();
    this._clearPromptDispatchPendingCheck();
    this._clearPromptAcceptanceCheck();
    this._clearTransientFailureTimer();
    this._clearResponseTimer();
    this._clearProgressNoticeTimer();
    this._clearHealthProbe();
    this._clearTurnWatchdog();
    this._clearPendingPermissions();
    revokeOpencodeRuntimeIdentity(this, this._server?.sessionID || this.agentResumeId, "runner_terminated");
    if (this._server) {
      this._server.terminate();
      this._server = null;
    }
    this._starting = null;
    this.busy = false;
    this._abortSettling = false;
    this._turnSettled = true;
    this.cwd = null;
    this.spawnOptions = null;
    this._pendingPromptPayload = null;
    this._promptDispatchPending = false;
    this._turnAcceptedEmitted = false;
    this._activeTaskContract = null;
    this._dispatchRetryCount = 0;
    this._transientReplayCount = 0;
    this._activeModelConfigFingerprint = "";
    this._pendingTransientFailure = null;
    this._turnStartedAt = 0;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    this._activeTools.clear();
    this._turnLiveness.resetProgressNotice();
  }

  async _abortWithTimeout(server) {
    let timer = null;
    try {
      await Promise.race([
        server.abort(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("abort timed out")), OpencodeAgentSession.INTERRUPT_ABORT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      try { server.terminate?.(); } catch { /* best effort */ }
      if (this._server === server) {
        this._server = null;
        this._starting = null;
        this._activeModelConfigFingerprint = "";
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // --- inbound: OpenCode event -> runtime drafts + host effects ------------

  _handleEvent(ev) {
    if (!this.busy || this._turnSettled) return;
    const childSessionID = ev?.__lilySubagentSessionID || "";
    if (childSessionID) {
      this._subagentRuntime.handleEvent(childSessionID, ev);
      return;
    }
    if (isTurnOwnedEngineEvent(ev)) {
      this._sawEngineEvent = true;
      this._clearDispatchFailureTimer();
      this._clearPromptDispatchPendingCheck();
      this._clearPromptAcceptanceCheck();
      this._markTurnAccepted("engine_event");
    }

    // Capture the turn's first engine message id (rewind anchor) before normalize.
    if (!this._turnEngineMessageId) {
      const mid = ev?.properties?.messageID || ev?.properties?.part?.messageID || ev?.properties?.info?.id;
      if (typeof mid === "string" && mid.startsWith("msg_")) this._turnEngineMessageId = mid;
    }

    this._noteRawToolActivity(ev);

    let reduced;
    try {
      reduced = reduceOpencodeRuntimeEvent(ev, this._eventState);
    } catch (err) {
      log.warn("opencode event reducer failed: %s", err?.message || String(err));
      return;
    }

    // Meaningful reducer progress = the engine is making forward movement (text,
    // thinking, a tool call/update/result, permission/question, completion, or
    // usage). Reset the no-progress watchdog only on these — NOT on
    // every event. Busy/heartbeat events carry no actions, so a turn that just
    // pings "busy" without doing anything still times out, while a genuinely long
    // task that keeps progressing (an hour of converting files, etc.) resets the
    // watchdog on each step and runs to completion.
    if (reduced.progress) {
      this._sawActivity = true;
      this._clearDispatchFailureTimer();
      this._clearPromptDispatchPendingCheck();
      this._clearPromptAcceptanceCheck();
      this._clearTransientFailureTimer();
      this._armResponseTimer();
      this._armProgressNoticeTimer();
      this._armIdleProbe();
    }

    for (const effect of reduced.effects || []) {
      this._handleEffect(effect, { sessionID: this._server?.sessionID || "" });
    }

    // Keep the renderer contract stable: relocate tool.done content -> result
    // (truncated), append the process.event timeline draft, then hand the batch
    // to the orchestrator.
    const drafts = [...(reduced.drafts || [])];
    this._subagentRuntime.registerFromDrafts(drafts);
    for (const draft of drafts) {
      if (draft.type === "todo.updated") {
        this._rememberLatestTodos(draft.payload?.todos);
      }
      if (String(draft.type || "").startsWith("tool.")) this._noteToolActivity(draft);
      if (draft.type !== "tool.done") continue;
      const raw = draft.payload?.content;
      if (typeof raw !== "string" || !raw) continue;
      draft.payload.result = truncateToolResultForUi(raw);
      delete draft.payload.content;
    }
    if (reduced.processEvent) drafts.push(reduced.processEvent);
    this._ingest(drafts);
  }

  _rememberLatestTodos(todos) {
    const next = Array.isArray(todos) ? todos : [];
    let signature = "";
    try {
      signature = JSON.stringify(next.map((todo, index) => ({
        title: todoTitle(todo, index),
        status: normalizeTodoStatus(todo?.status),
      })));
    } catch {
      signature = "";
    }
    if (signature !== this._latestTodosSignature) {
      this._latestTodosSignature = signature;
      this._todoCompletionGateAttempts = 0;
    }
    this._latestTodos = next;
  }

  _noteToolActivity(draft = {}) {
    this._sawToolActivity = true;
    requiredToolCompletion.note(this, draft);
    const payload = draft.payload || {};
    const id = String(payload.id || "");
    if (draft.type === "tool.started") {
      this._startOrTouchActiveTool({
        id,
        name: payload.name,
        input: payload.input,
        title: payload.title,
      });
      const safe = isReplaySafeToolName(payload.name);
      if (id) this._toolReplaySafe.set(id, safe);
      if (!safe) this._sawUnsafeToolActivity = true;
      return;
    }
    if (draft.type === "tool.done") {
      if (id) this._activeTools.delete(id);
      const safe = id && this._toolReplaySafe.has(id)
        ? this._toolReplaySafe.get(id)
        : isReplaySafeToolName(payload.name);
      if (!safe) this._sawUnsafeToolActivity = true;
    }
  }

  _noteRawToolActivity(ev = {}) {
    const tool = rawToolFromEvent(ev);
    if (!tool?.id) return;
    const status = String(tool.status || "");
    if (status === "completed" || status === "error" || status === "failed" || status === "done") {
      this._activeTools.delete(tool.id);
      return;
    }
    if (status === "running" || status === "pending" || status === "") {
      this._startOrTouchActiveTool(tool);
    }
  }

  _startOrTouchActiveTool(tool = {}) {
    const id = String(tool.id || "");
    if (!id) return;
    const now = Date.now();
    const existing = this._activeTools.get(id) || {};
    this._activeTools.set(id, {
      ...existing,
      id,
      name: tool.name || existing.name || "Tool",
      input: tool.input && typeof tool.input === "object" && Object.keys(tool.input).length
        ? tool.input
        : (existing.input || {}),
      title: tool.title || existing.title || "",
      startedAt: existing.startedAt || now,
      lastActivityAt: now,
    });
  }

  _handleEffect(effect, opts = {}) {
    switch (effect.kind) {
      case "assistant_text":
        this.collectedOutput += effect.text || "";
        this._armResponseTimer();
        break;

      case "permission": {
        // The shared serve asks for every mutation; the session's MODE is
        // enforced HERE (host-side), mirroring the official client. Auto-allow /
        // auto-deny without bothering the user; only "ask" surfaces the dialog.
        const mode = this.spawnOptions?.permissionMode || "ask";
        const verdict = decidePermission(mode, effect.toolName, effect.input || {}, {
          cwd: this.cwd, taskContract: this._activeTaskContract, nonInteractive: this._nonInteractiveTurn === true,
        });
        if (verdict === "allow") {
          this._autoRespondPermission(effect.requestId, "once");
          break;
        }
        if (verdict === "deny") {
          this._autoRespondPermission(effect.requestId, "reject");
          break;
        }
        this._pendingPermissions.set(effect.requestId, {
          rawRequestId: effect.requestId,
          sessionID: opts.sessionID || this._server?.sessionID || "",
        });
        this._ingest([{
          type: "permission.requested",
          payload: {
            requestId: effect.requestId,
            toolName: effect.toolName,
            input: effect.input || {},
            title: effect.title || "",
            description: effect.description || "",
            decisionReason: effect.decisionReason || "",
            suggestions: effect.suggestions || [],
            planPreview: "",
            planPreviewTruncated: false,
          },
        }]);
        break;
      }

      case "question": {
        const questions = effect.questions || [];
        this._pendingQuestions.set(effect.requestId, {
          questions,
          rawRequestId: effect.requestId,
          sessionID: opts.sessionID || this._server?.sessionID || "",
        });
        this._ingest([{
          type: "user_question.requested",
          payload: { requestId: effect.requestId, questions },
        }]);
        break;
      }

      case "complete": {
        this._scheduleCompleteTurn({
          code: effect.code || 0,
          output: this.collectedOutput.trim(),
          interrupted: false,
        });
        break;
      }

      case "usage":
        // Token usage from a step-finish — record it for cost/usage tracking;
        // the reducer already produced usage.updated for the renderer.
        if (effect.usage && typeof effect.usage === "object") {
          try {
            require("./usage-reporter").recordModelUsage(this.sessionId, effect.usage);
          } catch (err) {
            log.warn("usage record failed: %s", err?.message || String(err));
          }
        }
        break;

      case "context_compacted":
        require("./opencode-compaction-effects").handleOpencodeCompacted(this, effect);
        break;

      case "error": {
        const rawMessage = typeof effect.message === "string" && effect.message ? effect.message : "Engine error";
        const displayMessage = this._sanitize(rawMessage) || "Engine error";
        this._failTurn(
          displayMessage,
          errorCauseFromEffect(effect, rawMessage),
        );
        break;
      }

      default:
        // Thinking/tool/unknown effects need no host-side state here; their
        // runtime drafts already carry everything the renderer needs.
        break;
    }
  }

  // --- turn settlement -----------------------------------------------------

  async _getSessionStatus() {
    const server = this._server;
    try {
      if (typeof server?.getSessionStatus === "function") {
        const status = await server.getSessionStatus();
        return status === "idle" || status === "busy" ? status : "unknown";
      }
      if (typeof server?.isSessionIdle === "function") {
        return await server.isSessionIdle() ? "idle" : "busy";
      }
    } catch (err) {
      log.warn("opencode session status read failed: %s", err?.message || String(err));
    }
    return "unknown";
  }

  _scheduleCompleteTurn(payload) {
    if (this._turnSettled) return;
    this._pendingCompletePayload = payload;
    this._clearIdleSettleTimer();
    this._clearIdleProbeTimer();
    this._idleSettleTimer = setTimeout(() => {
      this._idleSettleTimer = null;
      void this._confirmIdleAndComplete();
    }, OpencodeAgentSession.IDLE_SETTLE_MS);
    this._idleSettleTimer.unref?.();
  }

  async _confirmIdleAndComplete() {
    const next = this._pendingCompletePayload;
    if (!next || this._turnSettled) return;
    const status = await this._getSessionStatus();
    if (!this._pendingCompletePayload || this._turnSettled) return;
    if (status === "busy") {
      this._scheduleCompleteTurn(next);
      return;
    }
    this._pendingCompletePayload = null;
    const synced = await this._syncFinalOutputFromOfficialHistory({
      ...next,
      output: this.collectedOutput.trim(),
    });
    if (await this._replayEmptyCompletionIfSafe(synced)) return;
    this._completeTurn(synced);
  }

  _clearIdleSettleTimer() {
    if (this._idleSettleTimer) {
      clearTimeout(this._idleSettleTimer);
      this._idleSettleTimer = null;
    }
  }

  _armIdleProbe() {
    this._clearIdleProbeTimer();
    if (!this.busy || this._turnSettled || this._pendingCompletePayload) return;
    if (!this._sawActivity) return;
    this._idleProbeTimer = setTimeout(() => {
      this._idleProbeTimer = null;
      void this._probeOfficialIdleAndComplete();
    }, OpencodeAgentSession.IDLE_STATUS_PROBE_MS);
    this._idleProbeTimer.unref?.();
  }

  _clearIdleProbeTimer() {
    if (this._idleProbeTimer) {
      clearTimeout(this._idleProbeTimer);
      this._idleProbeTimer = null;
    }
  }

  async _probeOfficialIdleAndComplete() {
    if (!this.busy || this._turnSettled || this._pendingCompletePayload) return;
    if (this._pendingPermissions.size || this._pendingQuestions.size) {
      this._armIdleProbe();
      return;
    }
    const status = await this._getSessionStatus();
    if (!this.busy || this._turnSettled || this._pendingCompletePayload) return;
    if (status !== "idle") {
      this._armIdleProbe();
      return;
    }
    // The SSE stream is a live feed, but official session status/history is the
    // source of truth. If `session.idle` was dropped during reconnect or could
    // not be safely routed, a quiet idle status after real progress must still
    // settle the turn instead of waiting for the long no-progress watchdog.
    this._scheduleCompleteTurn({
      code: 0,
      output: this.collectedOutput.trim(),
      interrupted: false,
      completedByIdleProbe: true,
    });
  }

  _scheduleDispatchFailure(cause) {
    this._pendingDispatchFailure = cause;
    this._clearDispatchFailureTimer(false);
    this._dispatchFailureTimer = setTimeout(() => {
      this._dispatchFailureTimer = null;
      void this._confirmDispatchFailure();
    }, OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS);
    this._dispatchFailureTimer.unref?.();
  }

  async _confirmDispatchFailure() {
    const pending = this._pendingDispatchFailure;
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) {
      this._pendingDispatchFailure = null;
      return;
    }

    // promptAsync is fire-and-forget. A transport error can mean either "the
    // request did not arrive" or "the client lost the response after OpenCode
    // accepted it". Ask OpenCode before showing a model failure; if the session
    // is busy, the turn landed and SSE/health timers own the outcome.
    const status = await this._getSessionStatus();
    if (status === "busy") {
      this._pendingDispatchFailure = null;
      this._markTurnAccepted("official_busy");
      return;
    }

    if (this._dispatchRetryCount < 1 && this._server && this._pendingPromptPayload) {
      this._dispatchRetryCount += 1;
      const raw = transientClassificationText(pending?.message, pending);
      const classified = require("./agent-runner").classifyAssistantError(raw);
      const refreshManagedConfig = isManagedModelConfigStale(classified, raw, this.spawnOptions);
      const retryPayload = buildAttachmentFallbackPromptPayload(
        this._pendingPromptPayload,
        this._sanitize(pending?.message || ""),
      );
      this._pendingPromptPayload = retryPayload;
      try {
        if (refreshManagedConfig && !(await this._refreshManagedModelConfigForRetry(raw))) {
          throw new Error(raw || "managed model config refresh failed");
        }
        const server = shouldRebuildEngineForRetry({ refreshManagedConfig, classified, raw })
          ? await this._restartEngineSessionForSafeReplay(raw || "fresh engine session for retry")
          : this._server;
        await server.sendPrompt(retryPayload);
        this._pendingDispatchFailure = null;
        this._markTurnAccepted("dispatch_retry_returned");
        this._armPromptAcceptanceCheck();
        return;
      } catch (err) {
        this._pendingDispatchFailure = err;
        this._scheduleDispatchFailure(err);
        return;
      }
    }

    this._pendingDispatchFailure = null;
    if (this.busy && !this._turnSettled && !this._sawActivity) {
      this._failTurn(this._sanitize(pending?.message), pending);
    }
  }

  _clearDispatchFailureTimer(clearPending = true) {
    if (this._dispatchFailureTimer) {
      clearTimeout(this._dispatchFailureTimer);
      this._dispatchFailureTimer = null;
    }
    if (clearPending) this._pendingDispatchFailure = null;
  }

  _armPromptDispatchPendingCheck() {
    this._clearPromptDispatchPendingCheck();
    if (!this.busy || this._turnSettled || !this._promptDispatchPending) return;
    this._promptDispatchPendingTimer = setTimeout(() => {
      this._promptDispatchPendingTimer = null;
      void this._confirmPromptDispatchPending();
    }, OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS);
    this._promptDispatchPendingTimer.unref?.();
  }

  _clearPromptDispatchPendingCheck() {
    if (this._promptDispatchPendingTimer) {
      clearTimeout(this._promptDispatchPendingTimer);
      this._promptDispatchPendingTimer = null;
    }
  }

  async _confirmPromptDispatchPending() {
    if (!this.busy || this._turnSettled || !this._promptDispatchPending) return;
    if (this._sawActivity || this._sawEngineEvent) {
      this._markTurnAccepted("engine_activity");
      return;
    }

    const status = await this._getSessionStatus();
    if (!this.busy || this._turnSettled || !this._promptDispatchPending) return;
    if (status === "busy") {
      this._markTurnAccepted("official_busy");
      return;
    }

    // Do not replay while the original prompt request is still pending: that can
    // duplicate user actions if the request eventually lands. Keep monitoring;
    // the normal no-progress watchdog remains the bounded fallback.
    this._armPromptDispatchPendingCheck();
  }

  _armPromptAcceptanceCheck() {
    this._clearPromptAcceptanceCheck();
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) return;
    this._promptAcceptanceTimer = setTimeout(() => {
      this._promptAcceptanceTimer = null;
      void this._confirmPromptAccepted();
    }, OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS);
    this._promptAcceptanceTimer.unref?.();
  }

  _clearPromptAcceptanceCheck() {
    if (this._promptAcceptanceTimer) {
      clearTimeout(this._promptAcceptanceTimer);
      this._promptAcceptanceTimer = null;
    }
  }

  async _confirmPromptAccepted() {
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) return;

    const status = await this._getSessionStatus();
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) return;
    if (status === "busy") {
      this._markTurnAccepted("official_busy");
      return;
    }
    if (status === "unknown") {
      this._armPromptAcceptanceCheck();
      return;
    }

    const recovered = await this._recoverCompletedAssistantFromHistory({ requireCurrentPrompt: true }).catch((err) => {
      log.warn("opencode prompt acceptance history read failed: %s", err?.message || String(err));
      return null;
    });
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) return;
    if (recovered?.output) {
      this._completeTurn({
        code: 0,
        output: recovered.output,
        interrupted: false,
        engineMessageId: recovered.engineMessageId,
        recoveredFromPromptAcceptance: true,
      });
      return;
    }

    if (this._dispatchRetryCount < 1 && this._server && this._pendingPromptPayload) {
      this._dispatchRetryCount += 1;
      const retryPayload = buildAttachmentFallbackPromptPayload(
        this._pendingPromptPayload,
        "prompt accepted but no session activity",
      );
      this._pendingPromptPayload = retryPayload;
      try {
        await this._server.sendPrompt(retryPayload);
        this._markTurnAccepted("acceptance_retry_returned");
        this._armPromptAcceptanceCheck();
      } catch (err) {
        this._scheduleDispatchFailure(err);
      }
      return;
    }

    this._failTurn(
      "The assistant engine accepted the message but did not start the turn. Please retry.",
      new Error("prompt accepted but no session activity"),
      { force: true },
    );
  }

  _markTurnAccepted(source = "") {
    if (!this.busy || this._turnSettled || this._turnAcceptedEmitted) return false;
    this._turnAcceptedEmitted = true;
    this._ingest([{ type: "turn.accepted", payload: { status: "thinking", source } }]);
    return true;
  }

  _scheduleTransientFailureRecovery(message, cause) {
    const startedAt = this._pendingTransientFailure?.startedAt || Date.now();
    this._pendingTransientFailure = {
      message,
      cause,
      startedAt,
    };
    this._clearTransientFailureTimer(false);
    this._clearDispatchFailureTimer();
    this._transientFailureTimer = setTimeout(() => {
      this._transientFailureTimer = null;
      void this._recoverOrContinueAfterTransientFailure();
    }, OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS);
    this._transientFailureTimer.unref?.();
  }

  _clearTransientFailureTimer(clearPending = true) {
    if (this._transientFailureTimer) {
      clearTimeout(this._transientFailureTimer);
      this._transientFailureTimer = null;
    }
    if (clearPending) this._pendingTransientFailure = null;
  }

  async _recoverOrContinueAfterTransientFailure() {
    const pending = this._pendingTransientFailure;
    if (!pending || !this.busy || this._turnSettled) {
      this._pendingTransientFailure = null;
      return;
    }

    const recovered = await this._recoverCompletedAssistantFromHistory({ requireCurrentPrompt: true }).catch((err) => {
      log.warn("opencode transient recovery history read failed: %s", err?.message || String(err));
      return null;
    });
    if (!this.busy || this._turnSettled) return;
    if (recovered?.output) {
      this._pendingTransientFailure = null;
      this._completeTurn({
        code: 0,
        output: recovered.output,
        interrupted: false,
        engineMessageId: recovered.engineMessageId,
      });
      return;
    }

    const status = await this._getSessionStatus();
    if (!this.busy || this._turnSettled) return;
    if (status === "idle" && this.collectedOutput.trim()) {
      this._pendingTransientFailure = null;
      this._completeTurn({ code: 0, output: this.collectedOutput.trim(), interrupted: false });
      return;
    }
    if (status === "idle" && await this._replayTransientPromptIfSafe(pending)) {
      return;
    }

    const elapsed = Date.now() - pending.startedAt;
    if (elapsed < OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS) {
      this._scheduleTransientFailureRecovery(pending.message, pending.cause);
      return;
    }

    this._pendingTransientFailure = null;
    this._failTurn(pending.message, pending.cause, { force: true });
  }

  async _replayTransientPromptIfSafe(pending) {
    if (!this._pendingPromptPayload || !this._server) return false;
    if (this._transientReplayCount >= 1) return false;
    if (this._sawUnsafeToolActivity || this.collectedOutput.trim()) return false;
    if (this._pendingPermissions.size || this._pendingQuestions.size) return false;

    const raw = transientClassificationText(pending?.message, pending?.cause);
    const classified = require("./agent-runner").classifyAssistantError(raw);
    if (!isSafeReplayableModelFailure(classified, raw, this.spawnOptions)) return false;

    this._transientReplayCount += 1;
    this._pendingTransientFailure = null;
    this._clearTransientFailureTimer(false);
    resetOpencodeRuntimeState(this._eventState);
    this._subagentRuntime.reset();
    this.collectedOutput = "";
    this._turnStartedAt = Date.now();
    this._sawActivity = false;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    try {
      const originalPayload = this._pendingPromptPayload;
      const retryPayload = buildAttachmentFallbackPromptPayload(
        originalPayload,
        this._sanitize(raw || "transient model transport failure"),
      );
      this._pendingPromptPayload = retryPayload;
      const refreshManagedConfig = isManagedModelConfigStale(classified, raw, this.spawnOptions);
      if (refreshManagedConfig && !(await this._refreshManagedModelConfigForRetry(raw))) {
        throw new Error(raw || "managed model config refresh failed");
      }
      const isolateDocumentAttachment =
        retryPayload.attachmentFallback && shouldIsolateAttachmentFallback(originalPayload);
      const isolateLegacyResume =
        !retryPayload.attachmentFallback && this._engineSessionWasResumed && isRecoverableModelConnectionFailure(classified, raw);
      if (shouldRebuildEngineForRetry({ refreshManagedConfig, classified, raw, isolateAttachmentFallback: isolateDocumentAttachment, isolateLegacyResume })) {
        await this._restartEngineSessionForSafeReplay(raw || "transient model transport failure");
      }
      const server = await this._ensureStarted();
      await server.sendPrompt(retryPayload);
      this._armResponseTimer();
      this._armProgressNoticeTimer();
      this._armHealthProbe();
      this._armPromptAcceptanceCheck();
      return true;
    } catch (err) {
      this._pendingTransientFailure = {
        message: this._sanitize(err?.message || err),
        cause: err,
        startedAt: Date.now(),
      };
      this._scheduleTransientFailureRecovery(this._pendingTransientFailure.message, err);
      return true;
    }
  }

  async _replayEmptyCompletionIfSafe(payload = {}) {
    if (!this._pendingPromptPayload || !this._server) return false;
    if (this._transientReplayCount >= 1) return false;
    if (this._sawUnsafeToolActivity || this.collectedOutput.trim() || String(payload?.output || "").trim()) return false;
    if (this._pendingPermissions.size || this._pendingQuestions.size) return false;
    if (payload?.interrupted || payload?.stalled || (payload?.code && payload.code !== 0)) return false;

    this._transientReplayCount += 1;
    resetOpencodeRuntimeState(this._eventState);
    this._subagentRuntime.reset();
    this.collectedOutput = "";
    this._turnStartedAt = Date.now();
    this._sawActivity = false;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    try {
      const retryPayload = buildAttachmentFallbackPromptPayload(
        this._pendingPromptPayload,
        "previous model attempt ended with an empty completion",
      );
      this._pendingPromptPayload = retryPayload;
      await this._server.sendPrompt(retryPayload);
      this._armResponseTimer();
      this._armProgressNoticeTimer();
      this._armHealthProbe();
      this._armPromptAcceptanceCheck();
      return true;
    } catch (err) {
      this._failTurn(this._sanitize(err?.message || err), err, { force: true });
      return true;
    }
  }

  async _restartEngineSessionForSafeReplay(reason = "") {
    const server = this._server;
    if (server) {
      log.warn("isolating safe replay in a fresh OpenCode session: %s", this._sanitize(reason || "transient replay failure"));
      try {
        await this._abortWithTimeout(server);
      } catch (err) {
        log.warn("opencode safe replay abort failed: %s", err?.message || String(err));
      }
      try {
        server.terminate?.();
      } catch {
        // best effort
      }
      if (this._server === server) this._server = null;
    }
    this._starting = null;
    this._activeModelConfigFingerprint = "";
    this.agentResumeId = null;
    return this._ensureStarted();
  }

  async _refreshManagedModelConfigForRetry(reason = "") {
    const refresher = this.spawnOptions?.refreshManagedModelConfig || this._refreshManagedModelConfig;
    if (typeof refresher !== "function") return false;
    try {
      const result = await refresher({
        sessionId: this.sessionId,
        reason: "gateway_token_invalid",
        error: String(reason || ""),
      });
      return result === true || result?.ok === true;
    } catch (err) {
      log.warn("managed model config refresh before retry failed: %s", err?.message || String(err));
      return false;
    }
  }

  async _recoverCompletedAssistantFromHistory(opts = {}) {
    return this._historyRecovery.latestAssistant(opts);
  }

  async _latestAssistantFromOfficialHistory(opts = {}) {
    return this._historyRecovery.latestAssistant(opts);
  }

  _withTimeout(promise, timeoutMs, fallback = null) {
    return this._historyRecovery.withTimeout(promise, timeoutMs, fallback);
  }

  async _recoverStalledFinalFromOfficialState() {
    return this._historyRecovery.recoverStalledFinal();
  }

  async _syncFinalOutputFromOfficialHistory(payload) {
    return this._historyRecovery.syncFinalOutput(payload);
  }

  _completeTurn(payload) {
    if (this._turnSettled) return;
    if (requiredToolCompletion.continueBeforeCompletion(this, payload)) return;
    if (this._continueUnfinishedTodosBeforeCompletion(payload)) return;
    // Pillar 3-B completion gate: on a clean turn end, if the assistant claimed a
    // file deliverable that is actually missing/empty, inject ONE corrective
    // follow-up so the turn doesn't settle on a broken/hallucinated result. Fires
    // at most once per turn (_gatedThisTurn) so it can never loop, and only on a
    // success exit — never on errors/interrupts.
    if (
      !payload?.interrupted &&
      !payload?.stalled &&
      payload?.code === 0 &&
      !this._gatedThisTurn &&
      this._server &&
      process.env.LILY_DISABLE_COMPLETION_GATE !== "1"
    ) {
      const violation = detectIncompleteDeliverable(payload.output);
      if (violation) {
        this._gatedThisTurn = true;
        this._armResponseTimer();
        this._armProgressNoticeTimer();
        const note =
          `Completion check: you indicated the deliverable "${violation.path}" ` +
          `but it ${violation.reason}. Actually produce a valid file at that path ` +
          `(or correct your statement if no file was meant), then confirm. Do not claim done until it is real.`;
        (async () => {
          try {
            await this._server.sendPrompt({ text: note, files: [] });
          } catch (err) {
            // If the corrective prompt can't land, settle on the original result
            // rather than hang the turn.
            log.warn("completion gate follow-up failed: %s", err?.message || String(err));
            if (this.busy && !this._turnSettled) this._settleTurn(payload);
          }
        })();
        return; // keep the turn open for the corrective round
      }
    }
    this._settleTurn(payload);
  }

  _continueUnfinishedTodosBeforeCompletion(payload) {
    if (
      payload?.interrupted ||
      payload?.stalled ||
      payload?.code !== 0 ||
      !this._server ||
      this._pendingPermissions.size ||
      this._pendingQuestions.size ||
      process.env.LILY_DISABLE_TODO_COMPLETION_GATE === "1"
    ) {
      return false;
    }
    const snapshot = nativeTodoSnapshot(this._latestTodos);
    if (!snapshot.total || !snapshot.unfinished.length) return false;
    const maxAttempts = TODO_COMPLETION_GATE_MAX_ATTEMPTS;
    if (this._todoCompletionGateAttempts >= maxAttempts) {
      log.warn("unfinished todo completion gate reached max attempts", {
        sessionId: this.sessionId,
        unfinished: snapshot.unfinished.length,
        total: snapshot.total,
        attempts: this._todoCompletionGateAttempts,
      });
      this._settleTurn({
        ...payload,
        stalled: true,
        output: String(payload?.output || this.collectedOutput || "").trim(),
      });
      return true;
    }
    this._todoCompletionGateAttempts += 1;
    this._armResponseTimer();
    this._armProgressNoticeTimer();
    const note = buildTodoContinuationPrompt(snapshot, this._todoCompletionGateAttempts, maxAttempts);
    (async () => {
      try {
        await this._server.sendPrompt({ text: note, files: [] });
      } catch (err) {
        log.warn("unfinished todo continuation failed: %s", err?.message || String(err));
        if (this.busy && !this._turnSettled) this._settleTurn(payload);
      }
    })();
    return true;
  }

  _settleTurn(payload) {
    if (this._turnSettled) return;
    this._clearIdleSettleTimer();
    this._clearIdleProbeTimer();
    this._pendingCompletePayload = null;
    this._clearDispatchFailureTimer();
    this._clearPromptDispatchPendingCheck();
    this._clearPromptAcceptanceCheck();
    this._clearTransientFailureTimer();
    this._clearResponseTimer();
    this._clearProgressNoticeTimer();
    this._clearHealthProbe();
    this._clearTurnWatchdog();
    this._clearPendingPermissions();
    resetOpencodeRuntimeState(this._eventState);
    this._subagentRuntime.reset();
    this._turnSettled = true;
    this.busy = false;
    this._pendingPromptPayload = null;
    this._promptDispatchPending = false;
    this._turnAcceptedEmitted = false;
    this._activeTaskContract = null;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    this._activeTools.clear();
    this._turnLiveness.resetProgressNotice();
    this._transientReplayCount = 0;
    this._turnStartedAt = 0;
    this._latestTodos = [];
    this._latestTodosSignature = "";
    this._todoCompletionGateAttempts = 0;
    requiredToolCompletion.finish(this, payload);
    // Carry the turn's rewind anchor (engine message id) so the orchestrator can
    // record it on the turn — that's what session:rewind reverts to later.
    if (payload && typeof payload === "object" && this._turnEngineMessageId && !payload.engineMessageId) {
      payload.engineMessageId = this._turnEngineMessageId;
    }
    this._orchestrator?.notifyRunnerDone(this.sessionId, payload);
  }

  /** Rewind the engine session to a turn's anchor message (files + dropped
   *  context). Ensures the server is up/resumed first so a cold session can be
   *  rewound. Refuses while a turn is in flight. */
  async revert(engineMessageId) {
    if (!engineMessageId || this.busy) return false;
    const server = await this._ensureStarted();
    await server.revert(engineMessageId);
    return true;
  }

  /** Undo the last rewind (restore reverted messages + files). */
  async unrevert() {
    if (this.busy) return false;
    const server = await this._ensureStarted();
    await server.unrevert();
    return true;
  }

  async fork(engineMessageId) {
    if (!engineMessageId || this.busy) return null;
    const server = await this._ensureStarted();
    return server.fork(engineMessageId);
  }

  async getConversationPage(opts = {}) {
    const server = await this._ensureStarted();
    const raw = await server.messages({
      limit: Number.isInteger(opts.limit) ? opts.limit : 50,
      before: opts.before || undefined,
    });
    const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const cursor = raw?.response?.headers?.get?.("x-next-cursor") || raw?.cursor || raw?.next || null;
    const { adaptOpencodeMessagesPage } = require("./runtime/opencode-conversation-adapter");
    return adaptOpencodeMessagesPage({
      items,
      sessionId: this.sessionId,
      cursor,
      complete: !cursor,
      before: opts.before || null,
    });
  }

  _failTurn(message, cause = null, opts = {}) {
    if (this._turnSettled) return false;
    if (!opts.force && this._shouldDeferTransientFailure(message, cause)) {
      this._scheduleTransientFailureRecovery(message, cause);
      return true;
    }
    this._invalidateEngineSessionAfterVisibleFailure(message, cause);
    if (cause) log.warn("opencode turn failed: %s", cause?.message || String(cause));
    this._clearIdleSettleTimer();
    this._clearIdleProbeTimer();
    this._pendingCompletePayload = null;
    this._clearDispatchFailureTimer();
    this._clearPromptDispatchPendingCheck();
    this._clearPromptAcceptanceCheck();
    this._clearTransientFailureTimer();
    this._clearResponseTimer();
    this._clearProgressNoticeTimer();
    this._clearHealthProbe();
    this._clearTurnWatchdog();
    this._clearPendingPermissions();
    resetOpencodeRuntimeState(this._eventState);
    this._subagentRuntime.reset();
    this._turnSettled = true;
    this.busy = false;
    this._pendingPromptPayload = null;
    this._promptDispatchPending = false;
    this._turnAcceptedEmitted = false;
    this._activeTaskContract = null;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    this._activeTools.clear();
    this._turnLiveness.resetProgressNotice();
    this._transientReplayCount = 0;
    this._turnStartedAt = 0;
    this._latestTodos = [];
    this._latestTodosSignature = "";
    this._todoCompletionGateAttempts = 0;
    this._orchestrator?.notifyRunnerError(this.sessionId, enrichPermissionFailureMessage({ message, cause, workspacePath: this.cwd || "" }));
    return false;
  }

  _invalidateEngineSessionAfterVisibleFailure(message, cause) {
    const raw = transientClassificationText(message, cause);
    const classified = require("./agent-runner").classifyAssistantError(raw);
    const recoverable = isVisibleFailureRecoverable(classified, raw, this.spawnOptions);
    const dropResume = shouldDropResumeAfterVisibleFailure({
      classified,
      raw,
      payload: this._pendingPromptPayload || {},
      wasResumed: Boolean(this._engineSessionWasResumed || this._server?.wasResumed),
    });
    if (!recoverable && !dropResume) return false;

    const server = this._server;
    if (server) {
      try {
        server.terminate?.();
      } catch {
        // best effort; the next turn can still construct a fresh view.
      }
      if (this._server === server) this._server = null;
    }
    this._starting = null;
    this._activeModelConfigFingerprint = "";

    if (!dropResume) return true;
    const previousResumeId = this.agentResumeId || server?.sessionID || "";
    this.agentResumeId = null;
    this._engineSessionWasResumed = false;
    this.emit("engine-session-invalidated", {
      reason: this._sanitize(raw || "recoverable engine failure"),
      errorCode: classified?.code || "",
      previousResumeId,
      resetResume: true,
    });
    return true;
  }

  _shouldDeferTransientFailure(message, cause) {
    if (!this.busy || this._turnSettled || !this._server) return false;
    if (!this._sawEngineEvent || this.collectedOutput.trim()) return false;
    if (!cause) return false;
    const raw = transientClassificationText(message, cause);
    const classified = require("./agent-runner").classifyAssistantError(raw);
    return isSafeReplayableModelFailure(classified, raw);
  }

  _onServerExit(code) {
    if (this.busy && !this._turnSettled) {
      this._failTurn(`The assistant engine stopped unexpectedly (code ${code}).`);
    }
    this._server = null;
    this._starting = null;
    this._activeModelConfigFingerprint = "";
  }

  /** The engine became unreachable (SSE gave up after retries, or a spawn error).
   *  Treat it as down: fail any in-flight turn so it can't hang, and drop the
   *  server so the next send spawns fresh and resumes the same session id. */
  _onServerError(err) {
    log.warn("server error: %s", err?.message || String(err));
    if (this.busy && !this._turnSettled) {
      const deferred = this._failTurn("The assistant engine became unreachable. Please retry.", err);
      if (deferred) return;
    }
    try { this._server?.terminate?.(); } catch { /* best effort */ }
    this._server = null;
    this._starting = null;
    this._activeModelConfigFingerprint = "";
  }

  // --- helpers -------------------------------------------------------------

  _ingest(drafts) {
    if (!this._orchestrator || !Array.isArray(drafts) || drafts.length === 0) return;
    this._orchestrator.ingest(this.sessionId, drafts);
  }

  _clearPendingPermissions() {
    for (const requestId of this._pendingPermissions.keys()) {
      this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    }
    this._pendingPermissions.clear();
    for (const requestId of this._pendingQuestions.keys()) {
      this._ingest([{ type: "user_question.resolved", payload: { requestId } }]);
    }
    this._pendingQuestions.clear();
  }

  // No-progress watchdog: re-armed on each progress action (see _handleEvent), so
  // it only fires after a full window with NO forward movement — a stuck/silent
  // turn — never during a long task that keeps progressing.
  _armResponseTimer() { this._turnLiveness.armResponseTimer(); }

  _clearResponseTimer() { this._turnLiveness.clearResponseTimer(); }

  _hasActiveToolLease() { return this._turnLiveness.hasActiveToolLease(); }

  _armTurnWatchdog() { this._turnLiveness.armTurnWatchdog(); }

  _clearTurnWatchdog() { this._turnLiveness.clearTurnWatchdog(); }

  _armProgressNoticeTimer() { this._turnLiveness.armProgressNoticeTimer(); }

  _clearProgressNoticeTimer() { this._turnLiveness.clearProgressNoticeTimer(); }

  _emitLongWaitNotice() { this._turnLiveness.emitLongWaitNotice(); }

  _genericToolProgressDetail() { return this._turnLiveness.genericToolProgressDetail(); }

  _emitGenericToolProgressNotice() { return this._turnLiveness.emitGenericToolProgressNotice(); }

  _forceEndTurn(reason) { this._turnLiveness.forceEndTurn(reason); }

  _armHealthProbe() { this._turnLiveness.armHealthProbe(); }

  _clearHealthProbe() { this._turnLiveness.clearHealthProbe(); }
  _sanitize(message) {
    return require("./agent-runner").sanitizeError(message);
  }

  _logFingerprint(value) {
    return String(value || "-").replace(/[\r\n\t]/g, " ").slice(0, 80);
  }
}

// Stall watchdog: how long with NO events at all before a turn is treated as
// stuck. It resets on every event (see _handleEvent), so this is a silence
// threshold, not a cap on turn length — it must outlast a single long, quiet
// tool (e.g. a multi-minute build/test). Override with LILY_OPENCODE_TURN_TIMEOUT_MS.
// No-PROGRESS window: how long with no meaningful action (text/thinking/tool
// activity) before a turn is treated as stuck and force-ended. It resets on every
// progress action — NOT on heartbeats — so a long task that keeps making progress
// (e.g. an hour of file conversion) runs to completion. A currently active
// foreground tool also gets a lease extension: slow is not failure, and the
// separate health probe + hard turn watchdog remain the backstops. A turn that's
// only pinging "busy" with no active tool is still caught.
OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS =
  Number(process.env.LILY_OPENCODE_TURN_TIMEOUT_MS) || 600_000;
// A tool that emitted "running" but never emits output/completion must not keep
// the whole turn alive forever. Keep this lease longer than the no-progress
// window: silent foreground tools are allowed one full watchdog extension before
// Lily treats the OpenCode tool state as orphaned. Override / disable (0) with
// LILY_OPENCODE_ACTIVE_TOOL_LEASE_MS.
OpencodeAgentSession.ACTIVE_TOOL_LEASE_MS =
  process.env.LILY_OPENCODE_ACTIVE_TOOL_LEASE_MS !== undefined
    ? Number(process.env.LILY_OPENCODE_ACTIVE_TOOL_LEASE_MS) || 0
    : Math.max(2 * OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS, 20 * 60_000);
// Shorter visible no-progress window. This only feeds the live process panel so
// users can see the engine is still alive while OpenCode is quiet.
OpencodeAgentSession.PROGRESS_NOTICE_MS =
  Number(process.env.LILY_OPENCODE_PROGRESS_NOTICE_MS) || 45_000;
// Optional administrative wall-clock cap. Production defaults to disabled:
// legitimate progress may continue for tens of hours, while the no-progress
// window, active-tool lease, health probe, step budget, depth cap and loop guard
// still bound stuck/runaway work. Deployments may opt into an absolute deadline.
OpencodeAgentSession.TURN_WATCHDOG_MS =
  process.env.LILY_OPENCODE_TURN_MAX_MS !== undefined
    ? Number(process.env.LILY_OPENCODE_TURN_MAX_MS) || 0
    : 0;
// Bounded official-history sync before declaring a no-progress turn stalled.
// This mirrors the official app's source-of-truth model without letting the
// watchdog itself hang on an unhealthy server.
OpencodeAgentSession.STALLED_HISTORY_SYNC_MS =
  Number(process.env.LILY_OPENCODE_STALLED_HISTORY_SYNC_MS) || 2_500;
// Mirrors OpenCode's own "confirm idle after events have drained" behavior:
// do not finalize on the same tick as session.idle, because late text deltas can
// still be queued behind it in the shared event stream.
OpencodeAgentSession.IDLE_SETTLE_MS =
  Number(process.env.LILY_OPENCODE_IDLE_SETTLE_MS) || 750;
// Recovery path for a missed/unroutable session.idle event. After meaningful
// progress, poll the authoritative OpenCode session status; if it is idle, sync
// the final answer from official history and settle. This is deliberately
// separate from the reducer: session.status alone remains a snapshot, but the
// runner can use it as a source-of-truth confirmation after real turn activity.
OpencodeAgentSession.IDLE_STATUS_PROBE_MS =
  Number(process.env.LILY_OPENCODE_IDLE_STATUS_PROBE_MS) || 2_500;
// promptAsync is fire-and-forget: a transport-level failure can be reported
// after OpenCode already accepted the turn. Wait briefly for SSE activity before
// telling the user the model connection failed.
OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS =
  Number(process.env.LILY_OPENCODE_DISPATCH_FAILURE_GRACE_MS) || 12_000;
// If a transient transport/server error arrives after the turn is already proven
// to have reached OpenCode, do not fail the UI immediately. The official session
// state/history is authoritative; poll briefly and either recover the completed
// assistant message or keep waiting for live events.
OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS =
  Number(process.env.LILY_OPENCODE_TRANSIENT_RECOVERY_POLL_MS) || 2_000;
OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS =
  Number(process.env.LILY_OPENCODE_TRANSIENT_RECOVERY_MS) || 120_000;
// Active health probe during a turn: poll every PROBE_MS, declare the engine dead
// only after MAX_FAILS consecutive failures (so a slow-but-healthy turn survives).
OpencodeAgentSession.HEALTH_PROBE_MS = Number(process.env.LILY_OPENCODE_HEALTH_PROBE_MS) || 30_000;
OpencodeAgentSession.HEALTH_MAX_FAILS = Number(process.env.LILY_OPENCODE_HEALTH_MAX_FAILS) || 3;

/**
 * Coerce the host's question response ({ answers, response? }) into OpenCode's
 * string[][] — one array of selected option labels per question, in order.
 * @param {{ answers?: unknown, response?: string }} response
 * @param {Array<{header?:string, question?:string}>} questions
 */
function toOpencodeAnswers(response, questions) {
  const ans = response && response.answers;
  return (questions || []).map((q, i) => {
    let v;
    if (Array.isArray(ans)) v = ans[i];
    else if (ans && typeof ans === "object") v = ans[q.header] ?? ans[q.question] ?? ans[i];
    if (v == null && response && response.response) v = response.response;
    if (Array.isArray(v)) return v.map(String);
    if (v == null || v === "") return [];
    return [String(v)];
  });
}

// Bound for pre-turn context compaction (model summarize call). Configurable via
// LILY_COMPACTION_TIMEOUT_MS; floored at 15s so a legit large summary is not cut
// short, defaulting to 90s. Past this we fail open and run the turn uncompacted.
function compactionTimeoutMs() {
  const raw = Number(process.env.LILY_COMPACTION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(15_000, raw) : 90_000;
}

// Await a promise but reject with `label` if it does not settle within timeoutMs.
// Used so a hung engine call degrades to a caught error (fail-open) instead of an
// unbounded await that freezes the turn.
async function runWithTimeout(promise, timeoutMs, label = "TIMEOUT") {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { OpencodeAgentSession, detectIncompleteDeliverable, runWithTimeout, compactionTimeoutMs };
