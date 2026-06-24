"use strict";

const crypto = require("node:crypto");
const {
  normalizeAssistantOutput,
  sanitizeError,
  classifyAssistantError,
} = require("./agent-runner");
const { fileMetadataFromPayload } = require("./ipc-utils");
const { getLogger } = require("./logger");
const { sanitizeNoticeForIngest } = require("./engine-notice-policy");
const {
  activityFromEngineNotice,
  activityFromProcessPayload,
  appendTimelineNotice,
  appendTimelineText,
  closeStreamingBlocks,
  resetTimelineState,
  setActivityLabel,
  upsertTimelineThinking,
  upsertTimelineTool,
} = require("./turn-timeline");
const {
  classifyTurnFailure,
  preflightFailureText,
  collectFailureTextFromState,
  appendIncompleteTurnSummary,
} = require("./turn-error-classify");
const { runVisionPreflight, runDocumentPreflight } = require("./send-preflight");
const { buildTaskContract, withTaskContractPrefix } = require("./task-contract");
const { TurnRunCoordinator } = require("./turn-run-coordinator");

const log = getLogger("turn-orchestrator");

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

function queueDispatchOptions(opts = {}) {
  return {
    engineText: typeof opts.engineText === "string" ? opts.engineText : null,
    reloadSkillsBeforeStart: Boolean(opts.reloadSkillsBeforeStart),
    spawnEngine: opts.spawnEngine,
    skipPreflight: Boolean(opts.skipPreflight),
    skipVision: Boolean(opts.skipVision),
    skipDocument: Boolean(opts.skipDocument),
    scheduledTaskId: opts.scheduledTaskId || null,
    scheduledTaskRunId: opts.scheduledTaskRunId || null,
    scheduledTaskTitle: opts.scheduledTaskTitle || null,
    permissionMode: opts.permissionMode || undefined,
  };
}

const { buildToolPreviewLabel } = require("./tool-preview-label.cjs");

function compactToolInput(input, name = "Tool") {
  if (!input || typeof input !== "object") return {};
  return {
    ...input,
    preview: buildToolPreviewLabel({ name, input }),
  };
}

class TurnOrchestrator {
  static QUEUE_RETRY_DELAY_MS = 80;

