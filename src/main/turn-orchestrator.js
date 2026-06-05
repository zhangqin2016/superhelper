"use strict";

const crypto = require("node:crypto");
const { normalizeAssistantOutput, sanitizeError } = require("./agent-runner");
const { fileMetadataFromPayload } = require("./ipc-utils");

const TERMINAL_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.stalled",
]);

const TURN_OPTIONAL_TYPES = new Set([
  "session.hydrated",
  "resume.updated",
  "resume.invalid",
  "queue.updated",
  "user.committed",
  "engine.notice",
  "engine.warning",
  "engine.stderr",
  "prompt_suggestions.updated",
]);

function newTurnId() {
  return `turn_${crypto.randomUUID()}`;
}

function newQueueId() {
  return `queue_${crypto.randomUUID()}`;
}

function compactToolInput(input) {
  if (!input || typeof input !== "object") return {};
  const command = input.command || input.cmd || input.script || "";
  const filePath = input.file_path || input.path || input.filePath || "";
  return {
    ...input,
    preview: String(command || filePath || JSON.stringify(input)).slice(0, 300),
  };
}

function isRecoverableFailure(raw) {
  return /API Error:|socket connection was closed|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network error|502|503|504|rate.?limit|429/i.test(String(raw || ""));
}

class TurnOrchestrator {
  constructor(ctx) {
    this.ctx = ctx;
    this.eventBus = ctx.eventBus;
    this.transcriptStore = ctx.transcriptStore;
    this.states = new Map();
    this.attachedRunners = new WeakSet();
  }

  snapshot(sessionId) {
    const state = this._state(sessionId);
    return {
      ok: true,
      sessionId,
      phase: state.phase,
      turnId: state.turnId,
      canSend: state.phase === "idle",
      canInterrupt: state.phase !== "idle" && state.phase !== "finalizing",
      queueLength: state.queue.length,
      queue: state.queue.map((item) => ({
        id: item.id,
        text: item.text,
        files: item.displayFiles || [],
      })),
      runtime: this.eventBus.snapshot(sessionId),
    };
  }

