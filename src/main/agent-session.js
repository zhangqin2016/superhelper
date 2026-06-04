"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const {
  appendTextSegment,
  sanitizeError,
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
  buildInterruptRequest,
  buildSetPermissionModeRequest,
  buildInitializeRequest,
} = require("./control-protocol");
const {
  normalizeClaudeEvent,
  normalizeAskUserQuestions,
} = require("./claude-event-normalizer");
const { buildUserMessagePayload, hasSendableContent } = require("./user-message");
const { resolvePlanPreview, PLAN_PREVIEW_MAX } = require("./plan-preview");
const { buildAgentSpawnEnv } = require("./spawn-env");
const { sameRespawnOptions } = require("./runner-spawn-options");
const { getLogger } = require("./logger");
const log = getLogger("agent-session");

const TOOL_RESULT_UI_MAX_CHARS = 12_000;

function truncateToolResultForUi(text) {
  const value = String(text || "");
  if (value.length <= TOOL_RESULT_UI_MAX_CHARS) return { content: value, truncated: false };
  const head = value.slice(0, 6_000);
  const tail = value.slice(-4_000);
  return {
    content: `${head}\n\n[...output truncated for display: ${value.length - head.length - tail.length} characters hidden...]\n\n${tail}`,
    truncated: true,
  };
}

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
    this._postToolWaitTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._messageStopTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._firstResponseNoticeTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._longWaitNoticeTimer = null;
    this._turnStartedAt = 0;
    this._pendingToolIds = new Set();
    this._turnHadToolUse = false;
    this._turnSettled = true;
    /** @type {Map<string, { toolName: string, input: Record<string, unknown> }>} */
    this._pendingPermissions = new Map();
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
    /** @type {Map<string, { name: string, input: Record<string, unknown>, detached: boolean }>} */
    this._toolLeases = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this._toolLeaseNoticeTimers = new Map();
    this._internalCommand = null;
    this._internalCommandTimer = null;
    this._backgroundActivityUntil = 0;
  }

  /** After stream goes quiet, complete turn if CLI never sends `result`. */
  static QUIESCE_MS = 4_000;
  static INTERRUPT_FALLBACK_MS = 2_000;
  static PERMISSION_UI_TIMEOUT_MS = 55_000;
  static TURN_RESPONSE_TIMEOUT_MS = 90_000;
  static RESUME_TURN_TIMEOUT_MS = 45_000;
  /** User-visible notice before timeout, not a failure. */
  static FIRST_RESPONSE_NOTICE_MS = 10_000;
  static LONG_WAIT_NOTICE_MS = 30_000;
  /** Hard cap — verbose logs must not extend a turn forever. */
  static TURN_ABSOLUTE_MAX_MS = 30 * 60_000;
  /** After all tools finish, model must respond within this window. */
  static POST_TOOL_SILENCE_MS = 45_000;
  /** Wait briefly after message_stop for a trailing `result` event. */
  static MESSAGE_STOP_GRACE_MS = 2_500;
  /** Long-running foreground shell commands need visible user feedback. */
  static TOOL_LONG_TASK_NOTICE_MS = 30_000;

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

  _clearPostToolWaitTimer() {
    if (this._postToolWaitTimer) {
      clearTimeout(this._postToolWaitTimer);
      this._postToolWaitTimer = null;
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
      this._recoverStalledTurn("absolute");
    }, AgentSession.TURN_ABSOLUTE_MAX_MS);
  }

  _armPostToolWaitTimer() {
    this._clearPostToolWaitTimer();
    if (!this.busy || this._turnSettled) return;
    if (this._pendingToolIds.size > 0) return;
    if (!this._turnHadToolUse) return;
    this._postToolWaitTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled) return;
      if (this._pendingToolIds.size > 0) return;
      if (Date.now() < this._backgroundActivityUntil) {
        this._armPostToolWaitTimer();
        return;
      }
      this._recoverStalledTurn("post-tool");
    }, AgentSession.POST_TOOL_SILENCE_MS);
  }

  _maybeArmPostToolWaitTimer() {
    if (this._pendingToolIds.size === 0 && this._turnHadToolUse) {
      this._armPostToolWaitTimer();
    } else {
      this._clearPostToolWaitTimer();
    }
  }

  _armTurnResponseTimer() {
    this._clearTurnResponseTimer();
    if (!this.busy || this._turnSettled) return;
    const ms = this.agentResumeId
      ? AgentSession.RESUME_TURN_TIMEOUT_MS
      : AgentSession.TURN_RESPONSE_TIMEOUT_MS;
    this._turnResponseTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled) return;
      this._recoverStalledTurn("silence");
    }, ms);
  }

  _clearPendingPermissions(notifyCancel = false) {
    if (this._pendingPermissions.size === 0) return;
    const ids = [...this._pendingPermissions.keys()];
    this._pendingPermissions.clear();
    if (notifyCancel) {
      for (const requestId of ids) {
        this.emit("permission-cancelled", { requestId });
      }
    }
  }

  _canAutoCompleteTurn() {
    return (
      this.busy &&
      !this._turnSettled &&
      this._pendingToolIds.size === 0 &&
      this._pendingPermissions.size === 0 &&
      Date.now() >= this._backgroundActivityUntil
    );
  }

  _markBackgroundActivity(short = false) {
    this._backgroundActivityUntil = Date.now() + (short ? 10_000 : 120_000);
    this._clearIdleTimer();
    this._clearMessageStopTimer();
    this._clearPostToolWaitTimer();
  }

  _isBackgroundActivityEvent(ev) {
    const marker = `${ev?.type || ""}:${ev?.subtype || ""}`.toLowerCase();
    return (
      marker.includes("task_") ||
      marker.includes("background") ||
      marker.includes("workflow") ||
      marker.includes("agent")
    );
  }

  _isShellTool(name) {
    return /^(bash|shell|runcommand)$/i.test(String(name || ""));
  }

  _isDetachedShellInput(name, input = {}) {
    if (!this._isShellTool(name)) return false;
    const command = String(input.command || input.cmd || input.script || "").trim();
    if (!command) return false;
    return /(?:^|\s)(?:nohup|setsid)\s+/i.test(command) ||
      /(?:^|\s)disown(?:\s|$)/i.test(command) ||
      /&\s*(?:>|2>|1>|$)/.test(command) ||
      this._looksLikeLongRunningShellCommand(command);
  }

  _looksLikeLongRunningShellCommand(command) {
    const normalized = String(command || "")
      .replace(/\\\n/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!normalized) return false;

    const longRunningPatterns = [
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/,
      /\b(?:vite|next|nuxt|astro|webpack-dev-server|webpack\s+serve)\b/,
      /\b(?:ng|vue-cli-service)\s+serve\b/,
      /\b(?:react-scripts|nodemon|ts-node-dev)\s+start\b/,
      /\b(?:python(?:3)?\s+-m\s+)?(?:uvicorn|gunicorn|flask|fastapi)\b.*\b(?:--reload|--host|--port)\b/,
      /\b(?:tail|less)\s+-(?:[a-z]*f|f[a-z]*)\b/,
      /\b(?:docker|podman)\s+logs\b.*\s-f\b/,
      /\bkubectl\s+logs\b.*\s-f\b/,
      /\bjournalctl\b.*\s-f\b/,
    ];

    return longRunningPatterns.some((pattern) => pattern.test(normalized));
  }

  _emitDetachedShellNotice(toolId, name, input = {}) {
    const detail = String(input.command || input.cmd || input.script || "")
      .trim()
      .slice(0, 160);
    this._emitEngineNotice({
      code: "shellDetached",
      level: "progress",
      panel: true,
      replace: true,
      done: true,
      toolName: name,
      detail,
    });
    this.emit("tool-done", {
      id: toolId,
      status: "done",
      result: {
        content: detail
          ? `Command is running in the background: ${detail}`
          : "Command is running in the background.",
        truncated: false,
        detached: true,
      },
    });
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
    });

    if (detached) this._pendingToolIds.delete(toolId);
    else this._pendingToolIds.add(toolId);

    if (detached) {
      this._clearToolLeaseNoticeTimer(toolId);
    } else if (this._isShellTool(nextName) && !this._toolLeaseNoticeTimers.has(toolId)) {
      const detail = String(nextInput.command || nextInput.cmd || nextInput.script || "")
        .trim()
        .slice(0, 160);
      const timer = setTimeout(() => {
        this._toolLeaseNoticeTimers.delete(toolId);
        if (!this.busy || this._turnSettled || !this._toolLeases.has(toolId)) return;
        this._emitEngineNotice({
          code: "shellLongRunning",
          level: "progress",
          panel: true,
          replace: true,
          toolName: nextName,
          detail,
        });
      }, AgentSession.TOOL_LONG_TASK_NOTICE_MS);
      this._toolLeaseNoticeTimers.set(toolId, timer);
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
    if (!toolId) return;
    this._pendingToolIds.delete(toolId);
    this._toolLeases.delete(toolId);
    this._clearToolLeaseNoticeTimer(toolId);
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
      log.warn("turn completed via message_stop grace (no result event)");
      this._flushLineBuffer();
      this._completeTurn({
        code: 0,
        output: this.collectedOutput.trim(),
        idle: true,
      });
    }, AgentSession.MESSAGE_STOP_GRACE_MS);
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
      throw new Error(`工作目录不存在：${cwd}`);
    }
    if (!fs.existsSync(options.agentCommand)) {
      throw new Error(`找不到助手引擎：${options.agentCommand}`);
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
      "--permission-mode",
      opts.permissionMode || "default",
      "--permission-prompt-tool",
      "stdio",
    ];

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
      const raw = chunk.toString();
      const text = sanitizeError(raw);
      const { isResumeFailureMessage } = require("./session-engine-recovery");
      if (
        this.busy &&
        !this._turnSettled &&
        this.agentResumeId &&
        isResumeFailureMessage(raw)
      ) {
        this.emit("resume-invalid", { message: raw });
        this._failTurn("对话连接已刷新，请重新发送这条消息。");
        return;
      }
      this.emit("engine-notice", {
        code: "stderr",
        level: "warning",
        message: text,
        panel: true,
        toast: true,
        done: true,
      });
      this.emit("stderr", text);
      if (text) this.lastSpawnError = text;
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

  _maybeSendInitialize() {
    if (this._cliInitialized || !this.isAlive()) return;
    // --resume sessions are initialized by the CLI; host initialize breaks resume.
    if (this.agentResumeId) return;
    this._cliInitialized = true;
    this._writeControlLine(buildInitializeRequest());
  }

  /**
   * @param {{ text?: string, files?: Array<Record<string, unknown>> }} payload
   */
  sendUserMessage(payload) {
    if (this.busy) {
      this.emit("error", "BUSY");
      return false;
    }

    const text = typeof payload === "string" ? payload : payload?.text;
    const files = typeof payload === "object" && payload?.files ? payload.files : [];

    if (!hasSendableContent(text, files)) return false;

    try {
      this._ensureAliveForSend();
    } catch (err) {
      this.emit("error", sanitizeError(err.message));
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
    this._backgroundActivityUntil = 0;
    this._clearPendingPermissions(true);
    this._streamingToolInputs.clear();
    this._emittedToolIds.clear();
    this._blockIndexToToolId.clear();
    this.emit("status", "thinking");
    this._armWaitNoticeTimers();

    this._maybeSendInitialize();

    const userPayload = buildUserMessagePayload({
      text,
      files,
      sessionId: this.agentResumeId,
      parentToolUseId: this._streamParentToolUseId,
    });
    if (!userPayload) {
      this._failTurn("消息内容为空。");
      return false;
    }

    const line = `${JSON.stringify(userPayload)}\n`;
    const stdin = this.process.stdin;
    if (!stdin || stdin.destroyed) {
      this._failTurn("助手连接已断开，请重试。");
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
      this._writeControlLine(
        buildControlResponse(requestId, {
          behavior: "deny",
          message: decision.message || "User denied this action",
        }),
      );
      this._writeControlLine(buildControlCancelRequest(requestId));
    }
    this.emit("permission-cancelled", { requestId });
    this._markStreamActivity();
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
    this.emit("permission-cancelled", { requestId });
    this._markStreamActivity();
    return true;
  }

  cancelPermissionRequest(requestId) {
    if (!this._pendingPermissions.has(requestId)) return false;
    this._pendingPermissions.delete(requestId);
    this._writeControlLine(buildControlCancelRequest(requestId));
    this.emit("permission-cancelled", { requestId });
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
      });
    }
  }

  terminate() {
    this._clearIdleTimer();
    this._clearInterruptFallback();
    this._denyAllPendingPermissions("Session ended");
    this._clearPendingPermissions(true);
    this._clearToolLeaseNoticeTimers();
    this._clearWaitNoticeTimers();
    this._clearInternalCommandTimer();
    this._pendingToolIds.clear();
    this._toolLeases.clear();
    this._turnHadToolUse = false;
    this._backgroundActivityUntil = 0;
    if (!this.process) {
      this.cwd = null;
      this.spawnOptions = null;
      this.lineBuf = "";
      this.collectedOutput = "";
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
  }

  _completeTurn(payload) {
    if (this._turnSettled) return;
    this._clearIdleTimer();
    this._clearTurnResponseTimer();
    this._clearAbsoluteTurnTimer();
    this._clearPostToolWaitTimer();
    this._clearMessageStopTimer();
    this._clearInterruptFallback();
    this._clearToolLeaseNoticeTimers();
    this._clearWaitNoticeTimers();
    this._clearInternalCommandTimer();
    this._clearPendingPermissions(true);
    this._pendingToolIds.clear();
    this._toolLeases.clear();
    this._turnHadToolUse = false;
    this._backgroundActivityUntil = 0;
    this._streamParentToolUseId = null;
    this._streamingToolInputs.clear();
    this._emittedToolIds.clear();
    this._blockIndexToToolId.clear();
    this._turnSettled = true;
    this.busy = false;
    this.emit("done", payload);
  }

  _failTurn(message) {
    if (this._turnSettled) return;
    this._clearIdleTimer();
    this._clearMessageStopTimer();
    this._clearTurnResponseTimer();
    this._clearAbsoluteTurnTimer();
    this._clearPostToolWaitTimer();
    this._clearInterruptFallback();
    this._clearToolLeaseNoticeTimers();
    this._clearWaitNoticeTimers();
    this._clearInternalCommandTimer();
    this._clearPendingPermissions(true);
    this._pendingToolIds.clear();
    this._toolLeases.clear();
    this._turnHadToolUse = false;
    this._streamParentToolUseId = null;
    this._streamingToolInputs.clear();
    this._emittedToolIds.clear();
    this._blockIndexToToolId.clear();
    this._turnSettled = true;
    this.busy = false;
    this.emit("error", message);
  }

  _onStdout(chunk) {
    this.lineBuf += chunk.toString();
    const lines = this.lineBuf.split("\n");
    this.lineBuf = lines.pop() || "";
    for (const line of lines) {
      this._handleLine(line);
    }
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
      this.emit("permission-cancelled", { requestId });
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
    this.emit("permission-request", {
      requestId,
      toolName,
      input,
      title,
      description,
      decisionReason,
      suggestions,
      planPreview,
      planPreviewTruncated: planPreview.length >= PLAN_PREVIEW_MAX,
    });

    setTimeout(() => {
      if (!this._pendingPermissions.has(requestId)) return;
      this.emit("engine-notice", {
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
    this.emit("ask-user-question", {
      requestId,
      input,
      questions,
    });
  }

  _emitEngineNotice(notice) {
    if (!notice) return;
    this.emit("engine-notice", notice);
  }

  _appendTextPiece(piece) {
    if (!piece) return;
    if (this.busy && !this._turnSettled && isUpstreamApiFailure(piece)) {
      this._failTurn(sanitizeError(piece));
      return;
    }
    this.collectedOutput = appendTextSegment(this.collectedOutput, piece);
    this.emit("chunk", piece);
    this._markStreamActivity();
  }

  _handleTurnResult(ev) {
    this._clearMessageStopTimer();
    this._flushLineBuffer();
    if (ev.modelUsage && typeof ev.modelUsage === "object") {
      require("./usage-reporter").recordModelUsage(this.sessionId, ev.modelUsage);
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
    const output =
      this.collectedOutput.trim() ||
      (typeof ev.error === "string" ? sanitizeError(ev.error) : "") ||
      (typeof ev.message === "string" ? sanitizeError(ev.message) : "");
    this._completeTurn({
      code: resultFailed ? 1 : 0,
      output,
      interrupted: Boolean(this._interruptPending || ev.interrupted),
    });
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
        this._failTurn("对话连接已刷新，请重新发送这条消息。");
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
            this.emit("agent-resume-id", action.sessionId);
          }
        }
        this._emitEngineNotice(action.notice);
        break;

      case "engine_notice":
        this._emitEngineNotice(action.notice);
        break;

      case "protocol_warning":
      case "unknown_runtime_event":
      case "unknown_control_request":
        this._emitEngineNotice(action.notice);
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
        this._appendTextPiece(action.text || "");
        break;

      case "assistant_tool_use": {
        this._turnHadToolUse = true;
        const lease = this._trackToolLease(action.id, action.name, action.input || {});
        this._clearIdleTimer();
        this._clearPostToolWaitTimer();
        this._markStreamActivity();
        if (this._emittedToolIds.has(action.id)) {
          this.emit("tool-input-done", {
            id: action.id,
            input: action.input || {},
          });
          const updatedLease = this._updateToolLeaseInput(action.id, action.input || {});
          if (lease.becameDetached || updatedLease.becameDetached) {
            this._emitDetachedShellNotice(action.id, action.name, action.input || {});
          }
          this._streamingToolInputs.delete(action.id);
          break;
        }
        this.emit("tool-using", {
          name: action.name,
          input: action.input || {},
          id: action.id,
          parentToolUseId: action.parentToolUseId || null,
        });
        if (lease.becameDetached) {
          this._emitDetachedShellNotice(action.id, action.name, action.input || {});
        }
        break;
      }

      case "tool_result": {
        this._finishToolLease(action.id);
        this._maybeArmPostToolWaitTimer();
        const uiResult = action.content ? truncateToolResultForUi(action.content) : null;
        this.emit("tool-done", {
          id: action.id,
          status: action.isError ? "failed" : "done",
          result: uiResult ? { ...uiResult, isError: action.isError } : null,
        });
        this._markStreamActivity();
        break;
      }

      case "stream_message_start":
        this._streamingToolInputs.clear();
        this._emittedToolIds.clear();
        this._blockIndexToToolId.clear();
        this.emit("status", "thinking");
        break;

      case "stream_tool_start":
        this._turnHadToolUse = true;
        this._clearIdleTimer();
        this._clearPostToolWaitTimer();
        this._trackToolLease(action.id, action.name, action.input || {});
        this._emittedToolIds.add(action.id);
        this._streamingToolInputs.set(action.id, "");
        if (typeof action.index === "number" && action.index >= 0) {
          this._blockIndexToToolId.set(action.index, action.id);
        }
        this.emit("tool-upcoming", {
          id: action.id,
          name: action.name,
          parentToolUseId: action.parentToolUseId || null,
        });
        break;

      case "stream_tool_input_delta": {
        const toolId = this._blockIndexToToolId.get(action.index);
        if (toolId) {
          const accumulated = (this._streamingToolInputs.get(toolId) || "") + action.partialJson;
          this._streamingToolInputs.set(toolId, accumulated);
          this.emit("tool-input-delta", { id: toolId, partialJson: action.partialJson });
        }
        break;
      }

      case "stream_content_block_stop": {
        const toolId = this._blockIndexToToolId.get(action.index);
        const parsed = this._tryParseToolInputJson(toolId);
        if (parsed) {
          const lease = this._updateToolLeaseInput(toolId, parsed);
          if (lease.becameDetached) {
            const entry = this._toolLeases.get(toolId);
            this.emit("tool-input-done", { id: toolId, input: parsed });
            this._emitDetachedShellNotice(toolId, entry?.name || "unknown", parsed);
          }
        }
        break;
      }

      case "stream_message_stop":
        this._markStreamActivity();
        this._armMessageStopCompletionTimer();
        break;

      case "prompt_suggestions":
        this.emit("prompt-suggestions", { suggestions: action.suggestions || [] });
        break;

      case "control_cancel":
        if (action.requestId && this._pendingPermissions.has(action.requestId)) {
          this._pendingPermissions.delete(action.requestId);
          this.emit("permission-cancelled", { requestId: action.requestId });
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
          this.emit("prompt-suggestions", { suggestions: action.suggestions });
        }
        break;

      case "hook_callback":
        this._emitEngineNotice(action.notice);
        this._writeControlLine(
          buildHookCallbackResponse(action.requestId, {
            continue: true,
            ...action.hookEvent,
          }),
        );
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

    if (this._isBackgroundActivityEvent(ev)) {
      const subtype = String(ev.subtype || "");
      this._markBackgroundActivity(
        subtype.endsWith("_complete") ||
          subtype.endsWith("_completed") ||
          subtype.endsWith("_failed"),
      );
    }

    for (const action of normalizeClaudeEvent(ev)) {
      this._handleNormalizedAction(action);
    }
  }
}

module.exports = { AgentSession };
