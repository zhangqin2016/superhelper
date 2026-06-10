"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const {
  appendTextSegment,
  sanitizeError,
  classifyAssistantError,
  isUpstreamApiFailure,
} = require("./agent-runner");
const {
  needsUserApproval,
  buildControlResponse,
  buildRememberAllowPermissions,
  buildControlCancelRequest,
  buildUpdateEnvironmentVariablesRequest,
  buildControlAck,
  buildHookCallbackResponse,
  buildHookContinueResponse,
  buildHookPreToolUseResponse,
  buildHookStopResponse,
  buildInterruptRequest,
  buildSetPermissionModeRequest,
} = require("./control-protocol");
const {
  normalizeAskUserQuestions,
} = require("./claude-event-normalizer");
const { CliEventAdapter } = require("./cli-event-adapter");
const {
  compactCommand,
  isShellTool,
  isDetachedShellInput,
  looksLikeLongRunningShellCommand,
} = require("./runtime/runtime-activity");
const { buildUserMessagePayload, hasSendableContent } = require("./user-message");
const { resolvePlanPreview, PLAN_PREVIEW_MAX } = require("./plan-preview");
const { buildAgentSpawnEnv } = require("./spawn-env");
const { sameRespawnOptions } = require("./runner-spawn-options");
const { appendPermissionSpawnArgs } = require("./permission-spawn-args");
const {
  truncateToolResultForUi,
  processEventFromClaudeEvent,
} = require("./cli-process-payload");
const { sanitizeNoticeForIngest } = require("./engine-notice-policy");
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
    this.lineBuf = "";
    this.busy = false;
    this.collectedOutput = "";
    this._backgroundActivityUntil = 0;
    this.agentResumeId = null;
    this.spawnOptions = null;
    this.lastSpawnError = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._idleTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._interruptFallbackTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._turnResponseTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._absoluteTurnTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._messageStopTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._deferredTurnResultTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._firstResponseNoticeTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._longWaitNoticeTimer = null;
    this._turnStartedAt = 0;
    this._pendingToolIds = new Set();
    this._turnHadToolUse = false;
    this._turnHadBlockingToolUse = false;
    this._sawStdoutForTurn = false;
    this._turnSettled = true;
    /** @type {Map<string, { toolName: string, input: Record<string, unknown> }>} */
    this._pendingPermissions = new Map();
    /** @type {Map<string, { hookName: string, toolName: string, requestId: string }>} */
    this._pendingHooks = new Map();
    this._cliInitialized = false;
    this._interruptPending = false;
    /** @type {string | null} */
    this._streamParentToolUseId = null;
    /** @type {Map<string, string>} — accumulated partial_json per tool_use id */
    this._streamingToolInputs = new Map();
    /** @type {Set<string>} — tool_use ids already emitted from content_block_start */
    this._emittedToolIds = new Set();
    /** @type {Map<number, string>} — content block index → tool_use id */
    this._blockIndexToToolId = new Map();
    /** @type {Map<string, { name: string, input: Record<string, unknown>, detached: boolean, startedAt: number }>} */
    this._toolLeases = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this._toolLeaseNoticeTimers = new Map();
    this._internalCommand = null;
    this._internalCommandTimer = null;
    this._backgroundActivityUntil = 0;
    this._deferredTurnResult = null;
    this._deferredTurnResultAt = 0;
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

  /** Pure-text fallback if CLI never sends `result`; tool turns are completed by result/error/timeout. */
  static QUIESCE_MS = 30_000;
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
  /** Wait after message_stop for a trailing `result` event before pure-text fallback. */
  static MESSAGE_STOP_GRACE_MS = 30_000;
  /** Long-running foreground shell commands need visible user feedback. */
  static TOOL_LONG_TASK_NOTICE_MS = 30_000;
  static TOOL_LONG_TASK_HEARTBEAT_MS = 5 * 60_000;

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  _clearInterruptFallback() {
    if (this._interruptFallbackTimer) {
      clearTimeout(this._interruptFallbackTimer);
      this._interruptFallbackTimer = null;
    }
    this._interruptPending = false;
  }

  _clearTurnResponseTimer() {
    if (this._turnResponseTimer) {
      clearTimeout(this._turnResponseTimer);
      this._turnResponseTimer = null;
    }
  }

  _clearAbsoluteTurnTimer() {
    if (this._absoluteTurnTimer) {
      clearTimeout(this._absoluteTurnTimer);
      this._absoluteTurnTimer = null;
    }
  }

  _clearDeferredTurnResultTimer() {
    if (this._deferredTurnResultTimer) {
      clearTimeout(this._deferredTurnResultTimer);
      this._deferredTurnResultTimer = null;
    }
  }

  _clearMessageStopTimer() {
    if (this._messageStopTimer) {
      clearTimeout(this._messageStopTimer);
      this._messageStopTimer = null;
    }
  }

  _clearWaitNoticeTimers() {
    if (this._firstResponseNoticeTimer) {
      clearTimeout(this._firstResponseNoticeTimer);
      this._firstResponseNoticeTimer = null;
    }
    if (this._longWaitNoticeTimer) {
      clearTimeout(this._longWaitNoticeTimer);
      this._longWaitNoticeTimer = null;
    }
  }

  _clearToolLeaseNoticeTimer(toolId) {
    const timer = this._toolLeaseNoticeTimers.get(toolId);
    if (timer) clearTimeout(timer);
    this._toolLeaseNoticeTimers.delete(toolId);
  }

  _clearToolLeaseNoticeTimers() {
    for (const timer of this._toolLeaseNoticeTimers.values()) {
      clearTimeout(timer);
    }
    this._toolLeaseNoticeTimers.clear();
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
    this._absoluteTurnTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled) return;
      if (this._hasBlockingTurnWork()) {
        this._emitBlockingWorkHeartbeat("absolute-timeout");
        this._armAbsoluteTurnTimer();
        return;
      }
      this._recoverStalledTurn("absolute");
    }, AgentSession.TURN_ABSOLUTE_MAX_MS);
  }

  _armTurnResponseTimer() {
    this._clearTurnResponseTimer();
    if (!this.busy || this._turnSettled) return;
    const ms = this.agentResumeId
      ? AgentSession.RESUME_TURN_TIMEOUT_MS
      : AgentSession.TURN_RESPONSE_TIMEOUT_MS;
    this._turnResponseTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled) return;
      this._emitEngineNotice({
        code: "longWait",
        level: "progress",
        panel: true,
        replace: true,
        reason: "silence",
      });
      this._armTurnResponseTimer();
    }, ms);
  }

  _clearPendingPermissions(notifyCancel = false) {
    if (this._pendingPermissions.size === 0) return;
    const ids = [...this._pendingPermissions.keys()];
    this._pendingPermissions.clear();
    if (notifyCancel) {
      for (const requestId of ids) {
        this._ingestRuntime([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
      }
    }
  }

  _clearPendingHooks(notifyCancel = false) {
    if (this._pendingHooks.size === 0) return;
    const ids = [...this._pendingHooks.keys()];
    this._pendingHooks.clear();
    if (notifyCancel) {
      for (const requestId of ids) {
        this._ingestRuntime([{ type: "hook.resolved", payload: { requestId, cancelled: true } }]);
      }
    }
  }

  _canAutoCompleteTurn() {
    return (
      this.busy &&
      !this._turnSettled &&
      !this._turnHadBlockingToolUse &&
      this._pendingToolIds.size === 0 &&
      this._pendingPermissions.size === 0 &&
      this._pendingHooks.size === 0 &&
      Date.now() >= this._backgroundActivityUntil
    );
  }

  _hasBlockingTurnWork() {
    return (
      this._pendingToolIds.size > 0 ||
      this._pendingPermissions.size > 0 ||
      this._pendingHooks.size > 0 ||
      Date.now() < this._backgroundActivityUntil
    );
  }

  _hasPendingRuntimeBlockers() {
    return (
      this._pendingToolIds.size > 0 ||
      this._pendingPermissions.size > 0 ||
      this._pendingHooks.size > 0
    );
  }

  _deferTurnResult(payload, reason) {
    this._deferredTurnResult = payload;
    this._deferredTurnResultAt = Date.now();
    log.warn("turn result deferred until pending runtime blockers settle: %s", reason, {
      sessionId: this.sessionId,
      pendingTools: this._pendingToolIds.size,
      pendingPermissions: this._pendingPermissions.size,
      pendingHooks: this._pendingHooks.size,
      backgroundMs: Math.max(0, this._backgroundActivityUntil - Date.now()),
    });
    this._armDeferredTurnResultTimer();
  }

  _armDeferredTurnResultTimer() {
    this._clearDeferredTurnResultTimer();
    if (!this.busy || this._turnSettled || !this._deferredTurnResult) return;
    const elapsedMs = Math.max(0, Date.now() - Number(this._deferredTurnResultAt || Date.now()));
    const remainingGraceMs = Math.max(0, AgentSession.DEFERRED_TURN_RESULT_GRACE_MS - elapsedMs);
    const delay = this._hasPendingRuntimeBlockers() ? Math.max(25, remainingGraceMs || 25) : 25;
    this._deferredTurnResultTimer = setTimeout(() => {
      this._maybeCompleteDeferredTurnResult();
    }, delay);
  }

  _maybeCompleteDeferredTurnResult() {
    if (!this.busy || this._turnSettled || !this._deferredTurnResult) return false;
    if (this._hasPendingRuntimeBlockers()) {
      const elapsedMs = Math.max(0, Date.now() - Number(this._deferredTurnResultAt || Date.now()));
      if (elapsedMs < AgentSession.DEFERRED_TURN_RESULT_GRACE_MS) {
        this._armDeferredTurnResultTimer();
        return false;
      }
      log.warn("turn result completed with stale pending runtime blockers", {
        sessionId: this.sessionId,
        pendingTools: [...this._pendingToolIds],
        pendingPermissions: [...this._pendingPermissions.keys()],
        pendingHooks: [...this._pendingHooks.keys()],
      });
    } else if (Date.now() < this._backgroundActivityUntil) {
      this._backgroundActivityUntil = 0;
    }
    const payload = this._deferredTurnResult;
    this._deferredTurnResult = null;
    this._deferredTurnResultAt = 0;
    this._clearDeferredTurnResultTimer();
    this._completeTurn(payload);
    return true;
  }

  _markBackgroundActivity(short = false) {
    this._backgroundActivityUntil = Date.now() + (short ? 10_000 : 120_000);
    this._clearIdleTimer();
    this._clearMessageStopTimer();
    this._armDeferredTurnResultTimer();
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

  _formatToolLeaseDetail(lease = {}) {
    const command = compactCommand(lease.input || {}).slice(0, 160);
    const elapsedMs = Math.max(0, Date.now() - Number(lease.startedAt || Date.now()));
    const minutes = Math.floor(elapsedMs / 60_000);
    const elapsed = minutes > 0 ? ` · running ${minutes}m` : "";
    return `${command || lease.name || "command"}${elapsed}`;
  }

  _emitBlockingWorkHeartbeat(reason = "long-running") {
    const shellLease = [...this._toolLeases.values()].find((lease) =>
      !lease.detached && this._isShellTool(lease.name)
    );
    if (shellLease) {
      this._emitEngineNotice({
        code: "shellLongRunning",
        level: "progress",
        panel: true,
        replace: true,
        toolName: shellLease.name,
        detail: this._formatToolLeaseDetail(shellLease),
        reason,
      });
      return;
    }
    if (this._pendingToolIds.size > 0) {
      this._emitEngineNotice({
        code: "taskProgress",
        level: "progress",
        panel: true,
        replace: true,
        detail: "Task is still running",
        reason,
      });
    }
  }

  _armToolLeaseNoticeTimer(toolId, delayMs) {
    this._clearToolLeaseNoticeTimer(toolId);
    const timer = setTimeout(() => {
      this._toolLeaseNoticeTimers.delete(toolId);
      if (!this.busy || this._turnSettled) return;
      const lease = this._toolLeases.get(toolId);
      if (!lease || lease.detached || !this._isShellTool(lease.name)) return;
      this._emitEngineNotice({
        code: "shellLongRunning",
        level: "progress",
        panel: true,
        replace: true,
        toolName: lease.name,
        detail: this._formatToolLeaseDetail(lease),
      });
      this._armToolLeaseNoticeTimer(toolId, AgentSession.TOOL_LONG_TASK_HEARTBEAT_MS);
    }, delayMs);
    this._toolLeaseNoticeTimers.set(toolId, timer);
  }

  _trackToolLease(toolId, name, input = {}) {
    if (!toolId) return { detached: false, becameDetached: false };
    const prev = this._toolLeases.get(toolId);
    const nextName = name || prev?.name || "unknown";
    const nextInput =
      input && Object.keys(input).length > 0
        ? input
        : prev?.input || {};
    const detached = this._isDetachedShellInput(nextName, nextInput);
    const becameDetached = detached && !prev?.detached;

    this._toolLeases.set(toolId, {
      name: nextName,
      input: nextInput,
      detached,
      startedAt: prev?.startedAt || Date.now(),
    });

    if (detached) this._pendingToolIds.delete(toolId);
    else {
      this._pendingToolIds.add(toolId);
      this._turnHadBlockingToolUse = true;
    }
    if (detached && becameDetached) {
      this._turnHadBlockingToolUse = [...this._toolLeases.values()].some(
        (entry) => !entry.detached,
      );
    }

    if (detached) {
      this._clearToolLeaseNoticeTimer(toolId);
    } else if (this._isShellTool(nextName) && !this._toolLeaseNoticeTimers.has(toolId)) {
      this._armToolLeaseNoticeTimer(toolId, AgentSession.TOOL_LONG_TASK_NOTICE_MS);
    }
    return { detached, becameDetached };
  }

  _updateToolLeaseInput(toolId, input = {}) {
    if (!toolId) return { detached: false, becameDetached: false };
    const prev = this._toolLeases.get(toolId);
    if (!prev) return { detached: false, becameDetached: false };
    return this._trackToolLease(toolId, prev.name, input);
  }

  _finishToolLease(toolId) {
    let id = toolId;
    if (!id && this._pendingToolIds.size === 1) {
      id = [...this._pendingToolIds][0];
    }
    if (!id) return;
    this._pendingToolIds.delete(id);
    this._toolLeases.delete(id);
    this._clearToolLeaseNoticeTimer(id);
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
    this._idleTimer = setTimeout(() => {
      if (!this._canAutoCompleteTurn()) return;
      if (!this.collectedOutput.trim()) return;
      log.warn("turn completed via idle quiesce (no result event)");
      this._flushLineBuffer();
      this._completeTurn({
        code: 0,
        output: this.collectedOutput.trim(),
        idle: true,
      });
    }, AgentSession.QUIESCE_MS);
  }

  _armMessageStopCompletionTimer() {
    this._clearMessageStopTimer();
    if (!this._canAutoCompleteTurn()) return;
    this._messageStopTimer = setTimeout(() => {
      if (!this._canAutoCompleteTurn()) return;
      this.emit("message-stop-grace", {
        output: this.collectedOutput.trim(),
      });
    }, AgentSession.MESSAGE_STOP_GRACE_MS);
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
    this._clearWaitNoticeTimers();
    this._armTurnResponseTimer();
    this._armIdleCompletionTimer();
  }

  _armWaitNoticeTimers() {
    this._clearWaitNoticeTimers();
    if (!this.busy || this._turnSettled) return;
    this._firstResponseNoticeTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled || this.collectedOutput.trim()) return;
      this._emitEngineNotice({
        code: "waitingForFirstResponse",
        level: "progress",
        panel: true,
        replace: true,
      });
    }, AgentSession.FIRST_RESPONSE_NOTICE_MS);
    this._longWaitNoticeTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled || this.collectedOutput.trim()) return;
      this._emitEngineNotice({
        code: "longWait",
        level: "progress",
        panel: true,
        replace: true,
      });
    }, AgentSession.LONG_WAIT_NOTICE_MS);
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

  _spawn() {
    const opts = this.spawnOptions;
    const args = [
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--prompt-suggestions",
      "true",
    ];
    appendPermissionSpawnArgs(args, opts.permissionMode);
    args.push("--permission-prompt-tool", "stdio");

    if (opts.disallowedTools?.length) {
      args.push("--disallowed-tools", ...opts.disallowedTools);
    }
    if (opts.stagingDir && fs.existsSync(opts.stagingDir)) {
      args.push("--add-dir", opts.stagingDir);
    }
    if (this.agentResumeId) {
      args.push("--resume", this.agentResumeId);
    }

    this.lastSpawnError = null;
    this.process = spawn(opts.agentCommand, args, {
      cwd: this.cwd,
      env: buildAgentSpawnEnv({ configDir: opts.configDir || undefined }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.lineBuf = "";
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
    this._backgroundActivityUntil = 0;
    this._streamParentToolUseId = null;
    this._pendingToolIds.clear();
    this._toolLeases.clear();
    this._turnHadToolUse = false;
    this._turnHadBlockingToolUse = false;
    this._sawStdoutForTurn = false;
    this._backgroundActivityUntil = 0;
    this._deferredTurnResult = null;
    this._deferredTurnResultAt = 0;
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
    const stdin = this.process.stdin;
    if (!stdin || stdin.destroyed) {
      this._failTurn("Assistant connection has been lost. Please retry.");
      return false;
    }

    const wrote = stdin.write(line, (err) => {
      if (err) this._failTurn(sanitizeError(err.message));
    });
    if (!wrote) {
      stdin.once("drain", () => {});
    }
    this._armTurnResponseTimer();
    this._armAbsoluteTurnTimer();
    return true;
  }

  respondPermission(requestId, decision) {
    const pending = this._pendingPermissions.get(requestId);
    if (!pending) return false;

    this._pendingPermissions.delete(requestId);
    if (decision.allow) {
      /** @type {{ behavior: "allow", updatedInput: Record<string, unknown>, updatedPermissions?: unknown[] }} */
      const allowDecision = {
        behavior: "allow",
        updatedInput: pending.input,
      };
      if (decision.remember && pending.toolName) {
        allowDecision.updatedPermissions =
          Array.isArray(pending.suggestions) && pending.suggestions.length
            ? pending.suggestions
            : buildRememberAllowPermissions(pending.toolName);
      }
      this._writeControlLine(buildControlResponse(requestId, allowDecision));
    } else {
      this._emitEngineNotice({
        code: "permissionUserDenied",
        level: "warning",
        panel: true,
        replace: true,
        done: true,
        toolName: pending.toolName,
      });
      this._writeControlLine(
        buildControlResponse(requestId, {
          behavior: "deny",
          message: decision.message || "User denied this action",
        }),
      );
      this._writeControlLine(buildControlCancelRequest(requestId));
    }
    this._ingestRuntime([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    this._markStreamActivity();
    this._maybeCompleteDeferredTurnResult();
    return true;
  }

  respondUserQuestion(requestId, payload = {}) {
    const pending = this._pendingPermissions.get(requestId);
    if (!pending || pending.toolName !== "AskUserQuestion") return false;

    const questions = normalizeAskUserQuestions(pending.input || {});
    const answers =
      payload.answers && typeof payload.answers === "object"
        ? payload.answers
        : {};
    const response =
      typeof payload.response === "string" ? payload.response.trim() : "";

    this._pendingPermissions.delete(requestId);
    this._writeControlLine(
      buildControlResponse(requestId, {
        behavior: "allow",
        updatedInput: {
          questions,
          answers,
          ...(response ? { response } : {}),
        },
      }),
    );
    this._ingestRuntime([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    this._markStreamActivity();
    this._maybeCompleteDeferredTurnResult();
    return true;
  }

  cancelPermissionRequest(requestId) {
    if (!this._pendingPermissions.has(requestId)) return false;
    this._pendingPermissions.delete(requestId);
    this._writeControlLine(buildControlCancelRequest(requestId));
    this._ingestRuntime([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    this._maybeCompleteDeferredTurnResult();
    return true;
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

  reloadSkills() {
    if (!this.isAlive() || this.busy || this._internalCommand) return false;
    const payload = buildUserMessagePayload({ text: "/reload-skills" });
    if (!payload) return false;
    this._internalCommand = "reload-skills";
    this._writeControlLine(payload);
    this._internalCommandTimer = setTimeout(() => {
      this._internalCommand = null;
      this._internalCommandTimer = null;
    }, 10_000);
    return true;
  }

  interrupt() {
    this._denyAllPendingPermissions("Session interrupted");
    this._clearPendingHooks(true);

    if (this.busy && !this._turnSettled && this.isAlive()) {
      this._interruptPending = true;
      this._writeControlLine(buildInterruptRequest());
      this._interruptFallbackTimer = setTimeout(() => {
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
      }, AgentSession.INTERRUPT_FALLBACK_MS);
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
    this._pendingToolIds.clear();
    this._toolLeases.clear();
    this._turnHadToolUse = false;
    this._turnHadBlockingToolUse = false;
    this._backgroundActivityUntil = 0;
    this._deferredTurnResult = null;
    this._deferredTurnResultAt = 0;
    this._clearDeferredTurnResultTimer();
    if (!this.process) {
      this.cwd = null;
      this.spawnOptions = null;
      this.lineBuf = "";
      this.collectedOutput = "";
      this._lastActualUsage = null;
      this._usageRecordedForTurn = false;
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
    this.lineBuf = "";
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
    this._pendingToolIds.clear();
    this._toolLeases.clear();
    this._turnHadToolUse = false;
    this._turnHadBlockingToolUse = false;
    this._backgroundActivityUntil = 0;
    this._deferredTurnResult = null;
    this._deferredTurnResultAt = 0;
    this._lastActualUsage = null;
    this._usageRecordedForTurn = false;
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
    this._pendingToolIds.clear();
    this._toolLeases.clear();
    this._deferredTurnResult = null;
    this._deferredTurnResultAt = 0;
    this._lastActualUsage = null;
    this._usageRecordedForTurn = false;
    this._backgroundActivityUntil = 0;
    this._turnHadToolUse = false;
    this._turnHadBlockingToolUse = false;
    this._streamParentToolUseId = null;
    this._streamingToolInputs.clear();
    this._emittedToolIds.clear();
    this._blockIndexToToolId.clear();
    this._turnSettled = true;
    this.busy = false;
    this._orchestrator?.notifyRunnerError(this.sessionId, message);
  }

  _onStdout(chunk) {
    this.lineBuf += chunk.toString();
    const lines = this.lineBuf.split("\n");
    this.lineBuf = lines.pop() || "";
    for (const line of lines) {
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
    const trimmed = this.lineBuf.trim();
    this.lineBuf = "";
    if (trimmed) this._handleLine(trimmed);
  }

  _writeControlLine(payload) {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed) {
      log.warn("control line skipped: stdin unavailable");
      return false;
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  _clearInternalCommandTimer() {
    if (this._internalCommandTimer) {
      clearTimeout(this._internalCommandTimer);
      this._internalCommandTimer = null;
    }
    this._internalCommand = null;
  }

  _denyAllPendingPermissions(message) {
    for (const [requestId] of this._pendingPermissions) {
      this._writeControlLine(
        buildControlResponse(requestId, {
          behavior: "deny",
          message,
        }),
      );
      this._writeControlLine(buildControlCancelRequest(requestId));
      this._ingestRuntime([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    }
    this._pendingPermissions.clear();
  }

  _noteStreamContext(ev) {
    if (ev.parent_tool_use_id != null && ev.parent_tool_use_id !== "") {
      this._streamParentToolUseId = String(ev.parent_tool_use_id);
    }
  }

  _allowToolUse(requestId, input) {
    this._writeControlLine(
      buildControlResponse(requestId, {
        behavior: "allow",
        updatedInput: input || {},
      }),
    );
    this._markStreamActivity();
  }

  _handleHookPreToolUse(action) {
    const { requestId, toolName, permissionDecision, decisionReason, notice } = action;

    if (permissionDecision !== "ask") {
      const detail = toolName ? `${toolName}` : "";
      this._emitEngineNotice({ ...notice, detail: detail || notice.detail, done: true });
      this._writeControlLine(buildHookContinueResponse(requestId));
      return;
    }

    this._pendingHooks.set(requestId, {
      hookName: action.hookName || "PreToolUse",
      toolName: toolName || "unknown",
      requestId,
    });
    this._turnHadToolUse = true;
    this._clearIdleTimer();

    this._emitEngineNotice({
      ...notice,
      detail: toolName
        ? `${toolName}${decisionReason ? ` — ${decisionReason}` : ""}`
        : notice.detail,
    });

    setTimeout(() => {
      if (!this._pendingHooks.has(requestId)) return;
      this._emitEngineNotice({
        code: "hookTimeout",
        level: "warning",
        panel: true,
        toast: true,
        done: true,
        requestId,
        detail: `${toolName}: Hook decision timed out, denied`,
      });
      this.respondHook(requestId, { allow: false });
    }, AgentSession.PERMISSION_UI_TIMEOUT_MS);
  }

  _handleHookStop(action) {
    const { requestId, hookName, notice } = action;

    this._pendingHooks.set(requestId, {
      hookName: hookName || "Stop",
      requestId,
      toolName: "",
    });
    this._turnHadToolUse = true;
    this._clearIdleTimer();

    this._emitEngineNotice(notice);

    setTimeout(() => {
      if (!this._pendingHooks.has(requestId)) return;
      this.respondHook(requestId, { allow: true });
    }, AgentSession.PERMISSION_UI_TIMEOUT_MS);
  }

  _handleHookInfoOnly(action) {
    this._emitEngineNotice(action.notice);
    this._writeControlLine(buildHookContinueResponse(action.requestId));
  }

  respondHook(requestId, decision) {
    const pending = this._pendingHooks.get(requestId);
    if (!pending) return false;

    this._pendingHooks.delete(requestId);

    if (pending.hookName === "PreToolUse") {
      this._writeControlLine(
        buildHookPreToolUseResponse(requestId, {
          allow: Boolean(decision.allow),
          updatedInput: decision.updatedInput || undefined,
        }),
      );
    } else if (pending.hookName === "Stop" || pending.hookName === "SubagentStop") {
      this._writeControlLine(
        buildHookStopResponse(requestId, {
          allow: Boolean(decision.allow),
          reason: decision.reason,
        }),
      );
    } else {
      this._writeControlLine(buildHookContinueResponse(requestId));
    }

    this._ingestRuntime([{ type: "hook.resolved", payload: { requestId, hookName: pending.hookName } }]);
    this._markStreamActivity();
    this._maybeCompleteDeferredTurnResult();
    return true;
  }

  _handleCanUseTool(canUse) {
    const { requestId, toolName, input, title, description, decisionReason, suggestions } =
      canUse;
    const permissionMode = this.spawnOptions?.permissionMode || "default";

    if (toolName === "AskUserQuestion") {
      this._handleAskUserQuestion(canUse);
      return;
    }

    log.info("permission-check tool=%s mode=%s needsApproval=%s",
      toolName, permissionMode, needsUserApproval(toolName, permissionMode));

    if (!needsUserApproval(toolName, permissionMode)) {
      this._allowToolUse(requestId, input);
      return;
    }

    if (permissionMode === "dontAsk") {
      this._emitEngineNotice({
        code: "permissionAutoDenied",
        level: "warning",
        panel: true,
        replace: true,
        done: true,
        toolName,
      });
      this._writeControlLine(
        buildControlResponse(requestId, {
          behavior: "deny",
          message: "Skipped because confirmations are turned off",
        }),
      );
      this._markStreamActivity();
      return;
    }

    this._pendingPermissions.set(requestId, { toolName, input, suggestions });
    this._turnHadToolUse = true;
    this._clearIdleTimer();
    const planPreview = resolvePlanPreview(input, description);
    this._ingestRuntime([{
      type: "permission.requested",
      payload: {
        requestId,
        toolName,
        input,
        title,
        description,
        decisionReason,
        suggestions,
        planPreview,
        planPreviewTruncated: planPreview.length >= PLAN_PREVIEW_MAX,
      },
    }]);

    setTimeout(() => {
      if (!this._pendingPermissions.has(requestId)) return;
      this._emitEngineNotice({
        code: "permissionTimeout",
        level: "warning",
        panel: true,
        toast: true,
        done: true,
        requestId,
        toolName,
      });
      this.respondPermission(requestId, {
        allow: false,
        message: "Permission request timed out",
      });
    }, AgentSession.PERMISSION_UI_TIMEOUT_MS);
  }

  _handleAskUserQuestion(canUse) {
    const { requestId, input } = canUse;
    const questions = normalizeAskUserQuestions(input || {});
    this._pendingPermissions.set(requestId, {
      toolName: "AskUserQuestion",
      input: { ...input, questions },
    });
    this._turnHadToolUse = true;
    this._clearIdleTimer();
    this._ingestRuntime([{
      type: "user_question.requested",
      payload: {
        requestId,
        input,
        questions,
      },
    }]);
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

  _appendTextPiece(piece) {
    if (!piece) return;
    this.collectedOutput = appendTextSegment(this.collectedOutput, piece);
    this._markStreamActivity();
  }

  _handleTurnResult(ev) {
    this._clearMessageStopTimer();
    this._flushLineBuffer();
    if (ev.modelUsage && typeof ev.modelUsage === "object") {
      this._recordActualUsage(ev.modelUsage);
      this._ingestRuntime([{ type: "usage.updated", payload: { usage: ev.modelUsage } }]);
    }
    if (ev.subtype === "success" && ev.result) {
      const piece = String(ev.result);
      if (piece && !this.collectedOutput.includes(piece)) {
        this._appendTextPiece(piece);
      }
    }
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
    if (Date.now() < this._backgroundActivityUntil) {
      this._backgroundActivityUntil = 0;
    }
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

  _handleNormalizedAction(action) {
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
        this.collectedOutput = appendTextSegment(this.collectedOutput, action.text || "");
        this._markStreamActivity();
        break;

      case "assistant_thinking":
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
        this._maybeCompleteDeferredTurnResult();
        break;
      }

      case "stream_message_start":
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
            const entry = this._toolLeases.get(toolId);
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
        this._markStreamActivity();
        this._armMessageStopCompletionTimer();
        break;

      case "prompt_suggestions":
        break;

      case "control_cancel":
        if (action.requestId && this._pendingPermissions.has(action.requestId)) {
          this._pendingPermissions.delete(action.requestId);
        }
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
        this._handleHookPreToolUse(action);
        break;

      case "hook_posttool_use":
      case "hook_posttool_use_failure":
      case "hook_session_start":
      case "hook_precompact":
      case "hook_user_prompt":
      case "hook_notification":
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

      case "permission_check":
        this._handleCanUseTool(action);
        break;

      case "ask_user_question":
        this._handleAskUserQuestion(action);
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
      this._markBackgroundActivity(normalized.backgroundActivity.short);
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