  attachRunner(runner) {
    if (!runner || this.attachedRunners.has(runner)) return;
    this.attachedRunners.add(runner);
    const sessionId = runner.sessionId;

    runner.on("status", (status) => {
      if (status === "thinking") {
        this._emit(sessionId, "turn.accepted", { status });
      } else {
        this._emit(sessionId, "engine.notice", { code: "status", status });
      }
    });

    runner.on("chunk", (text) => {
      const state = this._state(sessionId);
      state.phase = "streaming";
      state.assistantText += String(text || "");
      this._emit(sessionId, "assistant.delta", { text: String(text || "") });
    });

    runner.on("thinking-delta", (data) => {
      const state = this._state(sessionId);
      state.phase = "streaming";
      this._emit(sessionId, "assistant.thinking.delta", {
        text: String(data?.text || ""),
      });
    });

    runner.on("tool-upcoming", (data) => {
      this._trackTool(sessionId, data.id, { name: data.name, input: {} });
      this._emit(sessionId, "tool.started", {
        id: data.id,
        name: data.name || "unknown",
        input: {},
        parentToolUseId: data.parentToolUseId || null,
      });
    });

    runner.on("tool-input-delta", (data) => {
      const tool = this._trackTool(sessionId, data.id, {});
      tool.partialJson = (tool.partialJson || "") + String(data.partialJson || "");
      this._emit(sessionId, "tool.input.delta", {
        id: data.id,
        partialJson: String(data.partialJson || ""),
      });
    });

    runner.on("tool-input-done", (data) => {
      const tool = this._trackTool(sessionId, data.id, { input: data.input || {} });
      tool.input = data.input || tool.input || {};
      this._emit(sessionId, "tool.input.done", {
        id: data.id,
        input: compactToolInput(tool.input),
      });
    });

    runner.on("tool-using", (data) => {
      const state = this._state(sessionId);
      state.phase = "tool_running";
      this._trackTool(sessionId, data.id, {
        name: data.name,
        input: data.input || {},
        status: "running",
      });
      require("./usage-reporter").recordToolCall(sessionId, data);
      const { captureBeforeSnapshot } = require("./diff-capture");
      captureBeforeSnapshot(sessionId, data.id, data.name, data.input);
      this._emit(sessionId, "tool.started", {
        id: data.id,
        name: data.name || "unknown",
        input: compactToolInput(data.input || {}),
        parentToolUseId: data.parentToolUseId || null,
      });
      if (data.input) {
        this._emit(sessionId, "tool.input.done", {
          id: data.id,
          input: compactToolInput(data.input),
        });
      }
    });

    runner.on("tool-done", (data) => {
      const tool = this._trackTool(sessionId, data.id, {});
      tool.status = data.status || "done";
      tool.result = data.result || null;
      this._emit(sessionId, "tool.done", {
        id: data.id,
        status: tool.status,
        result: data.result || null,
      });
      const { emitDiffForTool } = require("./diff-capture");
      emitDiffForTool(sessionId, data.id, this.ctx);
    });

    runner.on("permission-request", (data) => {
      const state = this._state(sessionId);
      state.phase = "awaiting_user";
      state.pendingPermissions.set(data.requestId, data);
      this._emit(sessionId, "permission.requested", data);
    });

    runner.on("ask-user-question", (data) => {
      const state = this._state(sessionId);
      state.phase = "awaiting_user";
      state.pendingQuestions.set(data.requestId, data);
      this._emit(sessionId, "user_question.requested", data);
    });

    runner.on("permission-cancelled", (data) => {
      const state = this._state(sessionId);
      state.pendingPermissions.delete(data.requestId);
      state.pendingQuestions.delete(data.requestId);
      if (state.phase === "awaiting_user") state.phase = "streaming";
      this._emit(sessionId, "permission.resolved", {
        requestId: data.requestId,
        cancelled: Boolean(data.cancelled),
      });
    });

    runner.on("hook-request", (data) => {
      const state = this._state(sessionId);
      state.phase = "awaiting_user";
      state.pendingHooks.set(data.requestId, data);
      this._emit(sessionId, "hook.requested", data);
    });

    runner.on("hook-resolved", (data) => {
      const state = this._state(sessionId);
      state.pendingHooks.delete(data.requestId);
      if (state.phase === "awaiting_user") state.phase = "streaming";
      this._emit(sessionId, "hook.resolved", data);
    });

    runner.on("engine-notice", (notice) => {
      if (notice?.code === "permissionTimeout") {
        this._emit(sessionId, "permission.timeout", {
          requestId: notice.requestId || "",
          toolName: notice.toolName || "",
          notice,
        });
      }
      this._emit(sessionId, notice?.level === "warning" ? "engine.warning" : "engine.notice", {
        notice,
      });
    });

    runner.on("usage-updated", (data) => {
      this._emit(sessionId, "usage.updated", data || {});
    });

    runner.on("message-stop", () => {
      this._emit(sessionId, "assistant.message_stop", {});
    });

    runner.on("process-event", (data) => {
      this._emit(sessionId, "process.event", data || {});
    });

    runner.on("message-stop-grace", () => {
      const state = this._state(sessionId);
      if (!state.turnId || state.terminalEmitted) return;
      runner.completeFromHost?.("message_stop_grace");
    });

    runner.on("stderr", (text) => {
      this._emit(sessionId, "engine.stderr", { text: String(text || "") });
    });

    runner.on("agent-resume-id", (agentResumeId) => {
      this.ctx.sessionManager.setAgentResumeId(sessionId, agentResumeId);
      this._emit(sessionId, "session.hydrated", { agentResumeId });
      this._emit(sessionId, "resume.updated", { agentResumeId });
    });

    runner.on("resume-invalid", (payload) => {
      this.ctx.sessionManager.clearAgentResumeId(sessionId);
      this.ctx.runnerPool.terminateSession(sessionId);
      this._emit(sessionId, "resume.invalid", {
        message: payload?.message || "",
      });
      const state = this._state(sessionId);
      if (state.turnId && !state.terminalEmitted) {
        this._finalize(sessionId, "turn.failed", {
          failed: true,
          code: "RESUME_INVALID",
          retryable: true,
          assistant: "连接已刷新，请重新发送。",
        });
      }
    });

    runner.on("prompt-suggestions", (data) => {
      this.eventBus.emit(sessionId, {
        type: "prompt_suggestions.updated",
        turnId: null,
        source: "orchestrator",
        payload: { suggestions: data?.suggestions || [] },
      });
      const win = this.ctx.mainWindow;
      if (win && !win.isDestroyed?.()) {
        win.webContents.send("assistant:prompt-suggestions", { sessionId, ...data });
      }
    });

    runner.on("done", (payload) => {
      void this._handleDone(sessionId, payload);
    });

    runner.on("error", (message) => {
      void this._handleError(sessionId, message);
    });
  }

