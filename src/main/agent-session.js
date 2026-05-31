"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { appendTextSegment, sanitizeError } = require("./agent-runner");
const {
  parseCanUseToolRequest,
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
const { buildUserMessagePayload, hasSendableContent } = require("./user-message");
const { resolvePlanPreview, PLAN_PREVIEW_MAX } = require("./plan-preview");
const { buildAgentSpawnEnv } = require("./spawn-env");
const { sameRespawnOptions } = require("./runner-spawn-options");
const { getLogger } = require("./logger");
const log = getLogger("agent-session");

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
    this.agentResumeId = null;
    this.spawnOptions = null;
    this.lastSpawnError = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._idleTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  this._interruptFallbackTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  this._turnResponseTimer = null;
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
  }

  /** Only for text-only turns missing `result` (not a task timeout). */
  static QUIESCE_MS = 12_000;
  static INTERRUPT_FALLBACK_MS = 5_000;
  static PERMISSION_UI_TIMEOUT_MS = 55_000;
  static TURN_RESPONSE_TIMEOUT_MS = 90_000;
  static RESUME_TURN_TIMEOUT_MS = 45_000;

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

  _armTurnResponseTimer() {
    this._clearTurnResponseTimer();
    if (!this.busy || this._turnSettled) return;
    const ms = this.agentResumeId
      ? AgentSession.RESUME_TURN_TIMEOUT_MS
      : AgentSession.TURN_RESPONSE_TIMEOUT_MS;
    this._turnResponseTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled) return;
      log.warn("turn timed out waiting for engine response", {
        sessionId: this.sessionId,
        resume: Boolean(this.agentResumeId),
      });
      if (this.agentResumeId) {
        this.emit("resume-invalid", { message: "resume session timed out" });
      }
      this._failTurn("助手长时间无响应，连接已重置。请再发一次消息。");
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

  _armIdleCompletionTimer() {
    this._clearIdleTimer();
    if (!this.busy || this._turnSettled) return;
    if (this._turnHadToolUse || this._pendingToolIds.size > 0) return;
    if (this._pendingPermissions.size > 0) return;
    if (!this.collectedOutput.trim()) return;
    this._idleTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled) return;
      if (this._turnHadToolUse || this._pendingToolIds.size > 0) return;
      if (this._pendingPermissions.size > 0) return;
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

  _markStreamActivity() {
    if (!this.busy || this._turnSettled) return;
    this._armTurnResponseTimer();
    this._armIdleCompletionTimer();
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
        this._failTurn(text);
        return;
      }
      this.emit("engine-notice", { level: "stderr", message: text });
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
      this._clearInterruptFallback();
      if (this.busy && !this._turnSettled) {
        this._flushLineBuffer();
        this._completeTurn({
          code,
          output: this.collectedOutput.trim(),
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
    this.collectedOutput = "";
    this._streamParentToolUseId = null;
    this._pendingToolIds.clear();
    this._turnHadToolUse = false;
    this._clearPendingPermissions(true);
    this._streamingToolInputs.clear();
    this._emittedToolIds.clear();
    this._blockIndexToToolId.clear();
    this.emit("status", "thinking");

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
        allowDecision.updatedPermissions = buildRememberAllowPermissions(
          pending.toolName,
        );
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

  interrupt() {
    this._denyAllPendingPermissions("Session interrupted");

    if (this.busy && !this._turnSettled && this.isAlive()) {
      this._interruptPending = true;
      this._writeControlLine(buildInterruptRequest());
      this._interruptFallbackTimer = setTimeout(() => {
        if (this.busy && !this._turnSettled) {
          log.warn("interrupt control timed out, force killing CLI");
          this._forceInterruptKill();
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

  _forceInterruptKill() {
    this._clearInterruptFallback();
    if (this.process) {
      try {
        // SIGINT on Windows only works for console group — spawn()ed processes need SIGTERM.
        const sig = process.platform === "win32" ? "SIGTERM" : "SIGINT";
        this.process.kill(sig);
      } catch {
        log.warn("interrupt kill failed (process already dead)");
      }
      this.process = null;
      this._cliInitialized = false;
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
    this._pendingToolIds.clear();
    this._turnHadToolUse = false;
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
    this._clearInterruptFallback();
    this._clearPendingPermissions(true);
    this._pendingToolIds.clear();
    this._turnHadToolUse = false;
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
    this._clearTurnResponseTimer();
    this._clearInterruptFallback();
    this._clearPendingPermissions(true);
    this._pendingToolIds.clear();
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

  _handleControlRequest(ev) {
    const requestId =
      ev.request_id ||
      (typeof ev.request?.request_id === "string" ? ev.request.request_id : "");
    const subtype = ev.request?.subtype;

    const canUse = parseCanUseToolRequest(ev);
    if (canUse) {
      this._handleCanUseTool(canUse);
      return;
    }

    if (requestId && subtype === "initialize") {
      this._cliInitialized = true;
      this._writeControlLine(buildControlAck(requestId, { promptSuggestions: true }));
      const suggestions =
        ev.request?.prompt_suggestions ||
        ev.request?.suggestions ||
        ev.request?.promptSuggestions ||
        [];
      if (Array.isArray(suggestions) && suggestions.length) {
        this.emit("prompt-suggestions", { suggestions });
      }
      return;
    }

    if (requestId && subtype === "hook_callback") {
      const hookEvent =
        ev.request?.hook_event && typeof ev.request.hook_event === "object"
          ? ev.request.hook_event
          : {};
      this._writeControlLine(
        buildHookCallbackResponse(requestId, {
          continue: true,
          ...hookEvent,
        }),
      );
      return;
    }

    if (requestId) {
      log.warn("unhandled control_request subtype=%s", subtype || "unknown");
      this._writeControlLine(buildControlAck(requestId));
    }
  }

  _handleCanUseTool(canUse) {
    const { requestId, toolName, input, title, description, decisionReason } =
      canUse;
    const permissionMode = this.spawnOptions?.permissionMode || "default";

    log.info("permission-check tool=%s mode=%s needsApproval=%s",
      toolName, permissionMode, needsUserApproval(toolName, permissionMode));

    if (!needsUserApproval(toolName, permissionMode)) {
      this._allowToolUse(requestId, input);
      return;
    }

    this._pendingPermissions.set(requestId, { toolName, input });
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
      planPreview,
      planPreviewTruncated: planPreview.length >= PLAN_PREVIEW_MAX,
    });

    setTimeout(() => {
      if (!this._pendingPermissions.has(requestId)) return;
      this.emit("engine-notice", {
        level: "warning",
        message: "PERMISSION_TIMEOUT",
        requestId,
        toolName,
      });
      this.respondPermission(requestId, {
        allow: false,
        message: "Permission request timed out",
      });
    }, AgentSession.PERMISSION_UI_TIMEOUT_MS);
  }

  _appendTextPiece(piece) {
    if (!piece) return;
    this.collectedOutput = appendTextSegment(this.collectedOutput, piece);
    this.emit("chunk", piece);
    this._markStreamActivity();
  }

  _handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      this._appendTextPiece(`${trimmed}\n`);
      return;
    }

    if (!ev?.type) return;

    this._noteStreamContext(ev);

    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") {
          this._cliInitialized = true;
          if (ev.session_id && this.agentResumeId !== ev.session_id) {
            this.agentResumeId = ev.session_id;
            this.emit("agent-resume-id", ev.session_id);
          }
        }
        break;

      case "assistant": {
        const blocks = ev.message?.content;
        if (!blocks) break;
        for (const block of blocks) {
          switch (block.type) {
            case "text":
              this._appendTextPiece(block.text || "");
              break;
            case "tool_use": {
              this._turnHadToolUse = true;
              const toolId = block.id || "";
              if (toolId) this._pendingToolIds.add(toolId);
              this._clearIdleTimer();
              this._markStreamActivity();
              // If already emitted from content_block_start, skip duplicate emission
              if (this._emittedToolIds.has(toolId)) {
                // But still emit with full input so card can be updated
                this.emit("tool-input-done", {
                  id: toolId,
                  input: block.input || {},
                });
                this._streamingToolInputs.delete(toolId);
                break;
              }
              this.emit("tool-using", {
                name: block.name || "unknown",
                input: block.input || {},
                id: toolId,
                parentToolUseId: ev.parent_tool_use_id || null,
              });
              break;
            }
            default:
              break;
          }
        }
        break;
      }

      case "user": {
        const blocks = ev.message?.content;
        if (!blocks) break;
        for (const block of blocks) {
          if (block.type === "tool_result") {
            const toolId = block.tool_use_id || "";
            if (toolId) this._pendingToolIds.delete(toolId);
            let resultContent = null;
            if (Array.isArray(block.content)) {
              resultContent = block.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n");
            }
            this.emit("tool-done", {
              id: toolId,
              status: block.is_error ? "failed" : "done",
              result: resultContent ? { content: resultContent, isError: !!block.is_error } : null,
            });
            this._markStreamActivity();
          }
        }
        break;
      }

      case "stream_event": {
        const inner = ev.event;
        if (!inner) break;

        switch (inner.type) {
          case "message_start":
            this._streamingToolInputs.clear();
            this._emittedToolIds.clear();
            this._blockIndexToToolId.clear();
            this.emit("status", "thinking");
            break;

          case "content_block_start": {
            const block = inner.content_block;
            if (block?.type === "tool_use" && block.id && block.name) {
              this._turnHadToolUse = true;
              this._clearIdleTimer();
              this._emittedToolIds.add(block.id);
              this._streamingToolInputs.set(block.id, "");
              if (typeof inner.index === "number") {
                this._blockIndexToToolId.set(inner.index, block.id);
              }
              this.emit("tool-upcoming", {
                id: block.id,
                name: block.name,
                parentToolUseId: ev.parent_tool_use_id || null,
              });
            }
            break;
          }

          case "content_block_delta": {
            const delta = inner.delta;
            if (delta?.type === "text_delta") {
              this._appendTextPiece(delta.text || "");
            } else if (delta?.type === "input_json_delta" && delta.partial_json) {
              const idx = typeof inner.index === "number" ? inner.index : -1;
              const toolId = this._blockIndexToToolId.get(idx);
              if (toolId) {
                const accumulated = (this._streamingToolInputs.get(toolId) || "") + delta.partial_json;
                this._streamingToolInputs.set(toolId, accumulated);
                this.emit("tool-input-delta", { id: toolId, partialJson: delta.partial_json });
              }
            }
            break;
          }

          case "content_block_stop":
            // Tool input streaming complete — no action needed; assistant event will follow
            break;

          case "message_stop":
            this._markStreamActivity();
            break;

          default:
            break;
        }
        break;
      }

      case "tool_progress":
        this.emit("engine-notice", {
          level: "progress",
          message: ev.message || ev.summary || "",
          toolName: ev.tool_name || "",
        });
        this._turnHadToolUse = true;
        this._clearIdleTimer();
        break;

      case "tool_use_summary":
        if (ev.summary) {
          this.emit("engine-notice", {
            level: "info",
            message: String(ev.summary),
          });
        }
        break;

      case "keep_alive":
        break;

      case "prompt_suggestion":
      case "prompt_suggestions":
        this.emit("prompt-suggestions", {
          suggestions: ev.suggestions || ev.prompt_suggestions || [],
        });
        break;

      case "control_cancel_request": {
        const cancelId = ev.request_id || ev.request?.request_id;
        if (cancelId && this._pendingPermissions.has(cancelId)) {
          this._pendingPermissions.delete(cancelId);
          this.emit("permission-cancelled", { requestId: cancelId });
        }
        break;
      }

      case "result":
        this._flushLineBuffer();
        if (ev.subtype === "success" && ev.result) {
          const piece = String(ev.result);
          if (piece && !this.collectedOutput.includes(piece)) {
            this._appendTextPiece(piece);
          }
        }
        this._completeTurn({
          code: ev.is_error ? 1 : 0,
          output: this.collectedOutput.trim(),
          interrupted: Boolean(this._interruptPending || ev.interrupted),
        });
        break;

      case "error": {
        const errMsg =
          (ev.error && typeof ev.error === "object" ? ev.error.message : "") ||
          ev.message ||
          "";
        log.warn("CLI error event: %s", errMsg || JSON.stringify(ev).slice(0, 200));
        if (this.busy && !this._turnSettled) {
          const { isResumeFailureMessage } = require("./session-engine-recovery");
          if (this.agentResumeId && isResumeFailureMessage(errMsg)) {
            this.emit("resume-invalid", { message: errMsg });
          }
          this._failTurn(sanitizeError(errMsg || "Engine error"));
          return;
        }
        if (errMsg) {
          this.emit("engine-notice", { level: "warning", message: errMsg });
        }
        break;
      }

      case "control_request":
      case "sdk_control_request":
        this._handleControlRequest(ev);
        break;

      default:
        log.debug("ignored stream event type=%s", ev.type);
        break;
    }
  }
}

module.exports = { AgentSession };