  constructor(ctx) {
    this.ctx = ctx;
    this.eventBus = ctx.eventBus;
    this.transcriptStore = ctx.transcriptStore;
    this.turnArchive = ctx.turnArchive;
    this.states = new Map();
    this.boundRunners = new WeakSet();
    this.runCoordinator = ctx.turnRunCoordinator || new TurnRunCoordinator();
    this.dispatchRetryTimers = new Map();
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

  bindRunner(runner) {
    if (!runner || this.boundRunners.has(runner)) return;
    this.boundRunners.add(runner);
    runner.bindOrchestrator?.(this);
    const sessionId = runner.sessionId;

    runner.on("message-stop-grace", () => {
      const state = this._state(sessionId);
      if (!state.turnId || state.terminalEmitted) return;
      runner.completeFromHost?.("message_stop_grace");
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
          assistant: "Connection refreshed. Please resend your message.",
        });
      }
    });

    runner.on("done", (payload) => {
      void this._handleDone(sessionId, payload);
    });

    runner.on("error", (message) => {
      void this._handleError(sessionId, message);
    });
  }

  ingest(sessionId, drafts) {
    if (!sessionId || !Array.isArray(drafts) || drafts.length === 0) return;
    for (const draft of drafts) {
      if (!draft?.type) continue;
      this._applyDraft(sessionId, draft);
    }
  }

  notifyRunnerDone(sessionId, payload) {
    void this._handleDone(sessionId, payload);
  }

  notifyRunnerError(sessionId, message) {
    void this._handleError(sessionId, message);
  }

  _resolveToolId(state, payload) {
    if (payload?.id) return payload.id;
    if (payload?.index != null && state.blockIndexToToolId.has(payload.index)) {
      return state.blockIndexToToolId.get(payload.index);
    }
    return null;
  }

  _resolveToolDoneId(state, payload) {
    const explicit = this._resolveToolId(state, payload);
    if (explicit) return explicit;
    const running = [...state.tools.values()].filter((tool) => tool?.status === "running");
    return running.length === 1 ? running[0].id : null;
  }

  _applyDraft(sessionId, draft) {
    const type = draft.type;
    const payload = draft.payload || {};
    const state = this._state(sessionId);
    if (!state.turnId && !TURN_OPTIONAL_TYPES.has(type)) {
      log.debug("dropped orphan %s (no active turn)", type);
      return;
    }

    try {
    switch (type) {
      case "turn.accepted":
        state.phase = "streaming";
        this._emit(sessionId, "turn.accepted", { status: payload.status || "thinking" });
        break;
      case "assistant.delta":
        state.phase = "streaming";
        state.assistantText += String(payload.text || "");
        appendTimelineText(state, String(payload.text || ""), Date.now());
        this._emit(sessionId, "assistant.delta", { text: String(payload.text || "") });
        break;
      case "assistant.supersedes":
        state.supersedes = payload.supersedes || "";
        this._emit(sessionId, "assistant.supersedes", payload);
        break;
      case "assistant.thinking.delta": {
        const thinkingPiece = String(payload.text || "");
        state.phase = "streaming";
        state.thinkingText += thinkingPiece;
        upsertTimelineThinking(state, thinkingPiece, Date.now());
        this._emit(sessionId, "assistant.thinking.delta", { text: thinkingPiece });
        break;
      }
      case "content.block": {
        state.phase = "streaming";
        const block = {
          blockType: payload.blockType || "unknown",
          mediaType: payload.mediaType || "",
          data: payload.data || "",
          ts: Date.now(),
        };
        state.contentBlocks.push(block);
        if (state.contentBlocks.length > 20) {
          state.contentBlocks.splice(0, state.contentBlocks.length - 20);
        }
        this._emit(sessionId, "content.block", payload);
        break;
      }
      case "stream.metadata":
        this._emit(sessionId, "stream.metadata", payload);
        break;
      case "protocol.unknown": {
        const entry = {
          kind: payload.kind || "unknown_runtime_event",
          notice: payload.notice || null,
          event: payload.event || null,
          ts: Date.now(),
        };
        state.protocolUnknown.push(entry);
        if (state.protocolUnknown.length > 20) {
          state.protocolUnknown.splice(0, state.protocolUnknown.length - 20);
        }
        this._emit(sessionId, "protocol.unknown", payload);
        break;
      }
      case "tool.started": {
        state.phase = "tool_running";
        const toolId = payload.id || `tool_${state.tools.size + 1}`;
        if (payload.index != null) state.blockIndexToToolId.set(payload.index, toolId);
        const tool = this._trackTool(sessionId, toolId, {
          name: payload.name,
          input: payload.input || {},
          status: "running",
          parentToolUseId: payload.parentToolUseId || null,
        });
        if (payload.name && payload.input && Object.keys(payload.input).length) {
          require("./usage-reporter").recordToolCall(sessionId, {
            id: toolId,
            name: payload.name,
            input: payload.input,
          });
          const { captureBeforeSnapshot } = require("./diff-capture");
          captureBeforeSnapshot(sessionId, toolId, payload.name, payload.input);
        }
        upsertTimelineTool(state, {
          id: toolId,
          name: tool.name || payload.name || "unknown",
          input: tool.input || payload.input || {},
          status: "running",
          parentToolUseId: payload.parentToolUseId || null,
        }, Date.now());
        this._emit(sessionId, "tool.started", {
          id: toolId,
          name: tool.name || payload.name || "unknown",
          input: compactToolInput(tool.input || payload.input || {}, tool.name || payload.name || "unknown"),
          parentToolUseId: payload.parentToolUseId || null,
        });
        break;
      }
      case "tool.input.delta": {
        const toolId = this._resolveToolId(state, payload);
        if (!toolId) break;
        const tool = this._trackTool(sessionId, toolId, {});
        tool.partialJson = (tool.partialJson || "") + String(payload.partialJson || "");
        upsertTimelineTool(state, tool, Date.now());
        this._emit(sessionId, "tool.input.delta", {
          id: toolId,
          partialJson: String(payload.partialJson || ""),
        });
        break;
      }
      case "tool.input.done": {
        const toolId = this._resolveToolId(state, payload);
        if (!toolId) break;
        const tool = this._trackTool(sessionId, toolId, { input: payload.input || {} });
        tool.input = payload.input || tool.input || {};
        upsertTimelineTool(state, tool, Date.now());
        this._emit(sessionId, "tool.input.done", {
          id: toolId,
          input: compactToolInput(tool.input, tool.name || "unknown"),
        });
        break;
      }
      case "tool.done": {
        const toolId = this._resolveToolDoneId(state, payload);
        if (!toolId) break;
        const tool = this._trackTool(sessionId, toolId, {});
        tool.status = payload.status || (payload.isError ? "failed" : "done");
        tool.result = payload.result ?? payload.content ?? null;
        upsertTimelineTool(state, tool, Date.now());
        this._emit(sessionId, "tool.done", {
          id: toolId,
          status: tool.status,
          result: tool.result,
        });
        const { emitDiffForTool } = require("./diff-capture");
        emitDiffForTool(sessionId, toolId, this.ctx, state.turnId);
        break;
      }
      case "todo.updated": {
        state.phase = "streaming";
        const toolId = payload.id || `todo_${sessionId}`;
        const todos = Array.isArray(payload.todos) ? payload.todos : [];
        const tool = {
          id: toolId,
          name: "todowrite",
          input: { todos },
          status: "done",
          result: null,
          parentToolUseId: null,
        };
        upsertTimelineTool(state, tool, Date.now());
        this._emit(sessionId, "todo.updated", {
          id: toolId,
          todos,
        });
        break;
      }
      case "permission.requested":
        state.phase = "awaiting_user";
        state.pendingPermissions.set(payload.requestId, payload);
        this._emit(sessionId, "permission.requested", payload);
        break;
      case "user_question.requested":
        state.phase = "awaiting_user";
        state.pendingQuestions.set(payload.requestId, payload);
        this._emit(sessionId, "user_question.requested", payload);
        break;
      case "permission.resolved":
        state.pendingPermissions.delete(payload.requestId);
        state.pendingQuestions.delete(payload.requestId);
        if (state.phase === "awaiting_user") state.phase = "streaming";
        this._emit(sessionId, "permission.resolved", payload);
        break;
      case "user_question.resolved":
        state.pendingQuestions.delete(payload.requestId);
        this._emit(sessionId, "user_question.resolved", payload);
        break;
      case "hook.requested":
        state.phase = "awaiting_user";
        state.pendingHooks.set(payload.requestId, payload);
        this._emit(sessionId, "hook.requested", payload);
        break;
      case "hook.resolved":
        state.pendingHooks.delete(payload.requestId);
        if (state.phase === "awaiting_user") state.phase = "streaming";
        this._emit(sessionId, "hook.resolved", payload);
        break;
      case "permission.timeout":
        this._emit(sessionId, "permission.timeout", payload);
        break;
      case "engine.notice":
      case "engine.warning": {
        const notice = payload.notice || payload;
        const activity = activityFromEngineNotice(notice);
        if (activity) setActivityLabel(state, activity);
        if (notice) appendTimelineNotice(state, notice, Date.now());
        const noticeEvent = {
          type,
          turnId: state.turnId,
          source: draft.source || "runtime",
          payload,
          ts: Date.now(),
        };
        if (state.turnId) state.notices.push(noticeEvent);
        this._emit(sessionId, type, payload);
        break;
      }
      case "engine.stderr":
        if (state.turnId) {
          const text = String(payload.text || payload.message || "").trim();
          const notice = {
            code: "stderr",
            level: "warning",
            message: text,
            panel: true,
            done: false,
          };
          state.notices.push({
            type: "engine.stderr",
            turnId: state.turnId,
            source: draft.source || "runtime",
            payload: { notice },
            ts: Date.now(),
          });
        }
        this._emit(sessionId, "engine.stderr", payload);
        break;
      case "usage.updated":
        state.usage = payload.usage || payload;
        this._emit(sessionId, "usage.updated", payload);
        break;
      case "assistant.message_stop":
        closeStreamingBlocks(state, Date.now());
        this._emit(sessionId, "assistant.message_stop", payload);
        break;
      case "process.event": {
        const activity = activityFromProcessPayload(payload);
        if (activity) setActivityLabel(state, activity);
        state.processEvents.push(payload);
        if (state.processEvents.length > 200) {
          state.processEvents.splice(0, state.processEvents.length - 200);
        }
        this._emit(sessionId, "process.event", payload);
        break;
      }
      case "session.hydrated":
        if (payload.agentResumeId) {
          this.ctx.sessionManager.setAgentResumeId(sessionId, payload.agentResumeId);
        }
        this._emit(sessionId, "session.hydrated", payload, { turnId: null });
        break;
      case "resume.updated":
        this._emit(sessionId, "resume.updated", payload, { turnId: null });
        break;
      case "prompt_suggestions.updated":
        this._emit(sessionId, "prompt_suggestions.updated", payload, { turnId: null });
        break;
      case "runtime.control":
        break;
      default:
        if (TERMINAL_TYPES.has(type)) break;
        this._emit(sessionId, "engine.warning", {
          notice: {
            code: "unknownRuntimeDraft",
            level: "warning",
            detail: `Unhandled runtime draft ${type}`,
          },
        });
    }
    } catch (err) {
      log.warn("_applyDraft handler error: %s", err?.message || err);
    }
  }


  async sendUserMessage(sessionId, text, files = [], opts = {}) {
    const session = this.ctx.sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const displayText = String(text || "").trim();
    if (!displayText && (!files || files.length === 0)) return { ok: false, error: "EMPTY" };

    const state = this._state(sessionId);
    if (state.phase !== "idle" && !opts.fromQueue) {
      const item = {
        id: newQueueId(),
        text: displayText,
        files,
        displayFiles: opts.displayFiles || fileMetadataFromPayload(files),
        options: queueDispatchOptions(opts),
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
    if (state.admittedSeq) {
      try { this.runCoordinator.interrupt(sessionId, state.admittedSeq); } catch { /* best effort */ }
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
      options: queueDispatchOptions(opts),
    };
    state.queue = [item];
    this._emitQueue(sessionId);
    this.interrupt(sessionId, { clearQueue: false });
    void this._dispatchNext(sessionId);
    return { ok: true, queued: true, priority: true, queueLength: state.queue.length, itemId: item.id };
  }

  async _tryStartQueuedItem(sessionId, item) {
    const runner = this.ctx.runnerPool.get(sessionId);
    if (runner?.isBusy?.()) return { ok: false, retry: true, error: "RUNNER_BUSY" };
    if (item.options?.reloadSkillsBeforeStart && runner?.isAlive?.() && !runner.reloadSkills()) {
      this.ctx.runnerPool.terminateSession(sessionId);
    }
    const session = this.ctx.sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };
    return await this._startTurn(session, item.text, item.files, {
      fromQueue: true,
      displayFiles: item.displayFiles,
      recordUser: true,
      spawnEngine: item.options?.spawnEngine !== false,
      skipPreflight: Boolean(item.options?.skipPreflight),
      skipVision: Boolean(item.options?.skipVision),
      skipDocument: Boolean(item.options?.skipDocument),
      scheduledTaskId: item.options?.scheduledTaskId || null,
      scheduledTaskRunId: item.options?.scheduledTaskRunId || null,
      scheduledTaskTitle: item.options?.scheduledTaskTitle || null,
      engineText: item.options?.engineText || null,
    });
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
    const rawUserText = String(text || "").trim();
    const { diagnoseSendBlocker, ensureSessionRunner, refreshRemoteConfigForSend } = require("./ipc-utils");
    if (!opts.skipPreflight) {
      await refreshRemoteConfigForSend();
      const blocked = diagnoseSendBlocker(this.ctx, session.id);
      if (blocked) return { ok: false, error: blocked.error, detail: blocked.detail };
    }

    const ensured = opts.skipPreflight
      ? { runner: this.ctx.runnerPool.get(session.id) }
      : ensureSessionRunner(this.ctx, session.id, {
          spawn: opts.spawnEngine !== false,
          permissionMode: opts.permissionMode,
        });
    const runner = ensured.runner;
    if (!runner) {
      return {
        ok: false,
        error: ensured.error || "RUNNER_ERROR",
        detail: ensured.detail || "Unable to start the assistant process. Please check the terminal logs or restart the application.",
      };
    }

    const state = this._state(session.id);
    state.phase = "starting";
    state.turnId = newTurnId();
    state.admittedSeq = null;
    state.assistantText = "";
    state.thinkingText = "";
    state.contentBlocks = [];
    state.protocolUnknown = [];
    state.processEvents = [];
    state.notices = [];
    state.usage = null;
    state.taskContract = null;
    state.enginePayload = null;
    state.legacyContextHydrated = false;
    resetTimelineState(state);
    state.blockIndexToToolId = new Map();
    state.terminalEmitted = false;
    state.pendingPermissions.clear();
    state.pendingQuestions.clear();
    state.pendingHooks.clear();
    state.tools.clear();
    const displayFiles = opts.displayFiles || fileMetadataFromPayload(files);
    state.currentPayload = {
      rawText: rawUserText,
      text: rawUserText,
      files,
      displayFiles,
    };
    try {
      const admitted = this.ctx.sessionManager?.admitTurnInput?.(session.id, {
        turnId: state.turnId,
        delivery: opts.fromQueue ? "queue" : "steer",
        status: "admitted",
        userText: rawUserText,
        files: displayFiles,
        metadata: {
          fromQueue: Boolean(opts.fromQueue),
          scheduledTaskId: opts.scheduledTaskId || null,
          scheduledTaskRunId: opts.scheduledTaskRunId || null,
        },
        createdAt: state.startedAt,
      });
      state.admittedSeq = admitted?.admittedSeq || null;
    } catch (err) {
      log.warn("turn input admission failed: %s", err?.message || err);
    }
    state.scheduledTask = opts.scheduledTaskRunId
      ? {
          id: opts.scheduledTaskId || null,
          runId: opts.scheduledTaskRunId,
          title: opts.scheduledTaskTitle || "",
        }
      : null;
    state.startedAt = Date.now();
    state.updatedAt = Date.now();
    if (state.scheduledTask?.runId) {
      this.ctx.scheduledTaskManager?.markRunStarted?.(state.scheduledTask.runId, state.turnId);
    }

    if (opts.recordUser !== false) {
      this.transcriptStore.commitUserMessage(session.id, {
        text: rawUserText,
        files: displayFiles,
        turnId: state.turnId,
      });
      this._emit(session.id, "user.committed", {
        text: rawUserText,
        files: displayFiles.length ? displayFiles : null,
      }, { turnId: state.turnId });
    }

    if (!opts.skipVision) {
      const vision = await runVisionPreflight(text, files, {
        emitNotice: (notice) => this._emitEngineNotice(session.id, notice),
        nativeVision: require("./model-presets").activePresetSupportsVision(),
      });
      if (!vision.ok) {
        const assistant = preflightFailureText(vision.error, vision.detail);
        const failedTurnId = state.turnId;
        this._finalize(session.id, "turn.failed", {
          failed: true,
          assistant,
          error: vision.error,
          detail: vision.detail,
        });
        return { ok: true, failed: true, turnId: failedTurnId, error: vision.error, detail: vision.detail };
      }
      text = vision.text;
      files = vision.files;
      state.currentPayload = { rawText: rawUserText, text, files, displayFiles };
    }

    if (!opts.skipDocument) {
      const document = await runDocumentPreflight(text, files, {
        emitNotice: (notice) => this._emitEngineNotice(session.id, notice),
      });
      if (!document.ok) {
        const assistant = preflightFailureText(document.error, document.detail);
        const failedTurnId = state.turnId;
        this._finalize(session.id, "turn.failed", {
          failed: true,
          assistant,
          error: document.error,
          detail: document.detail,
        });
        return { ok: true, failed: true, turnId: failedTurnId, error: document.error, detail: document.detail };
      }
      text = document.text;
      files = document.files;
      state.currentPayload = { rawText: rawUserText, text, files, displayFiles };
    }

    const project =
      ensured.project ||
      (session?.projectId && typeof this.ctx.projectManager?.find === "function"
        ? this.ctx.projectManager.find(session.projectId)
        : null);
    const taskContract = buildTaskContract({ text, files, session, project });
    state.taskContract = taskContract.active ? taskContract : null;

    let engineText =
      typeof opts.engineText === "string" && opts.engineText.trim()
        ? opts.engineText.trim()
        : text;
    const preRehydrateText = engineText;
    let rehydrated = false;
    let shortFollowupContext = false;
    {
      const { withSessionRehydratePrefix } = require("./session-bootstrap");
      const { readSessionSummary } = require("./session-memory");
      const { withShortFollowupContext } = require("./session-followup-context");
      const committedMessages =
        typeof this.ctx.sessionManager.getConversation === "function"
          ? this.ctx.sessionManager.getConversation(session.id)
          : session.messages || [];
      const summary = readSessionSummary(session.id);
      const historySession = {
        ...session,
        messages: committedMessages.filter((message) => message.turnId !== state.turnId),
      };
      const rehydrate = withSessionRehydratePrefix({
        coldStart: Boolean(ensured.coldStart),
        usedResume: Boolean(ensured.usedResume),
        session: historySession,
        project,
        userText: engineText,
        summary,
      });
      engineText = rehydrate.text;
      state.legacyContextHydrated = Boolean(rehydrate.legacyContextHydrated);
      if (rehydrate.rehydrated) {
        rehydrated = true;
        this._emit(session.id, "session.hydrated", { source: "local-bootstrap" }, { turnId: null });
      }
      const followup = withShortFollowupContext({
        userText: rawUserText,
        engineText,
        messages: historySession.messages,
        summary,
      });
      engineText = followup.text;
      shortFollowupContext = Boolean(followup.applied);
    }
    engineText = withTaskContractPrefix(engineText, taskContract);
    state.enginePayload = {
      rawText: rawUserText,
      text: engineText,
      files,
      displayFiles,
      taskContract: state.taskContract,
      trace: {
        preflightTextChanged: text !== rawUserText,
        customEngineText: preRehydrateText !== text,
        rehydrated,
        shortFollowupContext,
        taskContract: Boolean(state.taskContract),
      },
    };

    this._emit(session.id, "turn.started", {
      text: rawUserText,
      queueLength: state.queue.length,
      engine: {
        textChanged: engineText !== rawUserText,
        preflightTextChanged: text !== rawUserText,
        customEngineText: preRehydrateText !== text,
        rehydrated,
        shortFollowupContext,
        taskContract: Boolean(state.taskContract),
      },
      taskContract: state.taskContract
        ? {
            kind: state.taskContract.kind,
            taskType: state.taskContract.taskType,
            categories: state.taskContract.categories,
            workspaceProfile: state.taskContract.workspaceProfile,
            workspaceSignals: state.taskContract.workspaceSignals || [],
          }
        : null,
    });

    const sent = runner.sendUserMessage(state.enginePayload);
    if (!sent) {
      try {
        this.ctx.sessionManager?.markTurnInputTerminal?.(state.turnId, "turn.failed", {
          errorCode: "RUNNER_REJECTED",
        });
      } catch {
        // best effort
      }
      this._finalize(session.id, "turn.failed", {
        failed: true,
        assistant: "The assistant engine did not accept the message. Please retry.",
        code: "RUNNER_REJECTED",
      });
      return { ok: false, error: "RUNNER_ERROR", detail: runner.lastSpawnError || "The assistant engine did not accept the message. Please retry." };
    }
    try {
      this.ctx.sessionManager?.markTurnInputPromoted?.(state.turnId, {
        status: "promoted",
        metadata: {
          engineTextChanged: engineText !== rawUserText,
          taskContract: Boolean(state.taskContract),
        },
      });
    } catch (err) {
      log.warn("turn input promotion failed: %s", err?.message || err);
    }
    require("./usage-reporter").recordUserSend(session.id, files);
    return {
      ok: true,
      turnId: state.turnId,
      userCommitted: opts.recordUser === false ? null : { text: rawUserText, files: displayFiles },
    };
  }

  async _handleDone(sessionId, payload) {
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) {
      void this._dispatchNext(sessionId);
      return;
    }

    const normalized = normalizeAssistantOutput(payload?.output || state.assistantText);
    const interrupted = Boolean(payload?.interruptedByUser || payload?.userInterrupted);
    const stalled = Boolean(payload?.stalled);
    const failure = interrupted || stalled
      ? null
      : classifyTurnFailure(payload, normalized, state);
    const failed = Boolean(failure);
    if (Number.isFinite(payload?.durationMs)) state.durationMs = payload.durationMs;
    if (Number.isFinite(payload?.totalCostUsd)) state.totalCostUsd = payload.totalCostUsd;

    const terminalMeta = {
      durationMs: state.durationMs ?? null,
      totalCostUsd: state.totalCostUsd ?? null,
      // Rewind anchor: the engine message id of this turn (session:rewind reverts
      // the engine session to it). Null on turns that never reached the engine.
      engineMessageId: payload?.engineMessageId || null,
    };
    if (interrupted) {
      this._finalize(sessionId, "turn.interrupted", {
        interrupted: true,
        assistant: normalized.text || state.assistantText,
        ...terminalMeta,
      });
    } else if (stalled) {
      this._finalize(sessionId, "turn.stalled", {
        stalled: true,
        assistant: appendIncompleteTurnSummary(normalized.text || state.assistantText, state, payload),
        ...terminalMeta,
      });
    } else if (failed) {
      const friendly = failure.message || normalized.text || sanitizeError(collectFailureTextFromState(state)) || "The assistant engine encountered an error. Please retry.";
      this._finalize(sessionId, "turn.failed", {
        failed: true,
        assistant: friendly,
        errorCode: failure.code,
        errorCategory: failure.category || "",
        retryable: failure.retryable !== false,
        source: payload?.source || "",
        exitCode: payload?.exitCode ?? null,
        ...terminalMeta,
      });
    } else {
      this._finalize(sessionId, "turn.completed", {
        assistant: normalized.text || state.assistantText,
        resultFromCli: Boolean(payload?.resultFromCli),
        ...terminalMeta,
      });
    }
    if (state.legacyContextHydrated && payload?.engineMessageId) {
      const runner = this.ctx.runnerPool?.get?.(sessionId);
      this.ctx.sessionManager?.markLegacyContextHydrated?.(
        sessionId,
        runner?.agentResumeId || null,
      );
    }
    await this._flushUsage(sessionId);
    void this._dispatchNext(sessionId);
  }

  async _handleError(sessionId, message) {
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) return;

    const raw = String(message || "");
    const classified = classifyAssistantError(raw);
    const text = classified?.message || sanitizeError(raw);
    this._finalize(sessionId, "turn.failed", {
      failed: true,
      assistant: text,
      errorCode: classified?.code || "ENGINE_ERROR",
      errorCategory: classified?.category || "",
      retryable: classified?.retryable !== false,
      error: raw,
    });
    await this._flushUsage(sessionId);
    void this._dispatchNext(sessionId);
  }

  _finalize(sessionId, type, payload = {}) {
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) return;
    if (!TERMINAL_TYPES.has(type)) throw new Error(`Invalid terminal event ${type}`);
    const completedTurnId = state.turnId;
    try {
      this.ctx.sessionManager?.markTurnInputTerminal?.(completedTurnId, type, {
        errorCode: payload.errorCode || payload.code || "",
      });
    } catch (err) {
      log.warn("turn input terminal mark failed: %s", err?.message || err);
    }
    const scheduledTaskRunId = state.scheduledTask?.runId || null;
    state.phase = "finalizing";
    for (const tool of state.tools.values()) {
      if (tool?.status !== "running") continue;
      tool.status = type === "turn.completed" ? "done" : "failed";
      upsertTimelineTool(state, tool, Date.now());
    }
    if (type === "turn.completed") {
      try {
        const { collectLearnedSkillDrafts } = require("./learned-skills");
        const skillManager = require("./skill-manager");
        const session = this.ctx.sessionManager?.findById?.(sessionId) || null;
        const project = session?.projectId && this.ctx.projectManager?.find
          ? this.ctx.projectManager.find(session.projectId)
          : null;
        const learned = collectLearnedSkillDrafts(
          skillManager.registerLearnedSkillDir,
          undefined,
          {
            sessionId,
            projectId: session?.projectId || "",
            workspacePath: project?.path || "",
          },
        );
        if (learned.length) {
          if (session) {
            try {
              skillManager.writeSessionAgentGuide(sessionId, session, project?.path || "");
            } catch (err) {
              log.warn("learned skill guide refresh failed: %s", err?.message || err);
            }
          }
          appendTimelineNotice(state, {
            code: "learnedSkillDraft",
            level: "info",
            panel: true,
            done: true,
          }, Date.now());
        }
      } catch (err) {
        log.warn("learned skill draft collection failed: %s", err?.message || err);
      }
    }
    closeStreamingBlocks(state, Date.now());
    let assistant = String(payload.assistant || state.assistantText || "").trim();
    let record = this.turnArchive?.buildRecord(state, type, { ...payload, assistant });
    if (type === "turn.completed" && state.taskContract?.evidencePolicy?.required) {
      const { assessFinalAnswerEvidence, appendEvidenceGateNotice } = require("./evidence-gate");
      const assessment = assessFinalAnswerEvidence({
        assistant,
        evidencePolicy: state.taskContract.evidencePolicy,
        toolCount: state.tools?.size || 0,
        fileChangeCount: record?.fileChanges?.length || 0,
      });
      if (!assessment.ok) {
        assistant = appendEvidenceGateNotice(assistant, assessment);
        if (record) {
          record.assistantText = assistant;
          record.meta = {
            ...(record.meta || {}),
            evidenceGate: assessment,
          };
        }
      }
    }
    // Don't archive a turn that produced literally nothing — e.g. an interrupt
    // before any output. Otherwise an empty assistant bubble lands in history.
    // Any real content (text, a tool call, a file change, a result block) makes
    // it worth keeping; failed turns carry a friendly error string as `assistant`.
    const meaningful = Boolean(
      assistant ||
      state.tools?.size ||
      record?.fileChanges?.length ||
      record?.resultBlocks?.length,
    );
    if (!meaningful) record = null;
    if (record) {
      if (assistant) {
        this._emit(sessionId, "assistant.final", {
          assistant,
          failed: type === "turn.failed",
        });
      }
      try { this.turnArchive.commit(sessionId, record); } catch (err) { log.warn("turn archive commit failed: %s", err?.message || err); }
    }
    state.terminalEmitted = true;
    this._emit(sessionId, type, {
      ...payload,
      assistant,
      record,
      toolsSummary: { count: state.tools.size },
    });
    if (scheduledTaskRunId) {
      try { this.ctx.scheduledTaskManager?.completeRun?.(sessionId, completedTurnId, type, payload); } catch (err) { log.warn("scheduled task completeRun failed: %s", err?.message || err); }
    }
    state.phase = "idle";
    state.turnId = null;
    state.admittedSeq = null;
    state.assistantText = "";
    state.thinkingText = "";
    state.contentBlocks = [];
    state.protocolUnknown = [];
    state.processEvents = [];
    state.notices = [];
    state.usage = null;
    state.taskContract = null;
    state.enginePayload = null;
    resetTimelineState(state);
    state.blockIndexToToolId = new Map();
    state.currentPayload = null;
    state.scheduledTask = null;
    state.pendingPermissions.clear();
    state.pendingQuestions.clear();
    state.pendingHooks.clear();
  }

  async _dispatchNext(sessionId) {
    const state = this._state(sessionId);
    if (state.phase !== "idle" || state.queue.length === 0) return;
    this._clearDispatchRetry(sessionId);
    const next = state.queue[0];
    let result;
    try {
    result = await this._tryStartQueuedItem(sessionId, next);
    if (result?.retry) {
      this._scheduleDispatchRetry(sessionId);
      return;
    }
    if (!result?.ok) {
      state.queue.shift();
      this._emitQueue(sessionId);
      if (state.phase === "idle" && state.queue.length > 0) {
        void this._dispatchNext(sessionId);
      }
      return;
    }
    state.queue.shift();
    this._emitQueue(sessionId);
    if (result.failed && state.phase === "idle" && state.queue.length > 0) {
      void this._dispatchNext(sessionId);
    }
    } catch (err) {
      log.warn("_dispatchNext error: %s", err?.message || err);
      state.queue.shift();
      this._emitQueue(sessionId);
    }
  }

  _scheduleDispatchRetry(sessionId) {
    if (!sessionId || this.dispatchRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.dispatchRetryTimers.delete(sessionId);
      void this._dispatchNext(sessionId);
    }, TurnOrchestrator.QUEUE_RETRY_DELAY_MS);
    timer.unref?.();
    this.dispatchRetryTimers.set(sessionId, timer);
  }

  _clearDispatchRetry(sessionId) {
    const timer = this.dispatchRetryTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.dispatchRetryTimers.delete(sessionId);
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

  _emitEngineNotice(sessionId, notice) {
    if (!notice) return;
    notice = sanitizeNoticeForIngest(notice);
    const state = this._state(sessionId);
    const activity = activityFromEngineNotice(notice);
    if (activity) setActivityLabel(state, activity);
    appendTimelineNotice(state, notice, Date.now());
    const type = notice.level === "warning" ? "engine.warning" : "engine.notice";
    const payload = { notice };
    if (state.turnId) {
      state.notices.push({
        type,
        turnId: state.turnId,
        source: "orchestrator",
        payload,
        ts: Date.now(),
      });
    }
    this._emit(sessionId, type, payload);
  }

  _emit(sessionId, type, payload = {}, opts = {}) {
    const state = this._state(sessionId);
    if (state.terminalEmitted && state.turnId && !TERMINAL_TYPES.has(type)) return null;
    const turnId = opts.turnId === undefined ? state.turnId : opts.turnId;
    if (!turnId && !TURN_OPTIONAL_TYPES.has(type)) {
      log.debug("dropped orphan %s emit (no active turn)", type);
      return null;
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
        admittedSeq: null,
        assistantText: "",
        thinkingText: "",
        contentBlocks: [],
        protocolUnknown: [],
        processEvents: [],
        notices: [],
        usage: null,
        taskContract: null,
        enginePayload: null,
        legacyContextHydrated: false,
        timeline: [],
        activityLabel: null,
        durationMs: null,
        totalCostUsd: null,
        blockIndexToToolId: new Map(),
        queue: [],
        tools: new Map(),
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        pendingHooks: new Map(),
        terminalEmitted: false,
        currentPayload: null,
        scheduledTask: null,
        startedAt: 0,
        updatedAt: 0,
      });
    }
    return this.states.get(sessionId);
  }
}

module.exports = { TurnOrchestrator };
