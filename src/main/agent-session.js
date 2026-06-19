"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { LineBuffer } = require("./line-buffer");
const {
  sanitizeError,
  classifyAssistantError,
  isUpstreamApiFailure,
} = require("./agent-runner");
const {
  buildUpdateEnvironmentVariablesRequest,
  buildControlAck,
  buildHookCallbackResponse,
  buildInterruptRequest,
  buildSetPermissionModeRequest,
  buildMcpToggleRequest,
} = require("./control-protocol");
const { CliEventAdapter } = require("./runtime/adapters/claude-cli-adapter");
const { normalizeAskUserQuestions } = require("./runtime/adapters/claude-event-normalizer");
const {
  compactCommand,
  isShellTool,
  isDetachedShellInput,
  looksLikeLongRunningShellCommand,
} = require("./runtime/runtime-activity");
const { buildUserMessagePayload, hasSendableContent } = require("./user-message");
const { buildAgentSpawnEnv } = require("./spawn-env");
const { detectCliCapabilities } = require("./cli-capabilities");
const { sameRespawnOptions } = require("./runner-spawn-options");
const { appendPermissionSpawnArgs } = require("./permission-spawn-args");
const {
  truncateToolResultForUi,
  processEventFromClaudeEvent,
} = require("./cli-process-payload");
const { sanitizeNoticeForIngest } = require("./engine-notice-policy");
const { TimerBank } = require("./turn-timers");
const { ToolLeaseTracker } = require("./tool-lease-tracker");
const { RuntimeLifecycleTracker } = require("./runtime-lifecycle-tracker");
const { DeferredResultGate } = require("./turn-settlement");
const { ApprovalBroker } = require("./approval-broker");
const { getLogger } = require("./logger");
const log = getLogger("agent-session");

const FATAL_STDERR_ERROR_CODES = new Set([
  "AUTH_FAILED",
  "BUDGET_EXCEEDED",
  "CONTEXT_LIMIT",
  "ENGINE_UNAVAILABLE",
  "MODEL_UNAVAILABLE",
  "PERMISSION_DENIED",
  "QUOTA_EXCEEDED",
  "SESSION_BUSY",
  "SESSION_INVALID",
]);

/**
 * One long-lived engine process per app session (`stream-json` protocol).
 * Multi-turn: each user message is one JSON line on stdin.
 */
