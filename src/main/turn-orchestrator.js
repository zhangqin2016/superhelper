"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {
  normalizeAssistantOutput,
  sanitizeError,
  classifyAssistantError,
  scrubVendorNames,
} = require("./agent-runner");
const { fileMetadataFromPayload } = require("./ipc-utils");
const { getLogger } = require("./logger");
const { sanitizeNoticeForIngest } = require("./engine-notice-policy");
const {
  activityFromEngineNotice,
  activityFromProcessPayload,
  appendTimelineNotice,
  resetTimelineState,
  setActivityLabel,
  upsertTimelineThinking,
  upsertTimelineTool,
} = require("./turn-timeline");

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
    spawnEngine: opts.spawnEngine,
    skipPreflight: Boolean(opts.skipPreflight),
    skipVision: Boolean(opts.skipVision),
    skipDocument: Boolean(opts.skipDocument),
    scheduledTaskId: opts.scheduledTaskId || null,
    scheduledTaskRunId: opts.scheduledTaskRunId || null,
    scheduledTaskTitle: opts.scheduledTaskTitle || null,
  };
}

function preflightFailureText(error, detail) {
  const suffix = detail ? `\n\n${String(detail).trim()}` : "";
  switch (error) {
    case "VISION_UNAVAILABLE":
      return `Image recognition service is temporarily unavailable. The image could not be processed. Please try again later, or add a text description and resend.${suffix}`;
    case "VISION_FAILED":
      return `Image parsing failed and was not forwarded to the assistant. Please try again later, or add a text description and resend.${suffix}`;
    case "DOCUMENT_FAILED":
      return `Document parsing failed and was not forwarded to the assistant. Please check if the file can be opened, or add a text description and resend.${suffix}`;
    default:
      return `Pre-send processing failed and was not forwarded to the assistant. Please try again later.${suffix}`;
  }
}

const { buildToolPreviewLabel } = require("./tool-preview-label.cjs");

function compactToolInput(input, name = "Tool") {
  if (!input || typeof input !== "object") return {};
  return {
    ...input,
    preview: buildToolPreviewLabel({ name, input }),
  };
}

function isRecoverableFailure(raw) {
  return /API Error:|socket connection was closed|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network error|502|503|504|rate.?limit|429/i.test(String(raw || ""));
}

function compactFailureDetail(raw) {
  const text = scrubVendorNames(raw).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 260 ? `${text.slice(0, 260)}…` : text;
}

function withoutVisionFiles(files = []) {
  const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
  return (files || []).filter((file) => {
    if (!file) return false;
    if (file.isImage) return false;
    const ext = path.extname(String(file.path || file.name || "")).toLowerCase();
    return !imageExtensions.has(ext);
  });
}

function failureTextFromProcessEvent(event = {}) {
  const rawSubtype = String(event.rawSubtype || event.event?.subtype || "");
  const rawType = String(event.rawType || event.event?.type || "");
  const values = [];
  const raw = event.event || {};
  if (typeof raw.error === "string") values.push(raw.error);
  if (Array.isArray(raw.errors)) values.push(raw.errors.join("\n"));
  if (typeof raw.message === "string" && (rawType === "error" || rawSubtype.startsWith("error"))) {
    values.push(raw.message);
  }
  if (rawSubtype.startsWith("error")) values.push(rawSubtype);
  for (const action of event.actions || []) {
    if (typeof action?.notice?.detail === "string") values.push(action.notice.detail);
    if (typeof action?.notice?.message === "string") values.push(action.notice.message);
  }
  return values.filter(Boolean).join("\n");
}

function failureTextFromNoticeEvent(event = {}) {
  const notice = event.payload?.notice || event.notice || event.payload || event;
  if (!notice || typeof notice !== "object") return "";
  const level = String(notice.level || "");
  const code = String(notice.code || "");
  if (level !== "warning" && !/error|fail|denied|timeout/i.test(code)) return "";
  return [notice.detail, notice.message, code].filter((value) => typeof value === "string" && value.trim()).join("\n");
}

function collectFailureTextFromState(state = {}) {
  const parts = [];
  for (const event of [...(state.processEvents || [])].reverse()) {
    const text = failureTextFromProcessEvent(event);
    if (text) {
      parts.push(text);
      break;
    }
  }
  for (const event of [...(state.notices || [])].reverse()) {
    const text = failureTextFromNoticeEvent(event);
    if (text) {
      parts.push(text);
      break;
    }
  }
  return parts.join("\n");
}