  async sendUserMessage(sessionId, text, files = [], opts = {}) {
    const session = this.ctx.sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const displayText = String(text || "").trim();
    if (!displayText && (!files || files.length === 0)) return { ok: false, error: "EMPTY" };

    const state = this._state(sessionId);
    if (state.phase !== "idle" && !opts.fromQueue && !opts.fromAutoRecovery) {
      const item = {
        id: newQueueId(),
        text: displayText,
        files,
        displayFiles: opts.displayFiles || fileMetadataFromPayload(files),
      };
      state.queue.push(item);
      this._emitQueue(sessionId);
      return { ok: true, queued: true, queueLength: state.queue.length, itemId: item.id };
    }

    return this._startTurn(session, displayText, files, opts);
  }

  async retryLastMessage(sessionId) {
    const session = this.ctx.sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const lastUser = this.ctx.sessionManager.getLastUserMessage(sessionId);
    if (!lastUser) return { ok: false, error: "NO_USER_MESSAGE" };
    this.transcriptStore.removeLastAssistantMessage(sessionId);
    return this.sendUserMessage(sessionId, lastUser.content, lastUser.files || [], {
      recordUser: false,
      spawnEngine: true,
    });
  }

  respondPermission(sessionId, requestId, decision) {
    const runner = this.ctx.runnerPool.get(sessionId);
    if (!runner) return { ok: false, error: "NO_RUNNER" };
    const handled = runner.respondPermission(requestId, decision);
    if (handled) {
      this._state(sessionId).pendingPermissions.delete(requestId);
      this._emit(sessionId, "permission.resolved", { requestId, allow: Boolean(decision.allow) });
    }
    return handled ? { ok: true, sessionId, requestId } : { ok: false, error: "NOT_PENDING" };
  }

  respondUserQuestion(sessionId, requestId, response) {
    const runner = this.ctx.runnerPool.get(sessionId);
    if (!runner) return { ok: false, error: "NO_RUNNER" };
    const handled = runner.respondUserQuestion(requestId, response);
    if (handled) {
      this._state(sessionId).pendingQuestions.delete(requestId);
      this._emit(sessionId, "user_question.resolved", { requestId });
    }
    return handled ? { ok: true, sessionId, requestId } : { ok: false, error: "NOT_PENDING" };
  }

  respondHook(sessionId, requestId, decision) {
    const runner = this.ctx.runnerPool.get(sessionId);
    if (!runner) return { ok: false, error: "NO_RUNNER" };
    const handled = runner.respondHook(requestId, decision);
    if (handled) {
      this._state(sessionId).pendingHooks.delete(requestId);
      this._emit(sessionId, "hook.resolved", { requestId, allow: Boolean(decision.allow) });
    }
    return handled ? { ok: true, sessionId, requestId } : { ok: false, error: "NOT_PENDING" };
  }

  interrupt(sessionId, opts = {}) {
    const state = this._state(sessionId);
    if (opts.clearQueue !== false) {
      state.queue = [];
      this._emitQueue(sessionId);
    }
    const runner = this.ctx.runnerPool.get(sessionId);
    runner?.interrupt();
    if (state.phase !== "idle" && state.turnId && !state.terminalEmitted) {
      this._finalize(sessionId, "turn.interrupted", {
        interrupted: true,
        assistant: state.assistantText,
      });
    }
    return { ok: true };
  }

  async interruptAndSend(sessionId, text, files = [], opts = {}) {
    const state = this._state(sessionId);
    const item = {
      id: newQueueId(),
      text: String(text || "").trim(),
      files,
      displayFiles: opts.displayFiles || fileMetadataFromPayload(files),
    };
    state.queue = [item];
    this._emitQueue(sessionId);
    this.interrupt(sessionId, { clearQueue: false });
    void this._dispatchNext(sessionId);
    return { ok: true, queued: true, priority: true, queueLength: state.queue.length, itemId: item.id };
  }

  async _tryStartQueuedItem(sessionId, item) {
    const runner = this.ctx.runnerPool.get(sessionId);
    if (runner?.isBusy?.()) return false;
    const session = this.ctx.sessionManager.findById(sessionId);
    if (!session) return false;
    const result = await this._startTurn(session, item.text, item.files, {
      fromQueue: true,
      displayFiles: item.displayFiles,
      recordUser: true,
      spawnEngine: true,
    });
    return Boolean(result?.ok);
  }