class AgentSession extends EventEmitter {
  /**
   * @param {string} sessionId App session id (not the engine resume id).
   */
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    /** @type {import('child_process').ChildProcess | null} */
    this.process = null;
    this.cwd = null;
    this._lineBuffer = new LineBuffer();
    this.busy = false;
    this.collectedOutput = "";
    this.agentResumeId = null;
    this.spawnOptions = null;
    this.lastSpawnError = null;
    /** All watchdog timers live in one named bank (see turn-timers.js). */
    this._timers = new TimerBank();
    this._turnStartedAt = 0;
    this._turnHadToolUse = false;
    /** Lease-domain turn state lives in the tracker (see tool-lease-tracker.js). */
    this._leaseTracker = new ToolLeaseTracker({
      timers: this._timers,
      emitNotice: (notice) => this._emitEngineNotice(notice),
      isTurnLive: () => this.busy && !this._turnSettled,
      delays: () => ({
        noticeMs: AgentSession.TOOL_LONG_TASK_NOTICE_MS,
        heartbeatMs: AgentSession.TOOL_LONG_TASK_HEARTBEAT_MS,
      }),
    });
    this._lifecycleTracker = new RuntimeLifecycleTracker({
      timers: this._timers,
      emitNotice: (notice) => this._emitEngineNotice(notice),
      isTurnLive: () => this.busy && !this._turnSettled,
      heartbeatMs: () => AgentSession.RUNTIME_LIFECYCLE_HEARTBEAT_MS,
    });
    this._sawStdoutForTurn = false;
    this._messageStopObserved = false;
    this._turnSettled = true;
    /** User-blocking control surface: permissions/questions/hooks (see approval-broker.js). */
    this._approvals = new ApprovalBroker({
      writeControl: (payload) => this._writeControlLine(payload),
      ingest: (drafts) => this._ingestRuntime(drafts),
      emitNotice: (notice) => this._emitEngineNotice(notice),
      onBlockingRequest: () => {
        this._turnHadToolUse = true;
        this._clearIdleTimer();
      },
      onActivity: () => this._markStreamActivity(),
      pollGate: () => this._resultGate.poll(),
      permissionMode: () => this.spawnOptions?.permissionMode || "default",
      timeoutMs: () => AgentSession.PERMISSION_UI_TIMEOUT_MS,
      normalizeQuestions: normalizeAskUserQuestions,
    });
    this._cliInitialized = false;
    this._interruptPending = false;
    /** @type {string | null} */
    this._streamParentToolUseId = null;
    this._cliInfo = null;
    /** @type {Map<string, string>} — accumulated partial_json per tool_use id */
    this._streamingToolInputs = new Map();
    /** @type {Set<string>} — tool_use ids already emitted from content_block_start */
    this._emittedToolIds = new Set();
    /** @type {Map<number, string>} — content block index → tool_use id */
    this._blockIndexToToolId = new Map();
    this._internalCommand = null;
    /** Holds a CLI `result` until blocking work settles (see turn-settlement.js). */
    this._resultGate = new DeferredResultGate({
      timers: this._timers,
      graceMs: () => AgentSession.DEFERRED_TURN_RESULT_GRACE_MS,
      isTurnLive: () => this.busy && !this._turnSettled,
      hasBlockers: () => this._hasPendingRuntimeBlockers(),
      release: (payload) => this._completeTurn(payload),
      onStaleRelease: () => {
        log.warn("turn result completed with stale pending runtime blockers", {
          sessionId: this.sessionId,
          pendingTools: this._leaseTracker.pendingIds(),
          pendingPermissions: this._approvals.permissionIds(),
          pendingHooks: this._approvals.hookIds(),
        });
      },
      onCleanRelease: () => {},
    });
    this._lastActualUsage = null;
    this._usageRecordedForTurn = false;
    this._runtimeAdapter = new CliEventAdapter();
    this._orchestrator = null;
  }

  bindOrchestrator(orchestrator) {
    this._orchestrator = orchestrator;
  }

  _ingestRuntime(drafts) {
    if (!this._orchestrator || !Array.isArray(drafts) || drafts.length === 0) return;
    this._orchestrator.ingest(this.sessionId, drafts);
  }

  _recordActualUsage(usage) {
    if (this._usageRecordedForTurn || !usage || typeof usage !== "object") return;
    const totals = require("./usage-reporter").recordModelUsage(this.sessionId, usage);
    if (totals.inputTokens > 0 || totals.outputTokens > 0) {
      this._usageRecordedForTurn = true;
    }
  }

  /**
   * Pure-text fallback if the CLI never sends `result`. Generous on purpose:
   * a model pausing between messages while generating long content (e.g. a
   * full chapter) legitimately goes quiet for tens of seconds, and completing
   * early would DROP the content it is about to stream. A genuinely lost
   * `result` is rare and still recovers within this window; any resumed
   * output cancels the timer, so the window only bites on permanent silence.
   */
  static QUIESCE_MS = 180_000;
  static INTERRUPT_FALLBACK_MS = 2_000;
  static PERMISSION_UI_TIMEOUT_MS = 55_000;
  static TURN_RESPONSE_TIMEOUT_MS = 90_000;
  static RESUME_TURN_TIMEOUT_MS = 45_000;
  /** User-visible notice before timeout, not a failure. */
  static FIRST_RESPONSE_NOTICE_MS = 10_000;
  static LONG_WAIT_NOTICE_MS = 30_000;
  /** Hard cap — verbose logs must not extend a turn forever. */
  static TURN_ABSOLUTE_MAX_MS = 30 * 60_000;
  /** Poll while deferred CLI `result` waits for pending tools/permissions. */
  static DEFERRED_TURN_RESULT_GRACE_MS = 1_500;
  /** Wait after message_stop for a trailing `result` (or a follow-up message)
   * before the pure-text fallback. Generous so a multi-message turn — e.g.
   * "OK, continuing" then a long chapter — is never cut between messages. */
  static MESSAGE_STOP_GRACE_MS = 180_000;
  /** Long-running foreground shell commands need visible user feedback. */
  static TOOL_LONG_TASK_NOTICE_MS = 30_000;
  static TOOL_LONG_TASK_HEARTBEAT_MS = 5 * 60_000;
  static RUNTIME_LIFECYCLE_HEARTBEAT_MS = 60_000;

  _clearIdleTimer() {
    this._timers.clear("idle");
  }

  _clearInterruptFallback() {
    this._timers.clear("interruptFallback");
    this._interruptPending = false;
  }

  _clearTurnResponseTimer() {
    this._timers.clear("turnResponse");
  }

  _clearAbsoluteTurnTimer() {
    this._timers.clear("absoluteTurn");
  }

  _clearDeferredTurnResultTimer() {
    this._timers.clear("deferredResult");
  }

  _clearMessageStopTimer() {
    this._timers.clear("messageStop");
  }

  _clearWaitNoticeTimers() {
    this._timers.clear("firstResponseNotice");
    this._timers.clear("longWaitNotice");
  }

  _clearToolLeaseNoticeTimer(toolId) {
    this._timers.clear(`lease:${toolId}`);
  }

  _clearToolLeaseNoticeTimers() {
    this._timers.clearPrefix("lease:");
  }

  /** End a stuck turn quietly — unlock UI without scary error bubbles. */
  _recoverStalledTurn(reason) {
    log.warn("turn stalled, recovering quietly: %s", reason, {
      sessionId: this.sessionId,
    });
    this._flushLineBuffer();
    this._completeTurn({
      code: 0,
      output: this.collectedOutput.trim(),
      stalled: true,
    });
  }

  _armAbsoluteTurnTimer() {
    this._clearAbsoluteTurnTimer();
    if (!this.busy || this._turnSettled) return;
    this._timers.arm("absoluteTurn", AgentSession.TURN_ABSOLUTE_MAX_MS, () => {
      if (!this.busy || this._turnSettled) return;
      if (this._hasBlockingTurnWork()) {
        this._emitBlockingWorkHeartbeat("absolute-timeout");
        this._armAbsoluteTurnTimer();
        return;
      }
      this._recoverStalledTurn("absolute");
    });
  }

  _armTurnResponseTimer() {
    this._clearTurnResponseTimer();
    if (!this.busy || this._turnSettled) return;
    const ms = this.agentResumeId
      ? AgentSession.RESUME_TURN_TIMEOUT_MS
      : AgentSession.TURN_RESPONSE_TIMEOUT_MS;
    this._timers.arm("turnResponse", ms, () => {
      if (!this.busy || this._turnSettled) return;
      this._emitEngineNotice({
        code: "longWait",
        level: "progress",
        panel: true,
        replace: true,
        reason: "silence",
      });
      this._armTurnResponseTimer();
    });
  }

  _clearPendingPermissions(notifyCancel = false) {
    this._approvals.clearPermissions(notifyCancel);
  }

  _clearPendingHooks(notifyCancel = false) {
    this._approvals.clearHooks(notifyCancel);
  }

  _canAutoCompleteTurn() {
    return (
      this.busy &&
      !this._turnSettled &&
      !this._leaseTracker.hadBlockingToolUse() &&
      this._leaseTracker.pendingCount() === 0 &&
      this._lifecycleTracker.pendingCount() === 0 &&
      this._approvals.permissionCount() === 0 &&
      this._approvals.hookCount() === 0
    );
  }

  // After the CLI emits message_stop (assistant message finished), a turn
  // with no *currently* pending work should settle even if it used tools
  // earlier — otherwise a missing/late `result` event leaves the UI locked
  // while the files are already written. Unlike _canAutoCompleteTurn this
  // ignores the historical hadBlockingToolUse flag.
  _canSettleAfterMessageStop() {
    return (
      this.busy &&
      !this._turnSettled &&
      !this._hasPendingRuntimeBlockers() &&
      this._lifecycleTracker.pendingCount() === 0
    );
  }

  _hasBlockingTurnWork() {
    return (
      this._leaseTracker.pendingCount() > 0 ||
      this._lifecycleTracker.pendingCount() > 0 ||
      this._approvals.permissionCount() > 0 ||
      this._approvals.hookCount() > 0
    );
  }

  _hasPendingRuntimeBlockers() {
    return (
      this._leaseTracker.pendingCount() > 0 ||
      this._approvals.permissionCount() > 0 ||
      this._approvals.hookCount() > 0
    );
  }

  _deferTurnResult(payload, reason) {
    log.warn("turn result deferred until pending runtime blockers settle: %s", reason, {
      sessionId: this.sessionId,
      pendingTools: this._leaseTracker.pendingCount(),
      pendingRuntime: this._lifecycleTracker.pendingCount(),
      pendingPermissions: this._approvals.permissionCount(),
      pendingHooks: this._approvals.hookCount(),
    });
    this._resultGate.defer(payload);
  }

  _armDeferredTurnResultTimer() {
    this._resultGate.armPoll();
  }

  _maybeCompleteDeferredTurnResult() {
    return this._resultGate.poll();
  }

  _markRuntimeLifecycleActivity(activity) {
    const result = this._lifecycleTracker.ingestActivity(activity);
    if (!result.changed) return;
    this._clearIdleTimer();
    this._clearMessageStopTimer();
    if (result.active) {
      this._armDeferredTurnResultTimer();
      return;
    }
    this._maybeCompleteDeferredTurnResult();
    if (this._messageStopObserved) this._armMessageStopCompletionTimer();
  }

  _isShellTool(name) {
    return isShellTool(name);
  }

  _isDetachedShellInput(name, input = {}) {
    return isDetachedShellInput(name, input);
  }

  _looksLikeLongRunningShellCommand(command) {
    return looksLikeLongRunningShellCommand(command);
  }

  _emitDetachedShellNotice(toolId, name, input = {}) {
    const detail = compactCommand(input).slice(0, 160);
    this._emitEngineNotice({
      code: "shellDetached",
      level: "progress",
      panel: true,
      replace: true,
      done: true,
      toolName: name,
      detail,
    });
    this._ingestRuntime([{
      type: "tool.done",
      payload: {
        id: toolId,
        status: "done",
        result: {
          content: detail
            ? `Command is running in the background: ${detail}`
            : "Command is running in the background.",
          truncated: false,
          detached: true,
        },
      },
    }]);
  }

  _emitBlockingWorkHeartbeat(reason = "long-running") {
    this._leaseTracker.emitBlockingWorkHeartbeat(reason);
  }

  _trackToolLease(toolId, name, input = {}) {
    return this._leaseTracker.track(toolId, name, input);
  }

  _updateToolLeaseInput(toolId, input = {}) {
    return this._leaseTracker.updateInput(toolId, input);
  }

  _finishToolLease(toolId) {
    this._leaseTracker.finish(toolId);
  }

  _tryParseToolInputJson(toolId) {
    if (!toolId) return null;
    const raw = this._streamingToolInputs.get(toolId);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  _armIdleCompletionTimer() {
    this._clearIdleTimer();
    if (!this._canAutoCompleteTurn()) return;
    if (!this.collectedOutput.trim()) return;
    this._timers.arm("idle", AgentSession.QUIESCE_MS, () => {
      if (!this._canAutoCompleteTurn()) return;
      if (!this.collectedOutput.trim()) return;
      log.warn("turn completed via idle quiesce (no result event)");
      this._flushLineBuffer();
      this._completeTurn({
        code: 0,
        output: this.collectedOutput.trim(),
        idle: true,
      });
    });
  }

  _armMessageStopCompletionTimer() {
    this._clearMessageStopTimer();
    if (!this._canSettleAfterMessageStop()) return;
    this._timers.arm("messageStop", AgentSession.MESSAGE_STOP_GRACE_MS, () => {
      if (!this._canSettleAfterMessageStop()) return;
      this.emit("message-stop-grace", {
        output: this.collectedOutput.trim(),
      });
    });
  }

  completeFromHost(reason = "host-finalized") {
    if (!this.busy || this._turnSettled) return false;
    this._flushLineBuffer();
    this._completeTurn({
      code: 0,
      output: this.collectedOutput.trim(),
      idle: true,
      reason,
    });
    return true;
  }

  _markStreamActivity() {
    if (!this.busy || this._turnSettled) return;
    // Fresh stream output means the turn isn't actually finished — cancel the
    // message_stop grace fallback; a later message_stop re-arms it.
    this._clearMessageStopTimer();
    this._clearWaitNoticeTimers();
    this._armTurnResponseTimer();
    this._armIdleCompletionTimer();
  }

  _armWaitNoticeTimers() {
    this._clearWaitNoticeTimers();
    if (!this.busy || this._turnSettled) return;
    this._timers.arm("firstResponseNotice", AgentSession.FIRST_RESPONSE_NOTICE_MS, () => {
      if (!this.busy || this._turnSettled || this.collectedOutput.trim()) return;
      this._emitEngineNotice({
        code: "waitingForFirstResponse",
        level: "progress",
        panel: true,
        replace: true,
      });
    });
    this._timers.arm("longWaitNotice", AgentSession.LONG_WAIT_NOTICE_MS, () => {
      if (!this.busy || this._turnSettled || this.collectedOutput.trim()) return;
      this._emitEngineNotice({
        code: "longWait",
        level: "progress",
        panel: true,
        replace: true,
      });
    });
  }

  isBusy() {
    return this.busy;
  }

  isAlive() {
    return this.process != null && !this.process.killed;
  }

  /**
   * @param {string} cwd
   * @param {{ agentCommand: string, permissionMode: string, disallowedTools?: string[], stagingDir?: string, resumeSessionId?: string | null, configDir?: string }} options
   */
  ensureProcess(cwd, options, callOpts = {}) {
    if (!cwd || !options?.agentCommand) {
      throw new Error("RUNNER_MISSING_ARGS");
    }
    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }
    if (!fs.existsSync(options.agentCommand)) {
      throw new Error(`Assistant engine not found: ${options.agentCommand}`);
    }

    if (options.resumeSessionId && !this.agentResumeId) {
      this.agentResumeId = options.resumeSessionId;
    }

    const spawnOpts = {
      agentCommand: options.agentCommand,
      permissionMode: options.permissionMode,
      disallowedTools: options.disallowedTools,
      stagingDir: options.stagingDir,
      configDir: options.configDir,
    };
    this._setCliInfo(detectCliCapabilities(options.agentCommand));

    if (this.isAlive() && this.cwd === cwd && this.spawnOptions) {
      if (sameRespawnOptions(this.spawnOptions, spawnOpts)) {
        this.spawnOptions = { ...this.spawnOptions, ...spawnOpts };
        return;
      }
    }

    this.terminate();
    this.cwd = cwd;
    this.spawnOptions = spawnOpts;
    if (callOpts.lazy) return;
    this._spawn();
  }

  _setCliInfo(info) {
    this._cliInfo = info || null;
    this._runtimeAdapter = new CliEventAdapter({
      cliVersion: info?.version || null,
      versionText: info?.versionText || "",
      capabilities: info?.capabilities || {},
    });
  }

  _spawn() {
    const opts = this.spawnOptions;
    const args = [
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--prompt-suggestions",
      "true",
    ];
    appendPermissionSpawnArgs(args, opts.permissionMode);
    args.push("--permission-prompt-tool", "stdio");

    if (opts.disallowedTools?.length) {
      args.push("--disallowed-tools", ...opts.disallowedTools);
    }
    const { learnedSkillsInboxDir } = require("./learned-skills");
    const skillInbox = learnedSkillsInboxDir();
    if (fs.existsSync(skillInbox)) {
      args.push("--add-dir", skillInbox);
    }
    if (opts.stagingDir && fs.existsSync(opts.stagingDir)) {
      args.push("--add-dir", opts.stagingDir);
    }
    if (this.agentResumeId) {
      args.push("--resume", this.agentResumeId);
    }
    // Register the bundled @playwright/mcp server, if (and only if) the platform
    // runtime bundle actually carries it. Gated on existence → a hard no-op on
    // builds without the browser runtime, so this never affects current sessions.
    try {
      const { bundleRuntimeDir } = require("./bundle-locator");
      const { writeActiveMcpConfig } = require("./mcp-config");
      const { mcpConfigPath } = require("./config");
      const runtimeDir = bundleRuntimeDir();
      // Registers playwright (when its bundle exists) AND the mail connector
      // (when the bridge is up) — so run even without a runtime bundle.
      const written = writeActiveMcpConfig(runtimeDir || "", mcpConfigPath());
      if (written) args.push("--mcp-config", written);
    } catch {
      /* MCP is an enhancement; never block engine spawn on it */
    }

    this.lastSpawnError = null;
    this.process = spawn(opts.agentCommand, args, {
      cwd: this.cwd,
      env: buildAgentSpawnEnv({ configDir: opts.configDir || undefined }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this._lineBuffer.reset();
    this.collectedOutput = "";
    this._turnSettled = true;
    this._cliInitialized = false;
    this._clearIdleTimer();
    this._clearInterruptFallback();
    this._clearWaitNoticeTimers();

    this.process.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.process.stderr.on("data", (chunk) => {
      this._handleStderr(chunk.toString());
    });
    this.process.stdin.on("error", (err) => {
      this._handleStdinWriteError(err, "stdin-error");
    });

    this.process.on("error", (err) => {
      const msg = sanitizeError(err.message);
      this.lastSpawnError = msg;
      if (this.busy && !this._turnSettled) {
        this._failTurn(msg);
      } else {
        this.busy = false;
        this.process = null;
      }
    });

    this.process.on("close", (code) => {
      const wasInterrupt = this._interruptPending;
      this._clearInterruptFallback();
      if (this.busy && !this._turnSettled) {
        this._flushLineBuffer();
        this._completeTurn({
          code,
          output: this.collectedOutput.trim(),
          interrupted: wasInterrupt,
          interruptedByUser: wasInterrupt,
          source: "process.close",
          exitCode: code,
        });
      } else {
        this.busy = false;
      }
      this.process = null;
      this._cliInitialized = false;
    });
  }

  _ensureAliveForSend() {
    if (this.isAlive()) return;
    if (this.cwd && this.spawnOptions) {
      this._spawn();
      return;
    }
    throw new Error("RUNNER_NOT_READY");
  }

  /**
   * @param {{ text?: string, files?: Array<Record<string, unknown>> }} payload
   */
  /**
   * Runner I/O boundary: serialize one user message and write it to Claude CLI stdin.
   * TurnOrchestrator owns turnId, queue, transcript, and terminal events; this method
   * owns the child process (busy flag, stdin write, CLI timeouts, tool leases).
   */
  sendUserMessage(payload) {
    if (this.busy) {
      this._orchestrator?.notifyRunnerError(this.sessionId, "BUSY");
      return false;
    }

    const text = typeof payload === "string" ? payload : payload?.text;
    const files = typeof payload === "object" && payload?.files ? payload.files : [];

    if (!hasSendableContent(text, files)) return false;

    try {
      this._ensureAliveForSend();
    } catch (err) {
      this._orchestrator?.notifyRunnerError(this.sessionId, sanitizeError(err.message));
      return false;
    }

    this.busy = true;
    this._turnSettled = false;
    this._turnStartedAt = Date.now();
    this.collectedOutput = "";
    this._streamParentToolUseId = null;
    this._leaseTracker.reset();
    this._turnHadToolUse = false;
    this._sawStdoutForTurn = false;
    this._messageStopObserved = false;
    this._resultGate.clear();
    this._lastActualUsage = null;
    this._usageRecordedForTurn = false;
    this._clearDeferredTurnResultTimer();
    this._clearPendingPermissions(true);
    this._streamingToolInputs.clear();
    this._emittedToolIds.clear();
    this._blockIndexToToolId.clear();
    this._ingestRuntime([{ type: "turn.accepted", payload: { status: "thinking" } }]);
    this._armWaitNoticeTimers();

    const userPayload = buildUserMessagePayload({
      text,
      files,
      sessionId: this.agentResumeId,
      parentToolUseId: this._streamParentToolUseId,
    });
    if (!userPayload) {
      this._failTurn("Message content is empty.");
      return false;
    }

    const line = `${JSON.stringify(userPayload)}\n`;
    const writeResult = this._writeStdinLine(line, "user-message");
    if (!writeResult.ok) {
      this._failTurn("Assistant connection has been lost. Please retry.");
      return false;
    }
    this._armTurnResponseTimer();
    this._armAbsoluteTurnTimer();
    return true;
  }

  respondPermission(requestId, decision) {
    return this._approvals.respondPermission(requestId, decision);
  }

  respondUserQuestion(requestId, payload = {}) {
    return this._approvals.respondUserQuestion(requestId, payload);
  }

  cancelPermissionRequest(requestId) {
    return this._approvals.cancelPermission(requestId);
  }

  /**
   * @param {Record<string, string>} variables
   */
  updateEnvironmentVariables(variables) {
    if (!variables || typeof variables !== "object") return false;
    const entries = Object.entries(variables).filter(([, v]) => v != null && v !== "");
    if (entries.length === 0) return true;
    if (!this.isAlive()) return true;
    return this._writeControlLine(
      buildUpdateEnvironmentVariablesRequest(Object.fromEntries(entries)),
    );
  }

  /**
   * @param {string} mode
   */
  setPermissionMode(mode) {
    if (!mode || !this.spawnOptions) return false;
    if (this.spawnOptions.permissionMode === mode) return true;
    this.spawnOptions.permissionMode = mode;
    if (!this.isAlive()) return true;
    return this._writeControlLine(buildSetPermissionModeRequest(mode));
  }

  /**
   * Enable/disable an MCP server mid-session (CLI `mcp_toggle`) — lets the host
   * scope the active tool set to the relevant learned system without respawning.
   * @param {string} serverName
   * @param {boolean} enabled
   */
  setMcpServerEnabled(serverName, enabled) {
    if (!serverName || !this.isAlive()) return false;
    return this._writeControlLine(buildMcpToggleRequest(serverName, enabled));
  }

  reloadSkills() {
    if (!this.isAlive() || this.busy || this._internalCommand) return false;
    const payload = buildUserMessagePayload({ text: "/reload-skills" });
    if (!payload) return false;
    this._internalCommand = "reload-skills";
    this._writeControlLine(payload);
    this._timers.arm("internalCommand", 10_000, () => {
      this._internalCommand = null;
    });
    return true;
  }

  interrupt() {
    this._denyAllPendingPermissions("Session interrupted");
    this._clearPendingHooks(true);

    if (this.busy && !this._turnSettled && this.isAlive()) {
      this._interruptPending = true;
      this._writeControlLine(buildInterruptRequest());
      this._timers.arm("interruptFallback", AgentSession.INTERRUPT_FALLBACK_MS, () => {
        if (this.busy && !this._turnSettled) {
          log.warn("interrupt control timed out; ending turn and restarting CLI");
          this._completeTurn({
            code: null,
            output: this.collectedOutput.trim(),
            interrupted: true,
            interruptedByUser: true,
            source: "interrupt.timeout",
          });
          this.terminate();
        }
      });
      return;
    }

    if (this.busy && !this._turnSettled) {
      this._completeTurn({
        code: null,
        output: this.collectedOutput.trim(),
        interrupted: true,
        interruptedByUser: true,
        source: "interrupt.local",
      });
    }
  }

  terminate() {
    this._clearIdleTimer();
    this._clearInterruptFallback();
    this._denyAllPendingPermissions("Session ended");
    this._clearPendingPermissions(true);
    this._clearPendingHooks(true);
    this._clearToolLeaseNoticeTimers();
    this._clearWaitNoticeTimers();
    this._clearInternalCommandTimer();
    this._leaseTracker.reset();
    this._lifecycleTracker.reset();
    this._turnHadToolUse = false;
    this._resultGate.clear();
    if (!this.process) {
      this.cwd = null;
      this.spawnOptions = null;
      this._lineBuffer.reset();
      this.collectedOutput = "";
    this._lastActualUsage = null;
    this._usageRecordedForTurn = false;
    this._messageStopObserved = false;
    this.busy = false;
      this._turnSettled = true;
      return;
    }
    try {
      this.process.kill("SIGTERM");
    } catch {
      log.warn("terminate kill failed (process already dead)");
    }
    this.busy = false;
    this._turnSettled = true;
    this.process = null;
    this._cliInitialized = false;
    this.cwd = null;
    this.spawnOptions = null;
    this._lineBuffer.reset();
    this.collectedOutput = "";
    this._lastActualUsage = null;
    this._usageRecordedForTurn = false;
  }

  _completeTurn(payload) {
    if (this._turnSettled) return;
    this._recordActualUsage(this._lastActualUsage);
    this._clearIdleTimer();
    this._clearTurnResponseTimer();
    this._clearAbsoluteTurnTimer();
    this._clearMessageStopTimer();
    this._clearDeferredTurnResultTimer();
    this._clearInterruptFallback();
    this._clearToolLeaseNoticeTimers();
    this._clearWaitNoticeTimers();
    this._clearInternalCommandTimer();
    this._clearPendingPermissions(true);
    this._clearPendingHooks(true);
    this._leaseTracker.reset();
    this._lifecycleTracker.reset();
    this._turnHadToolUse = false;
    this._resultGate.clear();
    this._lastActualUsage = null;
    this._usageRecordedForTurn = false;
    this._messageStopObserved = false;
    this._streamParentToolUseId = null;
    this._streamingToolInputs.clear();
    this._emittedToolIds.clear();
    this._blockIndexToToolId.clear();
    this._turnSettled = true;
    this.busy = false;
    this._orchestrator?.notifyRunnerDone(this.sessionId, payload);
  }

  _failTurn(message) {
    if (this._turnSettled) return;
    this._recordActualUsage(this._lastActualUsage);
    this._clearIdleTimer();
    this._clearMessageStopTimer();
    this._clearTurnResponseTimer();
    this._clearAbsoluteTurnTimer();
    this._clearDeferredTurnResultTimer();
    this._clearInterruptFallback();
    this._clearToolLeaseNoticeTimers();
    this._clearWaitNoticeTimers();
    this._clearInternalCommandTimer();
    this._clearPendingPermissions(true);
    this._clearPendingHooks(true);
    this._leaseTracker.reset();
    this._lifecycleTracker.reset();
    this._resultGate.clear();
    this._lastActualUsage = null;
    this._usageRecordedForTurn = false;
    this._messageStopObserved = false;
    this._turnHadToolUse = false;
    this._streamParentToolUseId = null;
    this._streamingToolInputs.clear();
    this._emittedToolIds.clear();
    this._blockIndexToToolId.clear();
    this._turnSettled = true;
    this.busy = false;
    this._orchestrator?.notifyRunnerError(this.sessionId, message);
  }

  _onStdout(chunk) {
    for (const line of this._lineBuffer.push(chunk)) {
      this._handleLine(line);
    }
  }

  _refreshRemoteConfigAfterUpstreamFailure() {
    try {
      require("./remote-config")
        .refreshRemoteConfig({ reason: "upstream_api_failure" })
        .catch((err) => log.warn("remote config refresh after upstream failure failed: %s", err?.message || err));
    } catch (err) {
      log.warn("remote config refresh after upstream failure unavailable: %s", err?.message || err);
    }
  }

  _handleStderr(raw) {
    const text = sanitizeError(raw);
    const { isResumeFailureMessage } = require("./session-engine-recovery");
    const classified = classifyAssistantError(raw);

    // Resume failures are fatal — the engine can't recover its session state.
    if (
      this.busy &&
      !this._turnSettled &&
      this.agentResumeId &&
      isResumeFailureMessage(raw)
    ) {
      this.emit("resume-invalid", { message: raw });
      this._failTurn("Session connection has been refreshed. Please resend this message.");
      return;
    }

    // Only set lastSpawnError on errors that look fatal, not every stderr line.
    if (classified || isResumeFailureMessage(raw)) {
      this.lastSpawnError = text;
    }

    this._ingestRuntime([{ type: "engine.stderr", payload: { text } }]);

    if (
      this.busy &&
      !this._turnSettled &&
      classified &&
      FATAL_STDERR_ERROR_CODES.has(classified.code)
    ) {
      this._emitEngineNotice({
        code: "upstreamApiFailure",
        level: "warning",
        message: text,
        panel: true,
        toast: true,
        done: true,
      });
      this._refreshRemoteConfigAfterUpstreamFailure();
      this._failTurn(text);
      this.terminate();
      return;
    }

    // Upstream API failures on stderr are often transient.
    // Let the engine retry internally; only fail if it produces an error on stdout
    // or exits with a non-zero code. This avoids killing the engine on every
    // network hiccup, which forces a cold restart and loses context.
    if (this.busy && !this._turnSettled && isUpstreamApiFailure(raw)) {
      this._emitEngineNotice({
        code: "upstreamApiFailure",
        level: "warning",
        message: text,
        panel: true,
        toast: true,
        done: true,
      });
      this._refreshRemoteConfigAfterUpstreamFailure();
      // Do NOT terminate the engine here — let it attempt internal recovery.
      return;
    }

    this._emitEngineNotice({
      code: "stderr",
      level: "warning",
      message: text,
      panel: true,
      toast: true,
      done: true,
    });
  }

  _flushLineBuffer() {
    const line = this._lineBuffer.flush();
    if (line) this._handleLine(line);
  }

  _handleStdinWriteError(err, context) {
    const message = sanitizeError(err?.message || "Assistant connection has been lost.");
    log.warn("stdin write failed (%s): %s", context, err?.message || err);
    this.lastSpawnError = message;
    if (this.busy && !this._turnSettled) {
      this._failTurn(message);
    }
  }

  _writeStdinLine(line, context) {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed) {
      log.warn("stdin line skipped: stdin unavailable (%s)", context);
      return { ok: false };
    }
    try {
      const wrote = stdin.write(line, (err) => {
        if (err) this._handleStdinWriteError(err, context);
      });
      if (!wrote && typeof stdin.once === "function") {
        stdin.once("drain", () => {});
      }
      return { ok: true };
    } catch (err) {
      this._handleStdinWriteError(err, context);
      return { ok: false };
    }
  }

  _writeControlLine(payload) {
    return this._writeStdinLine(`${JSON.stringify(payload)}\n`, "control-line").ok;
  }

  _clearInternalCommandTimer() {
    this._timers.clear("internalCommand");
    this._internalCommand = null;
  }

  _denyAllPendingPermissions(message) {
    this._approvals.denyAllPermissions(message);
  }

  _noteStreamContext(ev) {
    if (ev.parent_tool_use_id != null && ev.parent_tool_use_id !== "") {
      this._streamParentToolUseId = String(ev.parent_tool_use_id);
    }
  }

  _allowToolUse(requestId, input) {
    this._approvals.allowToolUse(requestId, input);
  }

  _handleHookPreToolUse(action) {
    this._approvals.handleHookPreToolUse(action);
  }

  _handleHookStop(action) {
    this._approvals.handleHookStop(action);
  }

  _handleHookInfoOnly(action) {
    this._approvals.handleHookInfoOnly(action);
  }

  respondHook(requestId, decision) {
    return this._approvals.respondHook(requestId, decision);
  }

  _handleCanUseTool(canUse) {
    this._approvals.handleCanUseTool(canUse, log);
  }

  _handleAskUserQuestion(canUse) {
    this._approvals.handleAskUserQuestion(canUse);
  }

  _handleUserInputRequest(action) {
    this._approvals.handleUserInputRequest(action);
  }

  _emitEngineNotice(notice) {
    if (!notice) return;
    notice = sanitizeNoticeForIngest(notice);
    if (notice.code === "permissionTimeout") {
      this._ingestRuntime([
        {
          type: "permission.timeout",
          payload: {
            requestId: notice.requestId || "",
            toolName: notice.toolName || "",
            notice,
          },
        },
        { type: "engine.warning", payload: { notice } },
      ]);
      return;
    }
    const type = notice.level === "warning" ? "engine.warning" : "engine.notice";
    this._ingestRuntime([{ type, payload: { notice } }]);
  }

  _handleTurnResult(ev) {
    this._clearMessageStopTimer();
    this._flushLineBuffer();
    if (ev.modelUsage && typeof ev.modelUsage === "object") {
      this._recordActualUsage(ev.modelUsage);
      this._ingestRuntime([{ type: "usage.updated", payload: { usage: ev.modelUsage } }]);
    }
    const resultText = ev.subtype === "success" && ev.result
      ? String(ev.result).trim()
      : "";
    const resultFailed =
      Boolean(ev.is_error) ||
      (typeof ev.subtype === "string" && ev.subtype.startsWith("error"));
    const rawError = [
      typeof ev.error === "string" ? ev.error : "",
      typeof ev.message === "string" ? ev.message : "",
      Array.isArray(ev.errors) ? ev.errors.join("\n") : "",
      typeof ev.subtype === "string" && ev.subtype.startsWith("error") ? ev.subtype : "",
    ].filter(Boolean).join("\n");
    const output =
      resultText ||
      this.collectedOutput.trim() ||
      (rawError ? sanitizeError(rawError) : "");
    const payload = {
      code: resultFailed ? 1 : 0,
      output,
      error: resultFailed ? rawError : "",
      resultSubtype: ev.subtype || "",
      resultFromCli: true,
      interrupted: Boolean(this._interruptPending),
      interruptedByUser: Boolean(this._interruptPending),
      engineInterrupted: Boolean(ev.interrupted && !this._interruptPending),
      source: "cli.result",
      durationMs: Number(ev.duration_ms) || undefined,
      totalCostUsd: Number(ev.total_cost_usd) || undefined,
    };
    if (this._hasPendingRuntimeBlockers()) {
      this._deferTurnResult(payload, "result-before-work-finished");
      return;
    }
    this._lifecycleTracker.completeAll();
    this._completeTurn(payload);
  }

  _handleRuntimeError(ev) {
    const errMsg =
      (ev.error && typeof ev.error === "object" ? ev.error.message : "") ||
      ev.message ||
      "";
    log.warn("CLI error event: %s", errMsg || JSON.stringify(ev).slice(0, 200));
    if (this.busy && !this._turnSettled) {
      const { isResumeFailureMessage } = require("./session-engine-recovery");
      if (this.agentResumeId && isResumeFailureMessage(errMsg)) {
        this.emit("resume-invalid", { message: errMsg });
        this._failTurn("Session connection has been refreshed. Please resend this message.");
        return;
      }
      this._failTurn(sanitizeError(errMsg || "Engine error"));
      return;
    }
    if (errMsg) {
      this._emitEngineNotice({
        code: "engineError",
        level: "warning",
        panel: true,
        toast: true,
        done: true,
        detail: sanitizeError(errMsg),
      });
    }
  }

  _trackRuntimeLifecycleHook(action) {
    const result = this._lifecycleTracker.ingestHook(action);
    if (!result.changed) return;
    this._clearIdleTimer();
    this._clearMessageStopTimer();
    if (result.active) {
      this._armDeferredTurnResultTimer();
      return;
    }
    this._maybeCompleteDeferredTurnResult();
    if (this._messageStopObserved) this._armMessageStopCompletionTimer();
  }

  _handleNormalizedAction(action) {
    this._trackRuntimeLifecycleHook(action);
    switch (action.kind) {
      case "system_notice":
        if (action.subtype === "init") {
          this._cliInitialized = true;
          if (action.sessionId && this.agentResumeId !== action.sessionId) {
            this.agentResumeId = action.sessionId;
          }
        }
        if (action.subtype === "thinking_tokens") {
          break;
        }
        this._emitEngineNotice(action.notice);
        break;

      case "engine_notice":
        this._emitEngineNotice(action.notice);
        break;

      case "protocol_warning":
      case "unknown_runtime_event":
      case "unknown_control_request":
        void require("./runtime-diagnostics").reportRuntimeProtocolIssue({
          normalizedKind: action.kind,
          event: action.event || null,
          notice: action.notice || null,
          eventType: action.notice?.type,
          eventSubtype: action.notice?.subtype || action.subtype,
          turnPhase: this.busy ? "busy" : "idle",
          sessionState: this._turnSettled ? "settled" : "running",
          summary: action.notice?.code || action.kind,
        });
        if (action.kind !== "unknown_control_request") break;
        log.warn("unhandled control_request subtype=%s", action.subtype || "unknown");
        this._writeControlLine(buildControlAck(action.requestId));
        break;

      case "assistant_text":
        this.collectedOutput += String(action.text || "");
        this._markStreamActivity();
        break;

      case "assistant_thinking":
        this._markStreamActivity();
        break;

      case "assistant_supersedes":
      case "stream_metadata_delta":
        this._markStreamActivity();
        break;

      case "assistant_tool_use": {
        this._turnHadToolUse = true;
        const lease = this._trackToolLease(action.id, action.name, action.input || {});
        this._clearIdleTimer();
        this._markStreamActivity();
        if (this._emittedToolIds.has(action.id)) {
          this._ingestRuntime([{
            type: "tool.input.done",
            payload: { id: action.id, input: action.input || {} },
          }]);
          const updatedLease = this._updateToolLeaseInput(action.id, action.input || {});
          if (lease.becameDetached || updatedLease.becameDetached) {
            this._emitDetachedShellNotice(action.id, action.name, action.input || {});
          }
          this._streamingToolInputs.delete(action.id);
          break;
        }
        if (lease.becameDetached) {
          this._emitDetachedShellNotice(action.id, action.name, action.input || {});
        }
        break;
      }

      case "tool_result": {
        this._finishToolLease(action.id);
        this._markStreamActivity();
        // The tool is done. If nothing is pending now, the engine should
        // either start a summary message or send `result` next — arm the
        // grace fallback so a silent hang here (upstream call wedged after
        // the tool returned) still settles instead of locking for 30 min.
        // _armMessageStopCompletionTimer only arms when no work is pending,
        // and any further stream output cancels it, so live work is safe.
        this._armMessageStopCompletionTimer();
        this._maybeCompleteDeferredTurnResult();
        break;
      }

      case "stream_message_start":
        this._messageStopObserved = false;
        this._streamingToolInputs.clear();
        this._emittedToolIds.clear();
        this._blockIndexToToolId.clear();
        break;

      case "stream_tool_start":
        this._turnHadToolUse = true;
        this._clearIdleTimer();
        this._trackToolLease(action.id, action.name, action.input || {});
        this._emittedToolIds.add(action.id);
        this._streamingToolInputs.set(action.id, "");
        if (typeof action.index === "number" && action.index >= 0) {
          this._blockIndexToToolId.set(action.index, action.id);
        }
        break;

      case "stream_tool_input_delta": {
        const toolId = this._blockIndexToToolId.get(action.index);
        if (toolId) {
          const accumulated = (this._streamingToolInputs.get(toolId) || "") + action.partialJson;
          this._streamingToolInputs.set(toolId, accumulated);
        }
        break;
      }

      case "stream_content_block_stop": {
        const toolId = this._blockIndexToToolId.get(action.index);
        const parsed = this._tryParseToolInputJson(toolId);
        if (parsed) {
          const lease = this._updateToolLeaseInput(toolId, parsed);
          this._ingestRuntime([{
            type: "tool.input.done",
            payload: { id: toolId, input: parsed },
          }]);
          if (lease.becameDetached) {
            const entry = this._leaseTracker.get(toolId);
            this._emitDetachedShellNotice(toolId, entry?.name || "unknown", parsed);
          }
        }
        break;
      }

      case "stream_message_delta":
        if (action.usage && typeof action.usage === "object" && Object.keys(action.usage).length) {
          this._lastActualUsage = action.usage;
        }
        this._markStreamActivity();
        break;

      case "stream_message_stop":
        this._messageStopObserved = true;
        this._markStreamActivity();
        this._armMessageStopCompletionTimer();
        break;

      case "prompt_suggestions":
        break;

      case "control_cancel":
        if (action.requestId) this._approvals.dropPermission(action.requestId);
        break;

      case "turn_result":
        this._handleTurnResult(action.event);
        break;

      case "runtime_error":
        this._handleRuntimeError(action.event);
        break;

      case "initialize_request":
        this._cliInitialized = true;
        this._writeControlLine(buildControlAck(action.requestId, { promptSuggestions: true }));
        if (Array.isArray(action.suggestions) && action.suggestions.length) {
          this._ingestRuntime([{
            type: "prompt_suggestions.updated",
            payload: { suggestions: action.suggestions },
          }]);
        }
        break;

      case "hook_pretool_use":
      case "hook_pretool_use_ask":
      case "hook_permission_request_ask":
      case "hook_elicitation_ask":
        this._handleHookPreToolUse(action);
        break;

      case "hook_posttool_use":
      case "hook_posttool_use_failure":
      case "hook_posttool_batch":
      case "hook_session_start":
      case "hook_session_end":
      case "hook_precompact":
      case "hook_postcompact":
      case "hook_user_prompt":
      case "hook_user_prompt_expansion":
      case "hook_notification":
      case "hook_stop_failure":
      case "hook_subagent_start":
      case "hook_permission_request":
      case "hook_permission_denied":
      case "hook_setup":
      case "hook_teammate_idle":
      case "hook_task_created":
      case "hook_task_completed":
      case "hook_elicitation":
      case "hook_elicitation_result":
      case "hook_config_change":
      case "hook_worktree_create":
      case "hook_worktree_remove":
      case "hook_instructions_loaded":
      case "hook_cwd_changed":
      case "hook_file_changed":
      case "hook_message_display":
        this._handleHookInfoOnly(action);
        break;

      case "hook_stop":
      case "hook_subagent_stop":
        this._handleHookStop(action);
        break;

      case "hook_user_prompt_ask":
        this._handleHookPreToolUse(action);
        break;

      // Keep backward compat for unknown hook types
      case "hook_callback":
        this._handleHookInfoOnly(action);
        break;

      case "control_response":
        // Claude CLI can echo host control responses on stdout. This is part of
        // the protocol handshake and should not surface as a user warning.
        break;

      case "control_request":
        this._writeControlLine(buildControlAck(action.requestId));
        break;

      case "permission_check":
        this._handleCanUseTool(action);
        break;

      case "ask_user_question":
        this._handleAskUserQuestion(action);
        break;

      case "user_input_request":
        this._handleUserInputRequest(action);
        break;

      default:
        log.warn("unknown normalized action kind=%s", action.kind || "missing");
        this._emitEngineNotice({
          code: "unknownEvent",
          level: "warning",
          panel: true,
          done: true,
          type: action.kind || "normalized_event",
        });
        break;
    }
  }

  _handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      if (trimmed.length > 0) {
        log.debug("ignored non-json stdout: %s", trimmed.slice(0, 160));
      }
      return;
    }

    if (!ev?.type) return;
    this._noteStreamContext(ev);

    if (this._internalCommand) {
      if (ev.type === "result") {
        log.info(`internal command completed: ${this._internalCommand}`);
        this._clearInternalCommandTimer();
      } else if (ev.type === "error") {
        log.warn(
          "internal command error: %s",
          ev.message || JSON.stringify(ev).slice(0, 200),
        );
        this._clearInternalCommandTimer();
      }
      return;
    }

    let normalized;
    try {
      normalized = this._runtimeAdapter.normalizeEvent(ev);
    } catch (err) {
      log.warn("runtime adapter failed: %s", err?.message || String(err));
      const notice = {
        code: "unknownEvent",
        level: "warning",
        panel: true,
        done: true,
        type: ev.type || "adapter_error",
        subtype: ev.subtype || "",
      };
      this._emitEngineNotice(notice);
      void require("./runtime-diagnostics").reportRuntimeProtocolIssue({
        normalizedKind: "runtime_adapter_error",
        event: ev,
        notice,
        eventType: ev.type,
        eventSubtype: ev.subtype,
        turnPhase: this.busy ? "busy" : "idle",
        sessionState: this._turnSettled ? "settled" : "running",
        summary: err?.message || "runtime adapter error",
      });
      return;
    }
    if (normalized.backgroundActivity) {
      this._markRuntimeLifecycleActivity(normalized.backgroundActivity);
    }

    for (const action of normalized.actions) {
      this._handleNormalizedAction(action);
    }

    const drafts = [...(normalized.runtimeEvents || [])];
    for (const draft of drafts) {
      if (draft.type !== "tool.done") continue;
      const raw = draft.payload?.content;
      if (typeof raw !== "string" || !raw) continue;
      draft.payload.result = truncateToolResultForUi(raw);
      delete draft.payload.content;
    }
    drafts.push({
      type: "process.event",
      payload: processEventFromClaudeEvent(ev, normalized.actions || []),
    });
    this._ingestRuntime(drafts);
  }
}

module.exports = { AgentSession };