function classifyTurnFailure(payload, normalized, state) {
  const rawError = [
    payload?.error,
    payload?.errorText,
    payload?.message,
    payload?.resultSubtype,
    collectFailureTextFromState(state),
  ].filter((value) => typeof value === "string" && value.trim()).join("\n");
  const errorClassified = classifyAssistantError(rawError);
  if (errorClassified) return errorClassified;
  if (normalized?.failed) {
    return {
      code: normalized.errorCode || "ASSISTANT_ERROR",
      message: normalized.text || sanitizeError(collectFailureTextFromState(state)) || "The assistant engine encountered an error. Please retry.",
      retryable: normalized.retryable !== false,
    };
  }
  if (payload?.engineInterrupted) {
    return {
      code: "ENGINE_INTERRUPTED",
      message: "The assistant engine interrupted this response. Please retry.",
      retryable: true,
    };
  }
  if (payload?.code && payload.code !== 0) {
    return {
      code: payload?.source === "process.close" ? "ENGINE_PROCESS_EXITED" : "ENGINE_RESULT_FAILED",
      message: rawError
        ? `Assistant engine returned failure: ${compactFailureDetail(rawError)}`
        : "Assistant process exited unexpectedly. Please retry. If this persists, restart the application.",
      retryable: true,
    };
  }
  return null;
}