  cancelQueuedMessage(sessionId, itemId) {
    const state = this._state(sessionId);
    const before = state.queue.length;
    state.queue = state.queue.filter((item) => item.id !== itemId);
    this._emitQueue(sessionId);
    return before !== state.queue.length
      ? { ok: true, sessionId, queueLength: state.queue.length }
      : { ok: false, error: "NOT_FOUND" };
  }

  async _startTurn(session, text, files, opts = {}) {
    const { diagnoseSendBlocker, ensureSessionRunner } = require("./ipc-utils");
    if (!opts.skipPreflight) {
      const blocked = diagnoseSendBlocker(this.ctx, session.id);
      if (blocked) return { ok: false, error: blocked.error, detail: blocked.detail };
    }

    const ensured = opts.skipPreflight
      ? { runner: this.ctx.runnerPool.get(session.id) }
      : ensureSessionRunner(this.ctx, session.id, { spawn: opts.spawnEngine !== false });
    const runner = ensured.runner;
    if (!runner) {
      return {
        ok: false,
        error: ensured.error || "RUNNER_ERROR",
        detail: ensured.detail || "无法启动助手进程，请查看终端日志或重启应用。",
      };
    }

    const state = this._state(session.id);
    state.phase = "starting";
    state.turnId = newTurnId();
    state.assistantText = "";
    state.terminalEmitted = false;
    state.pendingPermissions.clear();
    state.pendingQuestions.clear();
    state.pendingHooks.clear();
    state.tools.clear();
    state.currentPayload = { text, files };
    state.startedAt = Date.now();
    state.updatedAt = Date.now();

    const displayFiles = opts.displayFiles || fileMetadataFromPayload(files);
    if (opts.recordUser !== false) {
      this.transcriptStore.commitUserMessage(session.id, {
        text,
        files: displayFiles,
        turnId: state.turnId,
      });
      this._emit(session.id, "user.committed", {
        text,
        files: displayFiles.length ? displayFiles : null,
      }, { turnId: null });
    }

    this._emit(session.id, "turn.started", {
      text,
      queueLength: state.queue.length,
    });

    const sent = runner.sendUserMessage({ text, files });
    if (!sent) {
      this._finalize(session.id, "turn.failed", {
        failed: true,
        assistant: "助手引擎未接受消息，请重试。",
        code: "RUNNER_REJECTED",
      });
      return { ok: false, error: "RUNNER_ERROR", detail: runner.lastSpawnError || "助手引擎未接受消息，请重试。" };
    }
    require("./usage-reporter").recordUserSend(session.id, files);
    return {
      ok: true,
      turnId: state.turnId,
      userCommitted: opts.recordUser === false ? null : { text, files: displayFiles },
    };
  }

  async _handleDone(sessionId, payload) {
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) {
      void this._dispatchNext(sessionId);
      return;
    }

    const normalized = normalizeAssistantOutput(payload?.output || state.assistantText);
    const interrupted = Boolean(payload?.interrupted);
    const stalled = Boolean(payload?.stalled);
    const failed = Boolean(normalized.failed || (!interrupted && !stalled && payload?.code && payload.code !== 0));

    if (failed && !state.recoveryAttempted && isRecoverableFailure(payload?.output || "")) {
      state.recoveryAttempted = true;
      state.phase = "recovering";
      this._emit(sessionId, "recovery.scheduled", { attempt: 1, maxAttempts: 1 });
      setTimeout(() => {
        void this._recover(sessionId);
      }, 600);
      return;
    }