class TurnOrchestrator {
  constructor(ctx) {
    this.ctx = ctx;
    this.eventBus = ctx.eventBus;
    this.transcriptStore = ctx.transcriptStore;
    this.turnArchive = ctx.turnArchive;
    this.states = new Map();
    this.boundRunners = new WeakSet();
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

    switch (type) {
      case "turn.accepted":
        state.phase = "streaming";
        this._emit(sessionId, "turn.accepted", { status: payload.status || "thinking" });
        break;
      case "assistant.delta":
        state.phase = "streaming";
        state.assistantText += String(payload.text || "");
        this._emit(sessionId, "assistant.delta", { text: String(payload.text || "") });
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
          source: draft.source || "claude-cli",
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
            source: draft.source || "claude-cli",
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
        this._emit(sessionId, "assistant.message_stop", payload);
        break;
      case "process.event": {
        const activity = activityFromProcessPayload(payload);
        if (activity) setActivityLabel(state, activity);
        if (payload.rawSubtype !== "thinking_tokens") {
          const thinkingAction = (payload.actions || []).find((a) => a.kind === "assistant_thinking");
          if (thinkingAction?.text) upsertTimelineThinking(state, thinkingAction.text, Date.now());
        }
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
    const { diagnoseSendBlocker, ensureSessionRunner, refreshRemoteConfigForSend } = require("./ipc-utils");
    if (!opts.skipPreflight) {
      await refreshRemoteConfigForSend();
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
        detail: ensured.detail || "Unable to start the assistant process. Please check the terminal logs or restart the application.",
      };
    }

    const state = this._state(session.id);
    state.phase = "starting";
    state.turnId = newTurnId();
    state.assistantText = "";
    state.thinkingText = "";
    state.contentBlocks = [];
    state.protocolUnknown = [];
    state.processEvents = [];
    state.notices = [];
    state.usage = null;
    resetTimelineState(state);
    state.blockIndexToToolId = new Map();
    state.terminalEmitted = false;
    state.pendingPermissions.clear();
    state.pendingQuestions.clear();
    state.pendingHooks.clear();
    state.tools.clear();
    const displayFiles = opts.displayFiles || fileMetadataFromPayload(files);
    state.currentPayload = { text, files, displayFiles };
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
        text,
        files: displayFiles,
        turnId: state.turnId,
      });
      this._emit(session.id, "user.committed", {
        text,
        files: displayFiles.length ? displayFiles : null,
      }, { turnId: state.turnId });
    }

    if (!opts.skipVision) {
      const vision = await this._runVisionPreflight(session.id, text, files);
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
      state.currentPayload = { text, files, displayFiles };
    }

    if (!opts.skipDocument) {
      const document = await this._runDocumentPreflight(session.id, text, files);
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
      state.currentPayload = { text, files, displayFiles };
    }

    let engineText = text;
    if (!opts.fromAutoRecovery) {
      const { withSessionRehydratePrefix } = require("./session-bootstrap");
      const { readSessionSummary } = require("./session-memory");
      const committedMessages =
        typeof this.ctx.sessionManager.getConversation === "function"
          ? this.ctx.sessionManager.getConversation(session.id)
          : session.messages || [];
      const historySession = {
        ...session,
        messages: committedMessages.filter((message) => message.turnId !== state.turnId),
      };
      const rehydrate = withSessionRehydratePrefix({
        coldStart: Boolean(ensured.coldStart),
        usedResume: Boolean(ensured.usedResume),
        session: historySession,
        project: ensured.project,
        userText: text,
        summary: readSessionSummary(session.id),
      });
      engineText = rehydrate.text;
      if (rehydrate.rehydrated) {
        this._emit(session.id, "session.hydrated", { source: "local-bootstrap" }, { turnId: null });
      }
    }

    this._emit(session.id, "turn.started", {
      text: state.currentPayload?.text || text,
      queueLength: state.queue.length,
    });

    const sent = runner.sendUserMessage({ text: engineText, files });
    if (!sent) {
      this._finalize(session.id, "turn.failed", {
        failed: true,
        assistant: "The assistant engine did not accept the message. Please retry.",
        code: "RUNNER_REJECTED",
      });
      return { ok: false, error: "RUNNER_ERROR", detail: runner.lastSpawnError || "The assistant engine did not accept the message. Please retry." };
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
    const interrupted = Boolean(payload?.interruptedByUser || payload?.userInterrupted);
    const stalled = Boolean(payload?.stalled);
    const failure = interrupted || stalled
      ? null
      : classifyTurnFailure(payload, normalized, state);
    const failed = Boolean(failure);
    if (Number.isFinite(payload?.durationMs)) state.durationMs = payload.durationMs;
    if (Number.isFinite(payload?.totalCostUsd)) state.totalCostUsd = payload.totalCostUsd;

    if (failed && !state.recoveryAttempted && isRecoverableFailure(payload?.output || "")) {
      state.recoveryAttempted = true;
      state.phase = "recovering";
      this._emit(sessionId, "recovery.scheduled", { attempt: 1, maxAttempts: 1 });
      setTimeout(() => {
        void this._recover(sessionId);
      }, 600);
      return;
    }

    const terminalMeta = {
      durationMs: state.durationMs ?? null,
      totalCostUsd: state.totalCostUsd ?? null,
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
        assistant: normalized.text || state.assistantText,
        ...terminalMeta,
      });
    } else if (failed) {
      const friendly = failure.message || normalized.text || sanitizeError(collectFailureTextFromState(state)) || "The assistant engine encountered an error. Please retry.";
      this._finalize(sessionId, "turn.failed", {
        failed: true,
        assistant: friendly,
        errorCode: failure.code,
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
    await this._flushUsage(sessionId);
    void this._dispatchNext(sessionId);
  }

  async _handleError(sessionId, message) {
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) return;

    // Attempt recovery for transient errors (network, API) — same as _handleDone.
    const raw = String(message || "");
    if (!state.recoveryAttempted && isRecoverableFailure(raw)) {
      state.recoveryAttempted = true;
      state.phase = "recovering";
      this._emit(sessionId, "recovery.scheduled", { attempt: 1, maxAttempts: 1, source: "engine_error" });
      setTimeout(() => {
        void this._recover(sessionId);
      }, 600);
      return;
    }

    const classified = classifyAssistantError(raw);
    const text = classified?.message || sanitizeError(raw);
    this._finalize(sessionId, "turn.failed", {
      failed: true,
      assistant: text,
      errorCode: classified?.code || "ENGINE_ERROR",
      retryable: classified?.retryable !== false,
      error: raw,
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

    // Re-ensure the runner — if the engine process died, this spawns a fresh one.
    const { ensureSessionRunner } = require("./ipc-utils");
    const ensured = ensureSessionRunner(this.ctx, sessionId, { spawn: true });
    const runner = ensured.runner;
    if (!runner) {
      this._finalize(sessionId, "turn.failed", {
        failed: true,
        assistant: "Connection recovery failed — engine could not be restarted. Please resend your message.",
        errorCode: "RECOVERY_NO_RUNNER",
        retryable: true,
      });
      return;
    }

    // If the engine was restarted, the resume ID is stale — clear it so we start fresh.
    if (ensured.coldStart) {
      this.ctx.sessionManager.clearAgentResumeId(sessionId);
    }

    const sent = runner.sendUserMessage(payload);
    if (!sent) {
      this._finalize(sessionId, "turn.failed", {
        failed: true,
        assistant: "Connection recovery failed. Please resend your message.",
        errorCode: "RECOVERY_REJECTED",
        retryable: true,
      });
    }
  }

  _finalize(sessionId, type, payload = {}) {
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) return;
    if (!TERMINAL_TYPES.has(type)) throw new Error(`Invalid terminal event ${type}`);
    const completedTurnId = state.turnId;
    const scheduledTaskRunId = state.scheduledTask?.runId || null;
    state.phase = "finalizing";
    for (const tool of state.tools.values()) {
      if (tool?.status !== "running") continue;
      tool.status = type === "turn.completed" ? "done" : "failed";
      upsertTimelineTool(state, tool, Date.now());
    }
    const assistant = String(payload.assistant || state.assistantText || "").trim();
    const record = this.turnArchive?.buildRecord(state, type, { ...payload, assistant });
    if (record) {
      if (assistant) {
        this._emit(sessionId, "assistant.final", {
          assistant,
          failed: type === "turn.failed",
        });
      }
      this.turnArchive.commit(sessionId, record);
    }
    state.terminalEmitted = true;
    this._emit(sessionId, type, {
      ...payload,
      assistant,
      record,
      toolsSummary: { count: state.tools.size },
    });
    if (scheduledTaskRunId) {
      this.ctx.scheduledTaskManager?.completeRun?.(sessionId, completedTurnId, type, payload);
    }
    state.phase = "idle";
    state.turnId = null;
    state.assistantText = "";
    state.thinkingText = "";
    state.contentBlocks = [];
    state.protocolUnknown = [];
    state.processEvents = [];
    state.notices = [];
    state.usage = null;
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
    const next = state.queue[0];
    const result = await this._tryStartQueuedItem(sessionId, next);
    if (result?.retry) return;
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

  async _runVisionPreflight(sessionId, text, files) {
    const {
      buildEnrichedUserText,
      hasVisionInputFiles,
      isImageOnlyUserMessage,
      translateImages,
    } = require("./vision-translator");
    if (!hasVisionInputFiles(files)) {
      return { ok: true, text, files: withoutVisionFiles(files) };
    }

    this._emitEngineNotice(sessionId, {
      code: "visionPreparing",
      level: "progress",
      panel: true,
      replace: true,
    });

    const result = await translateImages(files, { userText: text });
    if (result === null) {
      return { ok: true, text, files: withoutVisionFiles(files) };
    }

    if (!result.ok) {
      this._emitEngineNotice(sessionId, {
        code: "visionSkipped",
        level: "warning",
        panel: true,
        replace: true,
        replacesCode: "visionPreparing",
        done: true,
      });
      if (isImageOnlyUserMessage(text, files)) {
        if (result.reason === "NO_KEY") {
          return { ok: false, error: "VISION_UNAVAILABLE" };
        }
        return {
          ok: false,
          error: "VISION_FAILED",
          detail: result.detail || undefined,
        };
      }
      return { ok: true, text, files: withoutVisionFiles(files) };
    }

    this._emitEngineNotice(sessionId, {
      code: "visionReady",
      level: "info",
      panel: true,
      replace: true,
      replacesCode: "visionPreparing",
      done: true,
    });

    const enrichedText = buildEnrichedUserText(text, result.text);
    const outboundFiles = result.keepOriginal ? files : withoutVisionFiles(files);
    return { ok: true, text: enrichedText, files: outboundFiles };
  }

  async _runDocumentPreflight(sessionId, text, files) {
    const {
      buildEnrichedUserText,
      extractDocuments,
      hasDocumentInputFiles,
      isDocumentOnlyUserMessage,
    } = require("./document-translator");
    if (!hasDocumentInputFiles(files)) {
      return { ok: true, text, files };
    }

    this._emitEngineNotice(sessionId, {
      code: "documentPreparing",
      level: "progress",
      panel: true,
      replace: true,
    });

    const result = await extractDocuments(files);
    if (result === null) {
      return { ok: true, text, files };
    }

    if (!result.ok) {
      this._emitEngineNotice(sessionId, {
        code: "documentSkipped",
        level: "warning",
        panel: true,
        replace: true,
        replacesCode: "documentPreparing",
        done: true,
      });
      if (isDocumentOnlyUserMessage(text, files)) {
        return {
          ok: false,
          error: "DOCUMENT_FAILED",
          detail: result.detail || undefined,
        };
      }
      return { ok: true, text, files };
    }

    this._emitEngineNotice(sessionId, {
      code: "documentReady",
      level: "info",
      panel: true,
      replace: true,
      replacesCode: "documentPreparing",
      done: true,
    });

    const extracted = new Set(result.extractedPaths || []);
    const outboundFiles = result.keepOriginal
      ? files
      : (files || []).filter((file) => !extracted.has(file.path));
    const enrichedText = buildEnrichedUserText(text, result.text);
    return { ok: true, text: enrichedText, files: outboundFiles };
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
        assistantText: "",
        thinkingText: "",
        contentBlocks: [],
        protocolUnknown: [],
        processEvents: [],
        notices: [],
        usage: null,
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
        recoveryAttempted: false,
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