    if (interrupted) {
      this._finalize(sessionId, "turn.interrupted", {
        interrupted: true,
        assistant: normalized.text || state.assistantText,
      });
    } else if (stalled) {
      this._finalize(sessionId, "turn.stalled", {
        stalled: true,
        assistant: normalized.text || state.assistantText,
      });
    } else if (failed) {
      const friendly = normalized.text || "处理请求时遇到问题，请稍后再试。";
      this._finalize(sessionId, "turn.failed", {
        failed: true,
        assistant: friendly,
      });
    } else {
      this._finalize(sessionId, "turn.completed", {
        assistant: normalized.text || state.assistantText,
      });
    }
    await this._flushUsage(sessionId);
    void this._dispatchNext(sessionId);
  }

  async _handleError(sessionId, message) {
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) return;
    const text = sanitizeError(String(message || ""));
    this._finalize(sessionId, "turn.failed", {
      failed: true,
      assistant: text,
      error: String(message || ""),
    });
    await this._flushUsage(sessionId);
    void this._dispatchNext(sessionId);
  }

  async _recover(sessionId) {
    const state = this._state(sessionId);
    const payload = state.currentPayload;
    if (!payload || state.terminalEmitted) return;
    this._emit(sessionId, "recovery.started", { attempt: 1 });
    state.phase = "starting";
    const runner = this.ctx.runnerPool.get(sessionId);
    if (!runner) {
      this._finalize(sessionId, "turn.failed", {
        failed: true,
        assistant: "连接恢复失败，请重新发送。",
      });
      return;
    }
    runner.sendUserMessage(payload);
  }

  _finalize(sessionId, type, payload = {}) {
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) return;
    if (!TERMINAL_TYPES.has(type)) throw new Error(`Invalid terminal event ${type}`);
    state.phase = "finalizing";
    const assistant = String(payload.assistant || state.assistantText || "").trim();
    if (assistant) {
      this._emit(sessionId, "assistant.final", {
        assistant,
        failed: type === "turn.failed",
      });
      this.transcriptStore.commitAssistantMessage(sessionId, {
        text: assistant,
        failed: type === "turn.failed",
        turnId: state.turnId,
        meta: {
          terminal: type,
          interrupted: type === "turn.interrupted",
          stalled: type === "turn.stalled",
          tools: state.tools.size,
        },
      });
    }
    state.terminalEmitted = true;
    this._emit(sessionId, type, {
      ...payload,
      assistant,
      toolsSummary: { count: state.tools.size },
    });
    state.phase = "idle";
    state.turnId = null;
    state.assistantText = "";
    state.currentPayload = null;
    state.pendingPermissions.clear();
    state.pendingQuestions.clear();
    state.pendingHooks.clear();
  }

  async _dispatchNext(sessionId) {
    const state = this._state(sessionId);
    if (state.phase !== "idle" || state.queue.length === 0) return;
    const next = state.queue[0];
    const started = await this._tryStartQueuedItem(sessionId, next);
    if (!started) return;
    state.queue.shift();
    this._emitQueue(sessionId);
  }

  _emitQueue(sessionId) {
    const state = this._state(sessionId);
    this._emit(sessionId, "queue.updated", {
      items: state.queue.map((item) => ({
        id: item.id,
        text: item.text,
        files: item.displayFiles || [],
      })),
    }, { turnId: state.turnId || null });
  }

  async _flushUsage(sessionId) {
    try {
      await require("./usage-reporter").flush(sessionId);
    } catch (err) {
      if (/getPath/.test(String(err?.message || err || ""))) return;
      console.warn("[turn-orchestrator] usage flush failed:", err?.message || err);
    }
  }

  _trackTool(sessionId, id, patch) {
    const state = this._state(sessionId);
    const toolId = id || `tool_${state.tools.size + 1}`;
    const existing = state.tools.get(toolId) || { id: toolId };
    Object.assign(existing, patch || {});
    state.tools.set(toolId, existing);
    return existing;
  }

  _emit(sessionId, type, payload = {}, opts = {}) {
    const state = this._state(sessionId);
    if (state.terminalEmitted && state.turnId && !TERMINAL_TYPES.has(type)) return null;
    const turnId = opts.turnId === undefined ? state.turnId : opts.turnId;
    if (!turnId && !TURN_OPTIONAL_TYPES.has(type)) {
      return this.eventBus.emit(sessionId, {
        type: "engine.warning",
        turnId: null,
        source: "orchestrator",
        payload: {
          notice: {
            code: "orphanRuntimeEvent",
            level: "warning",
            detail: `Ignored ${type} without an active turn.`,
            originalType: type,
          },
        },
      })[0];
    }
    return this.eventBus.emit(sessionId, {
      type,
      turnId,
      source: opts.source || "orchestrator",
      payload,
    })[0];
  }

  _state(sessionId) {
    if (!this.states.has(sessionId)) {
      this.states.set(sessionId, {
        sessionId,
        phase: "idle",
        turnId: null,
        assistantText: "",
        queue: [],
        tools: new Map(),
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        pendingHooks: new Map(),
        terminalEmitted: false,
        recoveryAttempted: false,
        currentPayload: null,
        startedAt: 0,
        updatedAt: 0,
      });
    }
    return this.states.get(sessionId);
  }
}

module.exports = { TurnOrchestrator };
