"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeAssistantOutput,
  sanitizeError,
  classifyAssistantError,
} = require("./agent-runner");
const { mergeDisplayFileMetadata } = require("./ipc-utils");
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
  collectFailureTextFromState,
  appendIncompleteTurnSummary,
} = require("./turn-error-classify");
const {
  buildDocumentFailureContext,
  buildVisionFailureContext,
  runVisionPreflight,
  runDocumentPreflight,
} = require("./send-preflight");
const {
  mergeMentionedDocumentFiles,
  resolveMentionedDocumentFiles,
} = require("./workspace-document-mentions");
const { buildTaskContract, withTaskContractPrefix } = require("./task-contract");
const { EvidenceLedger } = require("./evidence-ledger");
const { buildTurnPolicy } = require("./turn-policy");
const {
  compactCapabilityContext,
  recommendSkillCapabilityGraph,
  shouldInjectCapabilityContext,
} = require("./capability-broker");
const { PROJECT_ROOT } = require("./config");
const { TurnRunCoordinator } = require("./turn-run-coordinator");
const {
  addTaskEvidence,
  addTaskRisk,
  applyTaskPlanFromTodos,
  assessTaskVerification,
  compactTaskRun,
  completeTaskRun,
  createTaskRun,
  markTaskPhase,
  noteTaskToolUse,
  updateTaskLiveness,
} = require("./task-run-state");
const {
  findBlockingRunningProcessJobs,
  runningProcessJobNotice,
} = require("./process-job-turn-guard");

const log = getLogger("turn-orchestrator");
const MANAGED_MODEL_CONFIG_SEND_TIMEOUT_MS = 90_000;
const RUNTIME_DIAGNOSTIC_TEXT_LIMIT = 4000;

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
  "turn.steered",
  // Emitted AFTER the failed turn finalized (state.turnId already null), so it
  // must be deliverable without an active turn or the renderer never sees it.
  "turn.self_heal_retry",
  "engine.notice",
  "engine.warning",
  "engine.stderr",
  "context.compactionDecision",
  "prompt_suggestions.updated",
]);

function newTurnId() {
  return `turn_${crypto.randomUUID()}`;
}

function newQueueId() {
  return `queue_${crypto.randomUUID()}`;
}

function progressValueFromNotice(notice = {}) {
  const progress = notice?.progress;
  if (!progress || typeof progress !== "object") return null;
  const explicit = Number(progress.percent ?? progress.value);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, explicit));
  const current = Number(progress.current ?? progress.done ?? progress.writtenBytes ?? progress.currentBytes);
  const total = Number(progress.total ?? progress.max ?? progress.totalBytes);
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, (current / total) * 100));
  }
  return null;
}

function queueDispatchOptions(opts = {}) {
  const localAssistant =
    opts.localAssistant && typeof opts.localAssistant === "object"
      ? opts.localAssistant
      : null;
  const queueOrigin = opts.queueOrigin ||
    (opts.scheduledTaskId ? "scheduled_task" : localAssistant ? "local_assistant" : "user");
  return {
    engineText: typeof opts.engineText === "string" ? opts.engineText : null,
    localAssistant,
    reloadSkillsBeforeStart: Boolean(opts.reloadSkillsBeforeStart),
    spawnEngine: opts.spawnEngine,
    skipPreflight: Boolean(opts.skipPreflight),
    skipVision: Boolean(opts.skipVision),
    skipDocument: Boolean(opts.skipDocument),
    scheduledTaskId: opts.scheduledTaskId || null,
    scheduledTaskRunId: opts.scheduledTaskRunId || null,
    scheduledTaskTitle: opts.scheduledTaskTitle || null,
    permissionMode: opts.permissionMode || undefined,
    queueOrigin,
    queueVisibility: opts.queueVisibility === "background" ? "background" : "composer",
  };
}

function redactDiagnosticString(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9._-]{8,}\b/g, "sk-[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]");
}

function compactDiagnosticValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactDiagnosticString(value).slice(0, RUNTIME_DIAGNOSTIC_TEXT_LIMIT);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => compactDiagnosticValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    if (/api[_-]?key|token|secret|password|authorization/i.test(key)) {
      out[key] = item ? "[redacted]" : item;
    } else {
      out[key] = compactDiagnosticValue(item, depth + 1);
    }
  }
  return out;
}

function runnerDiagnostics(ctx, sessionId) {
  try {
    const runner = ctx.runnerPool?.get?.(sessionId);
    return runner?.diagnostics?.() || null;
  } catch (err) {
    return { error: redactDiagnosticString(err?.message || String(err)) };
  }
}

function currentModelRouteFallback() {
  try {
    const lilyEnv = require("./spawn-env").resolveLilyEnv();
    return require("./model-route-audit").classifyModelRoute(lilyEnv);
  } catch {
    return null;
  }
}

async function reportModelFailureDiagnostic(ctx, sessionId, opts = {}) {
  const classified = opts.classified || classifyAssistantError(opts.raw || "");
  if (classified?.category !== "model" && classified?.code !== "ENGINE_UNAVAILABLE") return;
  const raw = redactDiagnosticString(opts.raw || opts.message || "");
  const runner = runnerDiagnostics(ctx, sessionId);
  const session = ctx.sessionManager?.findById?.(sessionId) || null;
  try {
    await require("./service-client").reportRuntimeDiagnostic({
      eventType: "runtime",
      eventSubtype: String(classified?.code || "ENGINE_ERROR").toLowerCase(),
      normalizedKind: classified?.code || "ENGINE_ERROR",
      severity: classified?.retryable === false ? "error" : "warning",
      turnPhase: "failed",
      sessionState: runner?.busy ? "busy" : "failed",
      summary: String(classified?.message || sanitizeError(raw)).slice(0, 1000),
      trace: compactDiagnosticValue({
        schemaVersion: 1,
        source: opts.source || "turn_orchestrator",
        turnId: opts.turnId || null,
        errorCode: classified?.code || "ENGINE_ERROR",
        errorCategory: classified?.category || "",
        retryable: classified?.retryable !== false,
        rawError: raw,
        payload: opts.payload || null,
        runner,
        modelRoute: runner?.modelRoute || currentModelRouteFallback(),
        session: session ? {
          id: session.id,
          projectId: session.projectId || "",
          messageCount: Array.isArray(session.messages) ? session.messages.length : null,
          agentResumeId: session.agentResumeId || null,
        } : null,
      }),
    });
  } catch (err) {
    log.warn("runtime model failure diagnostic upload failed: %s", err?.message || err);
  }
}

function compactQueueItem(item) {
  const visibility = item.options?.queueVisibility || "composer";
  return {
    id: item.id,
    text: item.text,
    files: item.displayFiles || [],
    origin: item.options?.queueOrigin || "user",
    visibility,
    composerVisible: visibility !== "background",
  };
}

const { buildToolPreviewLabel } = require("./tool-preview-label.cjs");

function appendPreflightFallback(text, context, title) {
  return require("./engine-message-layers").appendExtractedContext(text, context, title);
}

function buildDependencyAdvisoryForTurn(text, files) {
  try {
    const {
      buildRuntimePackAdvisory,
      preflightRuntimePacks,
    } = require("./runtime-pack-preflight");
    const preflight = preflightRuntimePacks({ text, files });
    const advisory = buildRuntimePackAdvisory(preflight);
    if (!advisory) return null;
    return {
      text: advisory,
      requiredPackIds: preflight.requiredPackIds || [],
      missingPackIds: preflight.missingPackIds || [],
      installingPackIds: preflight.installingPackIds || [],
    };
  } catch (err) {
    log.warn("runtime pack advisory failed open: %s", err?.message || err);
    return null;
  }
}

async function prepareTurnCapabilityReadiness({ ctx, sessionId, turnId, text, files, deps = {} }) {
  try {
    const readiness = require("./capability-readiness");
    const installer = require("./runtime-pack-installer");
    const plan = (deps.plan || readiness.planCapabilityReadiness)({ text, files });
    const installedPackIds = (deps.installed || installer.installedRuntimePackIds)();
    const installingPackIds = (deps.installing || installer.installingRuntimePackIds)();
    const resolved = readiness.resolveCapabilityReadiness(plan, {
      installedPackIds,
      installingPackIds,
      unavailablePackIds: new Set(),
    });
    const unresolvedPackIds = [...new Set([
      ...(resolved.missingRequiredPackIds || []),
      ...(resolved.installingPackIds || []),
    ])];
    if (unresolvedPackIds.length) {
      const prepare = deps.prepare || ((payload) => {
        const coordinator = ctx?.runtimePackCoordinator || require("./runtime-pack-coordinator").runtimePackCoordinator;
        return coordinator.prepare(payload);
      });
      const prepared = await prepare({ turnId, requiredPackIds: unresolvedPackIds });
      if (prepared.refreshRequired) {
        const refresh = deps.refresh || ctx?.refreshPreparedRuntimeForTurn
          || require("./runner-live-config").refreshPreparedRuntimeForTurn;
        const progressId = prepared.readyPackIds?.[0] || unresolvedPackIds[0];
        const jobId = `runtime_refresh_${turnId}`;
        const publishProgress = deps.progress || installer.publishRuntimePackProgress;
        publishProgress({ id: progressId, jobId, turnId, phase: "refreshing", at: new Date().toISOString() });
        try {
          refresh(ctx, sessionId);
        } catch (error) {
          publishProgress({
            id: progressId,
            jobId,
            turnId,
            phase: "failed",
            error: error?.message || String(error),
            at: new Date().toISOString(),
          });
          return {
            status: "degraded",
            requiredPackIds: plan.requiredPackIds || [],
            enhancementPackIds: plan.enhancementPackIds || [],
            readyPackIds: prepared.readyPackIds || [],
            failedPackIds: unresolvedPackIds,
            unavailablePackIds: prepared.unavailablePackIds || [],
            fallbackCapabilityIds: plan.fallbackCapabilityIds || [],
            error: error?.message || String(error),
          };
        }
        publishProgress({ id: progressId, jobId, turnId, phase: "installed", at: new Date().toISOString() });
      }
      return {
        status: prepared.ok ? "ready" : "degraded",
        requiredPackIds: plan.requiredPackIds || [],
        enhancementPackIds: plan.enhancementPackIds || [],
        readyPackIds: prepared.readyPackIds || [],
        failedPackIds: prepared.failedPackIds || [],
        unavailablePackIds: prepared.unavailablePackIds || [],
        fallbackCapabilityIds: plan.fallbackCapabilityIds || [],
      };
    }
    return {
      status: resolved.status,
      requiredPackIds: plan.requiredPackIds || [],
      enhancementPackIds: plan.enhancementPackIds || [],
      readyPackIds: resolved.readyPackIds || [],
      failedPackIds: [],
      unavailablePackIds: resolved.unavailablePackIds || [],
      fallbackCapabilityIds: plan.fallbackCapabilityIds || [],
    };
  } catch (error) {
    return { status: "baseline", error: error?.message || String(error) };
  }
}

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
      queue: state.queue.map((item) => compactQueueItem(item)),
      runtime: this.eventBus.snapshot(sessionId),
      taskRun: compactTaskRun(state.taskRun),
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
      const claim = this._claimAgentResumeId(sessionId, agentResumeId);
      if (!claim?.ok) return;
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

    runner.on("engine-session-invalidated", (payload = {}) => {
      if (payload.resetResume) {
        this.ctx.sessionManager?.clearAgentResumeId?.(sessionId);
      }
      this.ctx.runnerPool?.terminateSession?.(sessionId);
      log.warn(
        "engine session invalidated after recoverable failure: session=%s resetResume=%s error=%s reason=%s",
        sessionId,
        payload.resetResume ? "true" : "false",
        payload.errorCode || "",
        payload.reason || "",
      );
    });

    runner.on("done", (payload) => {
      void this._handleDone(sessionId, payload);
    });

    runner.on("error", (message) => {
      void this._handleError(sessionId, message);
    });
  }

  _claimAgentResumeId(sessionId, agentResumeId) {
    const existingOwner = typeof this.ctx.sessionManager.findAgentResumeOwner === "function"
      ? this.ctx.sessionManager.findAgentResumeOwner(agentResumeId, sessionId)
      : null;
    const ownerRunner = existingOwner ? this.ctx.runnerPool?.get?.(existingOwner.id) : null;
    if (existingOwner && ownerRunner?.isAlive?.()) {
      this.ctx.sessionManager.clearAgentResumeId?.(sessionId);
      this.ctx.runnerPool?.terminateSession?.(sessionId);
      return { ok: false, conflictOwnerId: existingOwner.id, evictedSessionIds: [sessionId] };
    }

    let binding = null;
    try {
      const session = this.ctx.sessionManager?.findById?.(sessionId);
      const project = session?.projectId && typeof this.ctx.projectManager?.find === "function"
        ? this.ctx.projectManager.find(session.projectId)
        : null;
      const activeSkillIds = require("./skill-manager").resolveSessionSkillIds(session);
      binding = require("./resume-binding").buildResumeBinding({
        session,
        project,
        activeSkillIds,
        sessionManager: this.ctx.sessionManager,
        resumeId: agentResumeId,
      });
    } catch (err) {
      log.warn("agent resume binding build failed open: %s", err?.message || String(err));
    }

    const claim = typeof this.ctx.sessionManager.claimAgentResumeId === "function"
      ? this.ctx.sessionManager.claimAgentResumeId(sessionId, agentResumeId, binding)
      : { ok: this.ctx.sessionManager.setAgentResumeId(sessionId, agentResumeId, binding), evictedSessionIds: [] };
    if (!claim?.ok) return claim;
    for (const evictedSessionId of claim.evictedSessionIds || []) {
      if (evictedSessionId === sessionId) continue;
      this.ctx.runnerPool?.terminateSession?.(evictedSessionId);
    }
    return claim;
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
          metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
          title: payload.title || "",
          status: "running",
          parentToolUseId: payload.parentToolUseId || null,
          startedAt: Date.now(),
        });
        this._markTaskProgress(sessionId, "tool_running", `Running ${tool.name || payload.name || "tool"}`, {
          tool,
          resumeState: {
            lastToolId: toolId,
            lastToolName: tool.name || payload.name || "unknown",
          },
        });
        this._scheduleSubagentWatch(sessionId, toolId, tool);
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
          metadata: tool.metadata || payload.metadata || {},
          title: tool.title || payload.title || "",
          status: "running",
          parentToolUseId: payload.parentToolUseId || null,
        }, Date.now());
        const subagent = this._syncSubagentFromTool(sessionId, tool);
        if (subagent) this._emit(sessionId, "subagent.event", { subagent: this._compactSubagent(subagent) });
        this._emit(sessionId, "tool.started", {
          id: toolId,
          name: tool.name || payload.name || "unknown",
          input: compactToolInput(tool.input || payload.input || {}, tool.name || payload.name || "unknown"),
          metadata: tool.metadata || payload.metadata || {},
          title: tool.title || payload.title || "",
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
        if (payload.metadata && typeof payload.metadata === "object") tool.metadata = payload.metadata;
        if (payload.title) tool.title = payload.title;
        tool.endedAt = Date.now();
        if (Number.isFinite(tool.startedAt)) tool.durationMs = Math.max(0, tool.endedAt - tool.startedAt);
        this._clearSubagentWatch(sessionId, toolId);
        this._emitSubagentDoneNotice(sessionId, tool);
        state.evidenceLedger?.recordTool?.(tool);
        this._addTaskEvidence(sessionId, {
          kind: "tool_result",
          label: `${tool.name || "Tool"} ${tool.status || "done"}`,
          status: tool.status,
          refId: toolId,
        }, { tool });
        upsertTimelineTool(state, tool, Date.now());
        const subagent = this._syncSubagentFromTool(sessionId, tool);
        if (subagent) this._emit(sessionId, "subagent.event", { subagent: this._compactSubagent(subagent) });
        this._emit(sessionId, "tool.done", {
          id: toolId,
          status: tool.status,
          result: tool.result,
          metadata: tool.metadata || {},
          title: tool.title || "",
        });
        const { emitDiffForTool } = require("./diff-capture");
        emitDiffForTool(sessionId, toolId, this.ctx, state.turnId);
        break;
      }
      case "subagent.event": {
        const update = this._applySubagentEvent(sessionId, payload);
        if (update) this._emit(sessionId, "subagent.event", update);
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
        this._updateTaskPlanFromTodos(sessionId, todos);
        this._emit(sessionId, "todo.updated", {
          id: toolId,
          todos,
        });
        break;
      }
      case "permission.requested":
        state.phase = "awaiting_user";
        state.pendingPermissions.set(payload.requestId, payload);
        this._markTaskAwaitingUser(sessionId, "permission_requested", "Waiting for permission");
        this._emit(sessionId, "permission.requested", payload);
        break;
      case "user_question.requested":
        state.phase = "awaiting_user";
        state.pendingQuestions.set(payload.requestId, payload);
        this._markTaskAwaitingUser(sessionId, "user_question_requested", "Waiting for user answer");
        this._emit(sessionId, "user_question.requested", payload);
        break;
      case "permission.resolved":
        state.pendingPermissions.delete(payload.requestId);
        state.pendingQuestions.delete(payload.requestId);
        if (state.phase === "awaiting_user" && !this._hasPendingUserBlocks(state)) state.phase = "streaming";
        this._emit(sessionId, "permission.resolved", payload);
        break;
      case "user_question.resolved":
        state.pendingQuestions.delete(payload.requestId);
        if (state.phase === "awaiting_user" && !this._hasPendingUserBlocks(state)) state.phase = "streaming";
        this._emit(sessionId, "user_question.resolved", payload);
        break;
      case "hook.requested":
        state.phase = "awaiting_user";
        state.pendingHooks.set(payload.requestId, payload);
        this._markTaskAwaitingUser(sessionId, "hook_requested", "Waiting for hook decision");
        this._emit(sessionId, "hook.requested", payload);
        break;
      case "hook.resolved":
        state.pendingHooks.delete(payload.requestId);
        if (state.phase === "awaiting_user" && !this._hasPendingUserBlocks(state)) state.phase = "streaming";
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
        if (activity) this._markTaskProgress(sessionId, "runtime_progress", activity);
        this._updateTaskLivenessFromNotice(sessionId, notice, type);
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
      case "usage.updated": {
        state.usage = payload.usage || payload;
        // Track finish reasons for the truncation guard: a final "unknown" on
        // a turn whose earlier steps reported REAL reasons means the gateway
        // cut the stream mid-turn (classifyTurnFailure -> TRUNCATED_TURN_END).
        const stopReason = String(payload.stopReason || "");
        if (stopReason) {
          state.lastStopReason = stopReason;
          if (stopReason !== "unknown") state.sawRecognizedStopReason = true;
        }
        this._emit(sessionId, "usage.updated", payload);
        break;
      }
      case "assistant.message_stop":
        closeStreamingBlocks(state, Date.now());
        this._emit(sessionId, "assistant.message_stop", payload);
        break;
      case "process.event": {
        const activity = activityFromProcessPayload(payload);
        if (activity) setActivityLabel(state, activity);
        if (activity) this._markTaskProgress(sessionId, "runtime_progress", activity);
        state.processEvents.push(payload);
        if (state.processEvents.length > 200) {
          state.processEvents.splice(0, state.processEvents.length - 200);
        }
        this._emit(sessionId, "process.event", payload);
        break;
      }
      case "session.hydrated":
        if (payload.agentResumeId) {
          const claim = this._claimAgentResumeId(sessionId, payload.agentResumeId);
          if (!claim?.ok) break;
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
        this._handleRuntimeControl(sessionId, payload);
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
      // Steer ("插话"): inject into the RUNNING turn rather than queuing for after.
      // On by default; LILY_ENABLE_STEER=0 is the instant kill-switch back to queue.
      // Fail-open — any steer failure degrades to the queue path below, so the worst
      // case is identical to today's behavior (CAPABILITY-GATE Rule 13).
      if (opts.mode === "steer" && process.env.LILY_ENABLE_STEER !== "0") {
        const steered = await this._trySteer(session, displayText, files, opts);
        if (steered?.ok) return steered;
      }
      const item = {
        id: newQueueId(),
        text: displayText,
        files,
        displayFiles: mergeDisplayFileMetadata(files, opts.displayFiles),
        options: queueDispatchOptions(opts),
      };
      state.queue.push(item);
      this._emitQueue(sessionId);
      return {
        ok: true,
        queued: true,
        queueLength: state.queue.length,
        itemId: item.id,
        ...(opts.mode === "steer" ? { steerFellBack: true } : {}),
      };
    }

    return this._startTurn(session, displayText, files, opts);
  }

  // Inject a message into the in-flight turn via the engine's native steering (the
  // running prompt loop picks up the appended user message at its next step). Commits
  // the user message into the CURRENT turn only AFTER the engine accepts it, so a
  // failed steer leaves no orphaned bubble before the caller falls back to the queue.
  async _trySteer(session, text, files, opts = {}) {
    const sessionId = session.id;
    const runner = this.ctx.runnerPool.get(sessionId);
    if (!runner?.isBusy?.() || typeof runner.steer !== "function") return { ok: false };
    let accepted = false;
    try {
      accepted = await runner.steer({
        text,
        files,
        allowImageFileParts: Boolean(require("./model-presets").activePresetSupportsVision()),
      });
    } catch (err) {
      log.warn("steer dispatch failed: %s", err?.message || err);
      return { ok: false };
    }
    if (!accepted) return { ok: false };
    const state = this._state(sessionId);
    const turnId = state.turnId;
    const steerSeq = (state.steerCount || 0) + 1;
    state.steerCount = steerSeq;
    const displayFiles = mergeDisplayFileMetadata(files, opts.displayFiles);
    try {
      this.transcriptStore.commitUserMessage(sessionId, { text, files: displayFiles, turnId, steer: true, steerSeq });
    } catch (err) {
      log.warn("steer user message commit failed: %s", err?.message || err);
    }
    appendTimelineNotice(state, {
      code: "turnSteered",
      level: "info",
      detail: String(text || "").trim(),
    }, Date.now());
    this._emit(
      sessionId,
      "user.committed",
      { text, files: displayFiles && displayFiles.length ? displayFiles : null, steer: true, steerSeq },
      { turnId },
    );
    this._emit(sessionId, "turn.steered", { text, steerSeq }, { turnId });
    return { ok: true, steered: true, turnId, steerSeq };
  }

  _handleRuntimeControl(sessionId, payload = {}) {
    if (
      payload?.action !== "steer" ||
      !["lilyNativeSkillFallback", "platformCapabilitySkillFallback"].includes(payload?.reason)
    ) return;
    if (process.env.LILY_ENABLE_STEER === "0") return;
    const skillId = String(payload.skillId || "").trim();
    const text = String(payload.text || "").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(skillId) || !text) return;
    if (!fs.existsSync(path.join(PROJECT_ROOT, "resources", "skills-catalog", skillId, "SKILL.md"))) return;
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) return;
    if (!state.platformCapabilitySkillFallbackSteers) {
      state.platformCapabilitySkillFallbackSteers = state.lilyNativeSkillFallbackSteers || new Set();
      state.lilyNativeSkillFallbackSteers = state.platformCapabilitySkillFallbackSteers;
    }
    if (state.platformCapabilitySkillFallbackSteers.has(skillId)) return;
    state.platformCapabilitySkillFallbackSteers.add(skillId);
    const runner = this.ctx.runnerPool?.get?.(sessionId);
    if (!runner?.isBusy?.() || typeof runner.steer !== "function") return;
    void runner.steer({
      text,
      files: [],
      allowImageFileParts: Boolean(require("./model-presets").activePresetSupportsVision()),
    }).then((ok) => {
      if (!ok) log.warn("native Lily skill fallback steer was rejected for %s", skillId);
    }).catch((err) => {
      log.warn("native Lily skill fallback steer failed for %s: %s", skillId, err?.message || err);
    });
  }

  // Show the user's message in the conversation IMMEDIATELY, before any slow work
  // (e.g. the scheduled-task model parse, which takes seconds). Returns the turnId
  // so the follow-up completeLocalAssistantTurn can reuse it with recordUser:false
  // — same turn, no duplicate, and the user message is no longer blocked behind the
  // parse. Because user.committed fires well before turn.completed, it is also never
  // dropped as "terminal", so the user message reliably precedes the assistant card.
  echoUserMessage(sessionId, text, files = [], displayFiles = null) {
    const displayText = String(text || "").trim();
    const fileMeta = mergeDisplayFileMetadata(files, displayFiles);
    if (!displayText && !(fileMeta || []).length) return null;
    const turnId = newTurnId();
    try {
      this.transcriptStore.commitUserMessage(sessionId, { text: displayText, files: fileMeta, turnId });
    } catch (err) {
      log.warn("echo user message commit failed: %s", err?.message || err);
    }
    this._emit(sessionId, "user.committed", { text: displayText, files: fileMeta && fileMeta.length ? fileMeta : null }, { turnId });
    return turnId;
  }

  async completeLocalAssistantTurn(sessionId, text, files = [], opts = {}) {
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
        displayFiles: mergeDisplayFileMetadata(files, opts.displayFiles),
        options: queueDispatchOptions({
          ...opts,
          localAssistant: {
            assistant: opts.assistant,
            scheduledDraft: opts.scheduledDraft || null,
            turnId: opts.turnId || null,
          },
        }),
      };
      state.queue.push(item);
      this._emitQueue(sessionId);
      return { ok: true, queued: true, queueLength: state.queue.length, itemId: item.id };
    }

    return this._startLocalAssistantTurn(session, displayText, files, opts);
  }

  /** Runtime self-heal: a healable failure triggers a forced re-probe of the
   *  active custom model in the background. If the compatibility profile
   *  actually changed, the failed message is retried once, silently. Runs
   *  after the turn already finalized as failed, so every internal error here
   *  fails open to the normal failure UX. */
  async _maybeSelfHealAndRetry(sessionId, failure) {
    try {
      // Tool-call rescue runs FIRST for leaked-tool-call failures: a corrective
      // retry fixes model behavior in seconds, while a re-probe only fixes
      // gateway config. The probe still learns in the background either way.
      if (await this._maybeToolCallRescueRetry(sessionId, failure)) return;
      const { attemptModelSelfHeal, isHealableFailureCode } = require("./model-self-heal");
      if (!isHealableFailureCode(failure?.code)) return;
      const result = await attemptModelSelfHeal({
        code: failure.code,
        systemPromptProbeText: this._selfHealProbeText(sessionId),
      });
      if (!result?.healed) return;
      // Don't fight the user: retry only while the session is still idle with
      // nothing queued (they may already have resent or moved on).
      const state = this._state(sessionId);
      if (state.turnId || state.queue.length) return;
      if (this.ctx.runnerPool.get(sessionId)?.isBusy?.()) return;
      // Same side-effect guard as turn rescue: a heal retry re-runs the WHOLE
      // turn, so it is only safe when every executed tool was read-only —
      // replaying a turn that already wrote files or sent mail is worse than
      // failing honestly (the healed profile still helps the user's own retry).
      const { isSideEffectFreeToolRun } = require("./tool-call-rescue");
      if (!isSideEffectFreeToolRun([...(state.tools?.values?.() || [])])) {
        log.info(`model self-heal retry skipped (non-read-only tools ran): session=${sessionId}`);
        return;
      }
      // Idle runners still hold the pre-heal model config; recycle them so the
      // retry binds with the repaired profile.
      require("./runner-live-config").terminateIdleRunners(this.ctx.runnerPool);
      log.info(`model self-heal retry: session=${sessionId} code=${failure.code}`);
      this._emit(sessionId, "turn.self_heal_retry", { errorCode: failure.code });
      const retried = await this.retryLastMessage(sessionId);
      if (!retried?.ok) log.warn(`model self-heal retry not sent: ${retried?.error || "unknown"}`);
    } catch (err) {
      log.warn(`model self-heal failed open: ${err?.message || String(err)}`);
    }
  }

  /** Turn rescue: immediate silent retry-once for failures a retry plausibly
   *  fixes without config changes — leaked tool-call text (retry carries a
   *  corrective instruction on the ENGINE-facing text) and empty completions
   *  (plain retry absorbs gateway flakes). The visible transcript stays
   *  untouched. Returns true when a rescue retry was dispatched (the self-heal
   *  path is then skipped for this failure; the background probe still runs so
   *  the platform keeps learning). Fail-open: any error → normal failure flow. */
  async _maybeToolCallRescueRetry(sessionId, failure) {
    try {
      const rescue = require("./tool-call-rescue");
      const strategy = rescue.rescueStrategyFor(failure?.code);
      if (!strategy) return false;
      if (!rescue.shouldAttemptRescue(sessionId, failure.code)) return false;
      // Strategies with delayMs wait out a transient cause (engine start
      // failures) BEFORE the idle checks below, so a user who already resent
      // during the wait is never fought.
      if (strategy.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, strategy.delayMs));
      }
      // Don't fight the user: only while the session is idle with nothing queued.
      const state = this._state(sessionId);
      if (state.turnId || state.queue.length) return false;
      if (this.ctx.runnerPool.get(sessionId)?.isBusy?.()) return false;
      // Side-effect guard: a retry re-runs the WHOLE turn. Only rescue turns
      // whose executed tools are ALL side-effect-free (reads/research) —
      // replaying a turn that already sent mail or edited files is worse than
      // failing honestly.
      if (!rescue.isSideEffectFreeToolRun([...(state.tools?.values?.() || [])])) return false;
      const lastUser = this.ctx.sessionManager.getLastUserMessage(sessionId);
      if (!lastUser) return false;
      rescue.markRescueAttempt(sessionId, failure.code);
      // Deliberately NO probe here: firing the self-heal probe now would burn
      // its per-preset cooldown, so a deterministic gateway defect could no
      // longer take the probe→profile-change→retry recovery on the SECOND
      // failure (the rescue cooldown routes it there untouched). Flakes are
      // absorbed by this retry; defects keep the exact old recovery path.
      log.info(`turn rescue retry: session=${sessionId} kind=${strategy.kind}`);
      this._emit(sessionId, "turn.self_heal_retry", { errorCode: failure.code, kind: strategy.kind });
      this.transcriptStore.removeLastAssistantMessage(sessionId);
      // skipPreflight: the model connection was proven live THIS turn (the
      // request reached the model); a full preflight could spuriously block
      // the silent retry. A dead runner just fails the send → logged → the
      // user keeps the normal failure UX they already saw.
      const content = String(lastUser.content || "").trim();
      // The corrective hint speaks the language the probe showed this model
      // actually follows (capability.recipes.instructionLanguage).
      const hint = strategy.kind === "tool_call_rescue"
        ? rescue.correctiveHintFor(this._modelRecipes())
        : strategy.hint;
      const retried = await this.sendUserMessage(sessionId, lastUser.content, lastUser.files || [], {
        recordUser: false,
        spawnEngine: true,
        // Belt over the cooldown: a rescue resend that fails at preflight
        // again must not schedule another rescue from inside itself.
        rescueAttempt: true,
        // Strategies with preflight (RUNNER_TERMINATED / RUNNER_ERROR) lost
        // their runner — pool.get() would return null, so the resend must run
        // the full ensure path and build a fresh one.
        skipPreflight: !strategy.preflight,
        ...(hint ? { engineText: `${content}\n\n${hint}` } : {}),
      });
      if (!retried?.ok) log.warn(`turn rescue retry not sent: ${retried?.error || "unknown"}`);
      return true;
    } catch (err) {
      log.warn(`turn rescue failed open: ${err?.message || String(err)}`);
      return false;
    }
  }

  /** The active model's probed recipes (capability.recipes), or {} — never throws. */
  _modelRecipes() {
    try {
      return JSON.parse(require("./spawn-env").resolveLilyEnv().LILY_MODEL_RECIPES || "{}") || {};
    } catch {
      return {};
    }
  }

  /** The active session guide (AGENT.md + protocol appendices) — same text the
   *  save-time probe uses, so the re-probe measures realistic prompt sizes. */
  _selfHealProbeText(sessionId) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const guide = path.join(require("./config").sessionGuideDir(sessionId), "AGENT.md");
      const base = fs.existsSync(guide) ? fs.readFileSync(guide, "utf8") : "";
      if (!base.trim()) return "";
      const { appendLargeInputProtocolGuidance } = require("./large-input-protocol");
      const { appendProcessJobProtocolGuidance } = require("./process-job-protocol");
      return appendProcessJobProtocolGuidance(appendLargeInputProtocolGuidance(base));
    } catch {
      return "";
    }
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
      for (const item of state.queue) {
        this._completeQueuedScheduledRun(item, "turn.interrupted", {
          errorCode: "USER_STOPPED",
        });
      }
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
      displayFiles: mergeDisplayFileMetadata(files, opts.displayFiles),
      options: queueDispatchOptions(opts),
    };
    for (const queued of state.queue) {
      this._completeQueuedScheduledRun(queued, "turn.interrupted", {
        errorCode: "QUEUE_REPLACED",
      });
    }
    state.queue = [item];
    this._emitQueue(sessionId);
    this.interrupt(sessionId, { clearQueue: false });
    void this._dispatchNext(sessionId);
    return { ok: true, queued: true, priority: true, queueLength: state.queue.length, itemId: item.id };
  }

  async _tryStartQueuedItem(sessionId, item) {
    const session = this.ctx.sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };
    if (item.options?.localAssistant) {
      return await this._startLocalAssistantTurn(session, item.text, item.files, {
        fromQueue: true,
        displayFiles: item.displayFiles,
        assistant: item.options.localAssistant.assistant,
        scheduledDraft: item.options.localAssistant.scheduledDraft || null,
        turnId: item.options.localAssistant.turnId || null,
      });
    }
    const runner = this.ctx.runnerPool.get(sessionId);
    if (runner?.isBusy?.()) return { ok: false, retry: true, error: "RUNNER_BUSY" };
    if (item.options?.reloadSkillsBeforeStart && runner?.isAlive?.() && !runner.reloadSkills()) {
      this.ctx.runnerPool.terminateSession(sessionId);
    }
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

  async _startLocalAssistantTurn(session, text, files, opts = {}) {
    const rawUserText = String(text || "").trim();
    const state = this._state(session.id);
    state.phase = "starting";
    // Reuse a pre-echoed turnId (see echoUserMessage) so the already-shown user
    // message and this turn's assistant card belong to the SAME turn.
    state.turnId = opts.turnId || newTurnId();
    state.steerCount = 0;
    state.admittedSeq = null;
    state.assistantText = "";
    state.thinkingText = "";
    state.contentBlocks = [];
    state.protocolUnknown = [];
    state.processEvents = [];
    state.notices = [];
    state.usage = null;
    state.lastStopReason = "";
    state.sawRecognizedStopReason = false;
    state.taskContract = null;
    state.turnPolicy = null;
    state.evidenceLedger = new EvidenceLedger();
    state.taskRun = null;
    state.enginePayload = null;
    state.legacyContextHydrated = false;
    resetTimelineState(state);
    state.blockIndexToToolId = new Map();
    state.terminalEmitted = false;
    state.pendingPermissions.clear();
    state.pendingQuestions.clear();
    state.pendingHooks.clear();
    state.tools.clear();
    state.startedAt = Date.now();
    state.updatedAt = state.startedAt;
    const displayFiles = mergeDisplayFileMetadata(files, opts.displayFiles);
    this._beginTaskRun(session.id, rawUserText, {
      displayFiles,
      localAssistant: true,
    });
    state.currentPayload = {
      rawText: rawUserText,
      text: rawUserText,
      files,
      displayFiles,
    };
    try {
      const admitted = this.ctx.sessionManager?.admitTurnInput?.(session.id, {
        turnId: state.turnId,
        delivery: opts.fromQueue ? "queue" : "local",
        status: "admitted",
        userText: rawUserText,
        files: displayFiles,
        metadata: {
          fromQueue: Boolean(opts.fromQueue),
          localAssistant: true,
        },
        createdAt: state.startedAt,
      });
      state.admittedSeq = admitted?.admittedSeq || null;
    } catch (err) {
      log.warn("local turn input admission failed: %s", err?.message || err);
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

    this._emit(session.id, "turn.started", {
      text: rawUserText,
      queueLength: state.queue.length,
      engine: {
        localAssistant: true,
      },
      taskContract: null,
      turnPolicy: null,
    });

    const assistant = String(opts.assistant || "").trim();
    state.assistantText = assistant;
    const completedTurnId = state.turnId;
    this._finalize(session.id, "turn.completed", {
      assistant,
      scheduledDraft: opts.scheduledDraft || null,
      resultFromCli: false,
    });
    if (!opts.fromQueue) {
      void this._dispatchNext(session.id);
    }
    return {
      ok: true,
      turnId: completedTurnId,
      userCommitted: opts.recordUser === false ? null : { text: rawUserText, files: displayFiles },
      localAssistant: true,
    };
  }

  cancelQueuedMessage(sessionId, itemId) {
    const state = this._state(sessionId);
    const before = state.queue.length;
    const removed = state.queue.filter((item) => item.id === itemId);
    state.queue = state.queue.filter((item) => item.id !== itemId);
    for (const item of removed) {
      this._completeQueuedScheduledRun(item, "turn.interrupted", {
        errorCode: "QUEUE_CANCELLED",
      });
    }
    this._emitQueue(sessionId);
    return before !== state.queue.length
      ? { ok: true, sessionId, queueLength: state.queue.length }
      : { ok: false, error: "NOT_FOUND" };
  }

  async _startTurn(session, text, files, opts = {}) {
    const rawUserText = String(text || "").trim();
    const {
      diagnoseSendBlocker: defaultDiagnoseSendBlocker,
      ensureSessionRunner: defaultEnsureSessionRunner,
      refreshRemoteConfigForSend,
    } = require("./ipc-utils");
    const diagnoseSendBlocker = this.ctx.diagnoseSendBlocker || defaultDiagnoseSendBlocker;
    const ensureSessionRunner = this.ctx.ensureSessionRunner || defaultEnsureSessionRunner;
    if (!opts.skipPreflight) {
      let blocked = diagnoseSendBlocker(this.ctx, session.id);
      if (blocked?.error === "SERVICE_MODEL_CONFIG_UNAVAILABLE") {
        const configRefresh = await refreshRemoteConfigForSend({
          force: true,
          timeoutMs: MANAGED_MODEL_CONFIG_SEND_TIMEOUT_MS,
          repairManagedService: true,
        });
        if (configRefresh?.ok) {
          this.ctx.runnerPool?.terminateSession?.(session.id);
        }
        blocked = diagnoseSendBlocker(this.ctx, session.id);
      }
      if (blocked) return { ok: false, error: blocked.error, detail: blocked.detail };
    }

    let ensured = null;
    let runner = null;
    const project = session?.projectId && typeof this.ctx.projectManager?.find === "function"
      ? this.ctx.projectManager.find(session.projectId)
      : null;
    const displaySourceFiles = Array.isArray(files) ? files : [];
    if (!opts.skipDocument && project?.path) {
      try {
        const mentioned = resolveMentionedDocumentFiles(rawUserText, project.path, displaySourceFiles);
        files = mergeMentionedDocumentFiles(files, mentioned.files);
      } catch (err) {
        // Fail open to the original payload. Filename auto-resolution is a convenience,
        // not a reason to block a normal turn.
        log.warn("workspace document mention resolution failed: %s", err?.message || err);
      }
    }

    const state = this._state(session.id);
    const allowImageFileParts = Boolean(require("./model-presets").activePresetSupportsVision());
    state.phase = "starting";
    state.turnId = newTurnId();
    state.steerCount = 0;
    state.admittedSeq = null;
    state.assistantText = "";
    state.thinkingText = "";
    state.contentBlocks = [];
    state.protocolUnknown = [];
    state.processEvents = [];
    state.notices = [];
    state.usage = null;
    state.lastStopReason = "";
    state.sawRecognizedStopReason = false;
    state.taskContract = null;
    state.turnPolicy = null;
    state.evidenceLedger = new EvidenceLedger();
    state.taskRun = null;
    state.enginePayload = null;
    state.legacyContextHydrated = false;
    resetTimelineState(state);
    state.blockIndexToToolId = new Map();
    state.terminalEmitted = false;
    state.pendingPermissions.clear();
    state.pendingQuestions.clear();
    state.pendingHooks.clear();
    state.tools.clear();
    const displayFiles = mergeDisplayFileMetadata(displaySourceFiles, opts.displayFiles);
    let dependencyAdvisory = buildDependencyAdvisoryForTurn(rawUserText, files);
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

    const capabilityReadinessTrace = opts.skipPreflight
      ? null
      : await prepareTurnCapabilityReadiness({
          ctx: this.ctx,
          sessionId: session.id,
          turnId: state.turnId,
          text: rawUserText,
          files,
          deps: this.ctx.capabilityReadinessDeps,
        });
    if (capabilityReadinessTrace?.status === "ready") {
      dependencyAdvisory = buildDependencyAdvisoryForTurn(rawUserText, files);
    }

    ensured = opts.skipPreflight
      ? { runner: this.ctx.runnerPool.get(session.id) }
      : ensureSessionRunner(this.ctx, session.id, {
          spawn: opts.spawnEngine !== false,
          permissionMode: opts.permissionMode,
        });
    runner = ensured.runner;
    if (!runner) {
      const error = ensured.error || "RUNNER_ERROR";
      const detail = ensured.detail
        || (error === "OPENCODE_NOT_READY" ? "" : "Unable to start the assistant process. Please check the terminal logs or restart the application.");
      this._finalize(session.id, "turn.failed", {
        failed: true,
        assistant: detail || error,
        code: error,
      });
      // Engine-start failures never reached a model — side-effect-free by
      // construction, so the rescue table may quietly wait + resend once
      // (RUNNER_ERROR strategy). Codes without a strategy (e.g. the engine
      // binary is missing) fall through to the normal failure UX.
      if (!opts.rescueAttempt) {
        void this._maybeSelfHealAndRetry(session.id, { code: error, retryable: true });
      }
      const result = { ok: false, error };
      if (detail) result.detail = detail;
      return result;
    }
    if (!opts.skipPreflight && ensured.usedResume && session.agentResumeId) {
      try {
        const { verifyRunnerResumeContinuity } = require("./resume-continuity-guard");
        const continuity = await verifyRunnerResumeContinuity({
          runner,
          sessionManager: this.ctx.sessionManager,
          sessionId: session.id,
        });
        if (!continuity.ok) {
          log.warn(
            "opencode resume continuity mismatch; resetting engine session: session=%s resume=%s reason=%s local=%s official=%s",
            session.id,
            session.agentResumeId || "",
            continuity.reason || "",
            continuity.localUserSample || "",
            continuity.officialUserSample || "",
          );
          this.ctx.sessionManager?.clearAgentResumeId?.(session.id);
          this.ctx.runnerPool?.terminateSession?.(session.id);
          ensured = ensureSessionRunner(this.ctx, session.id, {
            spawn: opts.spawnEngine !== false,
            permissionMode: opts.permissionMode,
          });
          runner = ensured.runner;
          if (!runner) {
            const error = ensured.error || "RUNNER_ERROR";
            const detail = ensured.detail
              || (error === "OPENCODE_NOT_READY" ? "" : "Unable to start the assistant process. Please check the terminal logs or restart the application.");
            this._finalize(session.id, "turn.failed", { failed: true, assistant: detail || error, code: error });
            if (!opts.rescueAttempt) {
              void this._maybeSelfHealAndRetry(session.id, { code: error, retryable: true });
            }
            const result = { ok: false, error };
            if (detail) result.detail = detail;
            return result;
          }
        }
      } catch (err) {
        log.warn("opencode resume continuity check failed open: %s", err?.message || String(err));
      }
    }

    if (!opts.skipVision) {
      const vision = await runVisionPreflight(text, files, {
        emitNotice: (notice) => this._emitEngineNotice(session.id, notice),
        nativeVision: allowImageFileParts,
      });
      if (!vision.ok) {
        log.warn(
          "vision preflight returned non-ok; degrading instead of failing turn: session=%s turn=%s error=%s detail=%s",
          session.id,
          state.turnId,
          vision.error || "",
          vision.detail || "",
        );
        text = appendPreflightFallback(
          text,
          buildVisionFailureContext(files, vision.detail || vision.error || "VISION_FAILED"),
          "Image recognition result",
        );
        state.currentPayload = { rawText: rawUserText, text, files, displayFiles };
      } else {
        text = vision.text;
        files = vision.files;
        state.currentPayload = { rawText: rawUserText, text, files, displayFiles };
      }
    }

    if (!opts.skipDocument) {
      const document = await runDocumentPreflight(text, files, {
        emitNotice: (notice) => this._emitEngineNotice(session.id, notice),
      });
      if (!document.ok) {
        log.warn(
          "document preflight returned non-ok; degrading instead of failing turn: session=%s turn=%s error=%s detail=%s",
          session.id,
          state.turnId,
          document.error || "",
          document.detail || "",
        );
        text = appendPreflightFallback(
          text,
          buildDocumentFailureContext(files, document.detail || document.error || "DOCUMENT_FAILED"),
          "Document extraction result",
        );
        state.evidenceLedger?.recordDocumentExtraction?.({
          index: null,
          documents: [],
          chunks: [],
          extractedPaths: [],
        });
        state.currentPayload = { rawText: rawUserText, text, files, displayFiles };
      } else {
        text = document.text;
        files = document.files;
        state.evidenceLedger?.recordDocumentExtraction?.(document.documentEvidence);
        if (document.documentEvidence?.index) {
          try {
            const { persistDocumentQueryIndex } = require("./document-query-store");
            persistDocumentQueryIndex({
              sessionId: session.id,
              turnId: state.turnId,
              index: document.documentEvidence.index,
              extractedPaths: document.documentEvidence.extractedPaths || [],
            });
          } catch (err) {
            log.warn("document query index persist failed: %s", err?.message || err);
          }
        }
        state.currentPayload = { rawText: rawUserText, text, files, displayFiles };
      }
    }

    const taskContract = buildTaskContract({ text, files, session, project });
    state.taskContract = taskContract.active ? taskContract : null;
    const turnPolicy = buildTurnPolicy({ text, taskContract });
    state.turnPolicy = turnPolicy;
    if (this._shouldBeginTaskRunAtTurnStart({ taskContract, turnPolicy, scheduledTask: state.scheduledTask })) {
      this._beginTaskRun(session.id, rawUserText, {
        displayFiles,
        scheduledTask: state.scheduledTask,
      });
    }
    if (
      project?.path &&
      (turnPolicy.rigor === "coverage" || turnPolicy.requiresSourceCoverage) &&
      Array.isArray(turnPolicy.sourceCoverage?.explicitTerms) &&
      turnPolicy.sourceCoverage.explicitTerms.length
    ) {
      try {
        const { searchWorkspaceIndex } = require("./workspace-index");
        const candidates = searchWorkspaceIndex(project.path, turnPolicy.sourceCoverage.explicitTerms, {
          limit: turnPolicy.evidenceBudget?.maxFilesToRead || 20,
        });
        state.evidenceLedger?.addWorkspaceCandidates?.(candidates);
      } catch (err) {
        log.warn("workspace index search failed: %s", err?.message || err);
      }
    }

    let engineText =
      typeof opts.engineText === "string" && opts.engineText.trim()
        ? opts.engineText.trim()
        : text;
    const preRehydrateText = engineText;
    let rehydrated = false;
    let shortFollowupContext = false;
    let contextMemory = null;
    let capabilityContextTrace = null;
    {
      const { withSessionRehydratePrefix } = require("./session-bootstrap");
      const { readSessionSummary } = require("./session-memory");
      const { withShortFollowupContext } = require("./session-followup-context");
      const { buildContextMemory } = require("./memory-registry");
      const { readProjectMemoryIndex } = require("./project-memory");
      const { buildWorkspaceDigest, readLearnedConventions } = require("./learned-context");
      const { readMemoryPreferences } = require("./memory-preferences");
      const { addLayersToEngineText } = require("./engine-message-layers");
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
      const shouldLoadProjectMemory =
        Boolean(project?.path) &&
        (turnPolicy.rigor === "grounded" ||
          turnPolicy.rigor === "coverage" ||
          Boolean(ensured.coldStart) ||
          rehydrated ||
          shortFollowupContext);
      contextMemory = buildContextMemory({
        userText: rawUserText,
        sessionSummary: summary,
        project,
        disabledKinds: readMemoryPreferences(session.projectId).disabledKinds,
        projectMemory: shouldLoadProjectMemory ? readProjectMemoryIndex(project.path, { maxChars: 1_500 }) : null,
        workspaceDigest: shouldLoadProjectMemory ? buildWorkspaceDigest(project.path) : "",
        learnedConventions: shouldLoadProjectMemory ? readLearnedConventions(session.projectId) : "",
        turnPolicy,
        includeSessionSummary: !rehydrated && !shortFollowupContext,
        coldStart: Boolean(ensured.coldStart),
        shortFollowup: shortFollowupContext,
      });
      contextMemory.contextEpoch = Number(summary?.contextEpoch || 0);
      contextMemory.deduped = Boolean(
        contextMemory.fingerprint &&
        summary?.lastContextMemoryFingerprint === contextMemory.fingerprint &&
        !ensured.coldStart &&
        !rehydrated,
      );
      const platformContextParts = [];
      if (contextMemory.text && !contextMemory.deduped) platformContextParts.push(contextMemory.text);
      if (dependencyAdvisory?.text) platformContextParts.push(dependencyAdvisory.text);
      if (capabilityReadinessTrace?.status === "degraded") {
        const unavailable = capabilityReadinessTrace.unavailablePackIds || [];
        const failed = capabilityReadinessTrace.failedPackIds || [];
        const browserUnavailable = [...unavailable, ...failed].includes("web-automation");
        platformContextParts.push(browserUnavailable
          ? "Capability readiness: live browser evidence is unavailable for this turn. Continue once using static code inspection, state the evidence limitation, and do not claim browser verification."
          : `Capability readiness: optional task tooling could not be prepared (${[...unavailable, ...failed].slice(0, 5).join(", ")}). Continue once with the listed fallback capabilities and state any verification limitation.`);
      }
      try {
        if (shouldInjectCapabilityContext({ text: rawUserText, files, dependencyAdvisory, turnPolicy })) {
          const recommendedCapabilities = recommendSkillCapabilityGraph({
            text: rawUserText,
            files,
            dependencyAdvisory,
            turnPolicy,
            maxSkills: 8,
          });
          const capabilityContext = compactCapabilityContext({
            text: rawUserText,
            files,
            dependencyAdvisory,
            turnPolicy,
            maxChars: 1800,
          });
          capabilityContextTrace = {
            injected: Boolean(capabilityContext),
            recommendedSkillIds: recommendedCapabilities.map((skill) => skill.id),
            requiredRuntimePackIds: [...new Set(recommendedCapabilities.flatMap((skill) => skill.requiredRuntimePacks || []))],
          };
          if (capabilityContext) platformContextParts.push(capabilityContext);
        }
      } catch (err) {
        log.warn("capability context failed open: %s", err?.message || err);
        capabilityContextTrace = {
          injected: false,
          error: err?.message || String(err),
          recommendedSkillIds: [],
          requiredRuntimePackIds: [],
        };
      }
      // Matched procedure card: a previously proven tool path for a similar
      // request rides along as ADVISORY context — a weak model gets a working
      // plan instead of planning from scratch; a strong model gets a head
      // start it is free to ignore.
      try {
        const procedureContext = require("./procedure-cards").buildProcedureCardContext({
          projectId: session.projectId,
          text: rawUserText,
        });
        if (procedureContext) platformContextParts.push(procedureContext);
      } catch (err) {
        log.warn("procedure card context failed open: %s", err?.message || err);
      }
      if (platformContextParts.length) {
        engineText = addLayersToEngineText(engineText, {
          platformContext: platformContextParts.join("\n\n"),
        });
      }
    }
    let subagentIsolation = null;
    {
      const { buildSubagentIsolationHint } = require("./subagent-isolation-policy");
      const hint = buildSubagentIsolationHint({
        text: rawUserText,
        turnPolicy,
        taskContract,
      });
      if (hint) {
        const { addLayersToEngineText } = require("./engine-message-layers");
        engineText = addLayersToEngineText(engineText, {
          executionConstraints: hint,
        });
        subagentIsolation = {
          enabled: true,
          reason: turnPolicy.rigor === "coverage" || turnPolicy.requiresSourceCoverage
            ? "coverage_policy"
            : "broad_research_task",
        };
      }
    }
    engineText = withTaskContractPrefix(engineText, taskContract);
    state.enginePayload = {
      rawText: rawUserText,
      text: engineText,
      files,
      displayFiles,
      allowImageFileParts,
      taskContract: state.taskContract,
      turnPolicy: state.turnPolicy,
      trace: {
        preflightTextChanged: text !== rawUserText,
        customEngineText: preRehydrateText !== text,
        rehydrated,
        shortFollowupContext,
        subagentIsolation,
        dependencyAdvisory: dependencyAdvisory
          ? {
              injected: Boolean(dependencyAdvisory.text),
              requiredPackIds: dependencyAdvisory.requiredPackIds,
              missingPackIds: dependencyAdvisory.missingPackIds,
              installingPackIds: dependencyAdvisory.installingPackIds,
            }
          : null,
        capabilityReadiness: capabilityReadinessTrace,
        capabilityContext: capabilityContextTrace,
        contextMemory: contextMemory
          ? {
              injected: Boolean(contextMemory.text),
              items: contextMemory.items.map((item) => ({
                id: item.id,
                kind: item.kind,
                reason: item.reason,
                trust: item.trust || "unknown",
                proof: Boolean(item.proof),
                relevance: Number(item.relevance || 0),
                semanticRelevance: Number(item.semanticRelevance || 0),
                sourceVersion: item.sourceVersion || "",
                sourcePointers: Array.isArray(item.sourcePointers) ? item.sourcePointers.slice(0, 5) : [],
                size: item.size,
              })),
              skipped: (contextMemory.skipped || []).map((item) => ({
                id: item.id,
                kind: item.kind,
                reason: item.reason,
                skipReason: item.skipReason,
                relevance: Number(item.relevance || 0),
                sourceVersion: item.sourceVersion || "",
                sourcePointers: Array.isArray(item.sourcePointers) ? item.sourcePointers.slice(0, 5) : [],
                size: item.size,
              })),
              diagnostics: contextMemory.diagnostics || null,
              fingerprint: contextMemory.fingerprint || "",
              contextEpoch: contextMemory.contextEpoch,
              deduped: Boolean(contextMemory.deduped),
              totalChars: contextMemory.totalChars,
            }
          : null,
        taskContract: Boolean(state.taskContract),
      },
    };
    const preTurnCompaction = await this._maybeCompactBeforeTurn(session.id, runner, state.enginePayload);
    if (preTurnCompaction) state.enginePayload.trace.preTurnCompaction = preTurnCompaction;

    this._emit(session.id, "turn.started", {
      text: rawUserText,
      queueLength: state.queue.length,
      engine: {
        textChanged: engineText !== rawUserText,
        preflightTextChanged: text !== rawUserText,
        customEngineText: preRehydrateText !== text,
        rehydrated,
        shortFollowupContext,
        contextMemory: contextMemory
          ? {
              injected: Boolean(contextMemory.text),
              itemCount: contextMemory.items.length,
              skippedCount: contextMemory.skipped?.length || 0,
              diagnostics: contextMemory.diagnostics || null,
              fingerprint: contextMemory.fingerprint || "",
              contextEpoch: contextMemory.contextEpoch,
              deduped: Boolean(contextMemory.deduped),
              totalChars: contextMemory.totalChars,
            }
          : null,
        dependencyAdvisory: dependencyAdvisory
          ? {
              injected: Boolean(dependencyAdvisory.text),
              requiredPackIds: dependencyAdvisory.requiredPackIds,
              missingPackIds: dependencyAdvisory.missingPackIds,
              installingPackIds: dependencyAdvisory.installingPackIds,
            }
          : null,
        capabilityReadiness: capabilityReadinessTrace,
        capabilityContext: capabilityContextTrace
          ? {
              injected: capabilityContextTrace.injected,
              recommendedSkillIds: capabilityContextTrace.recommendedSkillIds,
              requiredRuntimePackIds: capabilityContextTrace.requiredRuntimePackIds,
              error: capabilityContextTrace.error || "",
            }
          : null,
        taskContract: Boolean(state.taskContract),
        preTurnCompaction,
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
      turnPolicy: state.turnPolicy
        ? {
            taskType: state.turnPolicy.taskType,
            rigor: state.turnPolicy.rigor,
            requiresFreshness: state.turnPolicy.requiresFreshness,
            requiresSourceCoverage: state.turnPolicy.requiresSourceCoverage,
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
      if (contextMemory?.fingerprint && contextMemory.text && !contextMemory.deduped) {
        const { markContextMemoryInjected } = require("./session-memory");
        const { explainContextMemory } = require("./memory-explain");
        const traceMemory = {
          injected: Boolean(contextMemory.text),
          items: contextMemory.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            reason: item.reason,
            trust: item.trust || "unknown",
            proof: Boolean(item.proof),
            relevance: Number(item.relevance || 0),
            sourceVersion: item.sourceVersion || "",
            sourcePointers: Array.isArray(item.sourcePointers) ? item.sourcePointers.slice(0, 5) : [],
            size: item.size,
          })),
          skipped: (contextMemory.skipped || []).map((item) => ({
            id: item.id,
            kind: item.kind,
            reason: item.reason,
            skipReason: item.skipReason,
            relevance: Number(item.relevance || 0),
            sourceVersion: item.sourceVersion || "",
            sourcePointers: Array.isArray(item.sourcePointers) ? item.sourcePointers.slice(0, 5) : [],
            size: item.size,
          })),
          contextEpoch: contextMemory.contextEpoch,
          deduped: Boolean(contextMemory.deduped),
        };
        markContextMemoryInjected(session.id, {
          fingerprint: contextMemory.fingerprint,
          itemCount: contextMemory.items.length,
          totalChars: contextMemory.totalChars,
          explanation: explainContextMemory(traceMemory),
        });
      }
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

  async _maybeCompactBeforeTurn(sessionId, runner, enginePayload = {}) {
    try {
      if (!runner?.compactContext) {
        return { action: "skip", reason: "adapter_missing_compaction" };
      }
      const { OPENCODE_RUNTIME_CAPABILITIES } = require("./runtime/runtime-capabilities");
      const { decidePreTurnCompaction, estimateTokensForText } = require("./context-budget-manager");
      const { markSessionCompactionFailed, readSessionSummary } = require("./session-memory");
      const sessionSummary = readSessionSummary(sessionId) || {};
      const model = runner.spawnOptions?.model || null;
      const promptEstimate = estimateTokensForText(String(enginePayload?.text || ""), {
        provider: model?.providerID || enginePayload?.provider || enginePayload?.trace?.provider || "",
        model: model?.modelID || enginePayload?.model || enginePayload?.trace?.model || "",
      });
      const decision = decidePreTurnCompaction({
        capabilities: OPENCODE_RUNTIME_CAPABILITIES,
        model,
        runner: {
          alive: Boolean(runner.isAlive?.()),
          canStart: true,
          busy: Boolean(runner.isBusy?.()),
        },
        sessionSummary,
        currentPromptTokens: promptEstimate.tokens,
        currentPromptTokenSource: promptEstimate.source,
        contextWindowTokens: model?.contextWindowTokens || undefined,
      });
      const event = {
        action: decision.action,
        reason: decision.reason,
        mode: decision.mode || null,
        phase: "pre_turn",
        turnCount: Number(sessionSummary.turnCount || 0),
        estimatedPromptTokens: decision.estimatedPromptTokens || 0,
        currentPromptTokens: decision.currentPromptTokens || promptEstimate.tokens || 0,
        previousPromptTokens: decision.previousPromptTokens || Number(
          sessionSummary.retainedContextTokens ?? sessionSummary.lastEnginePromptTokens ?? 0,
        ),
        contextWindowTokens: decision.contextWindowTokens || null,
        outputReserveTokens: decision.outputReserveTokens || null,
        usableInputTokens: decision.usableInputTokens || null,
        compactionTriggerTokens: decision.compactionTriggerTokens || null,
        tokenPressureThreshold: decision.tokenPressureThreshold || null,
        tokenSource: decision.tokenSource || promptEstimate.source || "",
        budgetSource: decision.budgetSource || "",
        providerID: decision.providerID || model?.providerID || "",
        modelID: decision.modelID || model?.modelID || "",
        unsupportedReason: decision.unsupportedReason || "",
      };
      this._emit(sessionId, "context.compactionDecision", event, { turnId: null });
      if (decision.action !== "compact") return event;

      const beforeFailureAt = sessionSummary.lastCompactionFailedAt || "";
      this._emit(sessionId, "engine.notice", {
        notice: {
          code: "compactBoundary",
          level: "progress",
          panel: true,
          done: false,
          detail: "Preparing to compact conversation context before this turn.",
        },
      }, { turnId: null });
      const compacted = await runner.compactContext({
        ...(model?.providerID && model?.modelID
          ? { providerID: model.providerID, modelID: model.modelID }
          : {}),
        auto: true,
        reason: decision.reason,
      });
      if (!compacted) {
        const afterSummary = readSessionSummary(sessionId) || {};
        if ((afterSummary.lastCompactionFailedAt || "") === beforeFailureAt) {
          markSessionCompactionFailed(sessionId, {
            runtime: "opencode",
            mode: "native",
            reason: decision.reason,
            providerID: model?.providerID || "",
            modelID: model?.modelID || "",
            code: "compact_returned_false",
            error: "Runtime compaction returned false.",
          });
        }
        this._emit(sessionId, "engine.notice", {
          notice: {
            code: "compactFailed",
            level: "info",
            panel: true,
            done: true,
            replace: true,
            replacesCode: "compactBoundary",
            detail: "Conversation memory maintenance was skipped after a runtime error. The current chat can continue.",
          },
        }, { turnId: null });
        return { ...event, compacted: false };
      }
      this._emit(sessionId, "engine.notice", {
        notice: {
          code: "compactBoundary",
          level: "info",
          panel: true,
          done: true,
          replace: true,
          detail: "Conversation context was compacted before this turn.",
        },
      }, { turnId: null });
      return { ...event, compacted: true };
    } catch (err) {
      log.warn(`pre-turn context compaction failed open: ${err?.message || String(err)}`);
      return {
        action: "skip",
        reason: "pre_turn_compaction_exception",
        error: err?.message || String(err),
      };
    }
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
    const blockingProcessJobs = interrupted || stalled || failed
      ? []
      : findBlockingRunningProcessJobs([...state.tools.values()]);
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
      const rawFailureText = collectFailureTextFromState(state) || normalized.text || payload?.error || payload?.message || friendly;
      const failedTurnId = state.turnId;
      this._finalize(sessionId, "turn.failed", {
        failed: true,
        assistant: failure.suppressIncompleteSummary ? friendly : appendIncompleteTurnSummary(friendly, state, payload),
        errorCode: failure.code,
        errorCategory: failure.category || "",
        retryable: failure.retryable !== false,
        source: payload?.source || "",
        exitCode: payload?.exitCode ?? null,
        ...terminalMeta,
      });
      void reportModelFailureDiagnostic(this.ctx, sessionId, {
        source: "terminal_failed",
        turnId: failedTurnId,
        raw: rawFailureText,
        classified: failure,
        payload: {
          source: payload?.source || "",
          exitCode: payload?.exitCode ?? null,
          engineMessageId: payload?.engineMessageId || null,
        },
      });
      void this._maybeSelfHealAndRetry(sessionId, failure);
    } else if (blockingProcessJobs.length) {
      const notice = runningProcessJobNotice(blockingProcessJobs);
      this._finalize(sessionId, "turn.stalled", {
        stalled: true,
        assistant: appendIncompleteTurnSummary(
          [normalized.text || state.assistantText, notice].filter(Boolean).join("\n\n"),
          state,
          { ...payload, blockingProcessJobs },
        ),
        blockingProcessJobs,
        ...terminalMeta,
      });
    } else {
      // Snapshot BEFORE finalize — the terminal cleanup nulls enginePayload.
      const procedureSnapshot = {
        rawText: String(state.enginePayload?.rawText || ""),
        tools: [...(state.tools?.values?.() || [])],
      };
      this._finalize(sessionId, "turn.completed", {
        assistant: normalized.text || state.assistantText,
        resultFromCli: Boolean(payload?.resultFromCli),
        ...terminalMeta,
      });
      // A completed multi-tool turn is a PROVEN path — distill it into a
      // procedure card (deterministic, no model call) so later requests with
      // the same intent start from a working plan instead of from scratch.
      void this._maybeRecordProcedureCard(sessionId, procedureSnapshot);
    }
    if (state.legacyContextHydrated && payload?.engineMessageId) {
      const runner = this.ctx.runnerPool?.get?.(sessionId);
      this.ctx.sessionManager?.markLegacyContextHydrated?.(
        sessionId,
        runner?.agentResumeId || null,
      );
    }
    this._afterTurnFinalized(sessionId);
  }

  /** Post-completion procedure-card distillation. Fail-open and async — the
   *  finished turn's UX can never be affected. The active model's capability
   *  grade gates AUTHORING (lite paths are not worth teaching from). */
  async _maybeRecordProcedureCard(sessionId, snapshot = {}) {
    try {
      const rawText = String(snapshot.rawText || "").trim();
      if (!rawText || !snapshot.tools?.length) return;
      const session = this.ctx.sessionManager.findById(sessionId);
      if (!session) return;
      let capabilityGrade = "";
      try {
        capabilityGrade = String(require("./spawn-env").resolveLilyEnv().LILY_MODEL_CAPABILITY_GRADE || "");
      } catch {
        capabilityGrade = "";
      }
      const card = require("./procedure-cards").recordProcedureCardFromTurn({
        projectId: session.projectId,
        userText: rawText,
        tools: snapshot.tools,
        capabilityGrade,
      });
      if (card) log.info(`procedure card recorded: project=${session.projectId} steps=${card.steps.length}`);
    } catch (err) {
      log.warn(`procedure card record failed open: ${err?.message || String(err)}`);
    }
  }

  async _handleError(sessionId, message) {
    const state = this._state(sessionId);
    if (!state.turnId || state.terminalEmitted) return;

    const raw = String(message || "");
    const classified = classifyAssistantError(raw);
    const text = classified?.message || sanitizeError(raw);
    void reportModelFailureDiagnostic(this.ctx, sessionId, {
      source: "runner_error",
      turnId: state.turnId,
      raw,
      classified,
    });
    this._finalize(sessionId, "turn.failed", {
      failed: true,
      assistant: text,
      errorCode: classified?.code || "ENGINE_ERROR",
      errorCategory: classified?.category || "",
      retryable: classified?.retryable !== false,
      error: raw,
    });
    void this._maybeSelfHealAndRetry(sessionId, classified);
    this._afterTurnFinalized(sessionId);
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
        log.warn("learned skill collection failed: %s", err?.message || err);
      }
    }
    closeStreamingBlocks(state, Date.now());
    let assistant = String(payload.assistant || state.assistantText || "").trim();
    const evidenceSummary = state.evidenceLedger?.summary?.() || null;
    let record = this.turnArchive?.buildRecord(state, type, { ...payload, assistant });
    let evidenceGateAssessment = null;
    if (type === "turn.completed" && state.taskContract?.evidencePolicy?.required) {
      const { assessFinalAnswerEvidence, appendEvidenceGateNotice } = require("./evidence-gate");
      const assessment = assessFinalAnswerEvidence({
        assistant,
        evidencePolicy: state.taskContract.evidencePolicy,
        turnPolicy: state.turnPolicy,
        evidenceSummary,
        toolCount: state.tools?.size || 0,
        fileChangeCount: record?.fileChanges?.length || 0,
      });
      evidenceGateAssessment = assessment;
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
    this._completeTaskRun(sessionId, type, {
      evidenceGateAssessment,
      evidenceSummary,
    });
    if (record && state.taskRun) {
      record.meta = {
        ...(record.meta || {}),
        taskRun: compactTaskRun(state.taskRun),
      };
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
    // The committed assistant message's backend id (msg_…). The renderer needs it
    // so the scheduled-task "create" button can call back with a messageId the
    // backend can find; without it the committed message has no id and the button
    // silently no-ops.
    let committedMessageId = "";
    if (record) {
      if (assistant) {
        this._emit(sessionId, "assistant.final", {
          assistant,
          failed: type === "turn.failed",
          ...(payload.scheduledDraft ? { scheduledDraft: payload.scheduledDraft } : {}),
        });
      }
      try {
        const committed = this.turnArchive.commit(sessionId, record);
        committedMessageId = committed?.id || "";
      } catch (err) { log.warn("turn archive commit failed: %s", err?.message || err); }
    }
    state.terminalEmitted = true;
    this._emit(sessionId, type, {
      ...payload,
      assistant,
      record,
      messageId: committedMessageId,
      toolsSummary: { count: state.tools.size },
    });
    if (scheduledTaskRunId) {
      try { this.ctx.scheduledTaskManager?.completeRun?.(sessionId, completedTurnId, type, payload); } catch (err) { log.warn("scheduled task completeRun failed: %s", err?.message || err); }
    }
    for (const toolId of [...(state.subagentTimers?.keys?.() || [])]) {
      this._clearSubagentWatch(sessionId, toolId);
    }
    state.phase = "idle";
    state.turnId = null;
    state.steerCount = 0;
    state.admittedSeq = null;
    state.assistantText = "";
    state.thinkingText = "";
    state.contentBlocks = [];
    state.protocolUnknown = [];
    state.processEvents = [];
    state.notices = [];
    state.usage = null;
    state.lastStopReason = "";
    state.sawRecognizedStopReason = false;
    state.taskContract = null;
    state.turnPolicy = null;
    state.evidenceLedger = null;
    state.taskRun = null;
    state.enginePayload = null;
    resetTimelineState(state);
    state.blockIndexToToolId = new Map();
    state.currentPayload = null;
    state.scheduledTask = null;
    state.pendingPermissions.clear();
    state.pendingQuestions.clear();
    state.pendingHooks.clear();
    if (type === "turn.completed") this._scheduleBackgroundCompaction(sessionId);
  }

  _scheduleBackgroundCompaction(sessionId) {
    const timer = setTimeout(async () => {
      try {
        const runner = this.ctx.runnerPool?.get?.(sessionId);
        if (!runner?.compactContext) {
          this._emit(sessionId, "context.compactionDecision", {
            action: "skip",
            reason: "adapter_missing_compaction",
          }, { turnId: null });
          return;
        }
        const { OPENCODE_RUNTIME_CAPABILITIES } = require("./runtime/runtime-capabilities");
        const { decideBackgroundCompaction } = require("./context-budget-manager");
        const { markSessionCompactionFailed, readSessionSummary } = require("./session-memory");
        const sessionSummary = readSessionSummary(sessionId) || {};
        const model = runner.spawnOptions?.model || null;
        const decision = decideBackgroundCompaction({
          capabilities: OPENCODE_RUNTIME_CAPABILITIES,
          model,
          runner: {
            alive: Boolean(runner.isAlive?.()),
            busy: Boolean(runner.isBusy?.()),
          },
          sessionSummary,
          contextWindowTokens: model?.contextWindowTokens || undefined,
        });
        this._emit(sessionId, "context.compactionDecision", {
          action: decision.action,
          reason: decision.reason,
          mode: decision.mode || null,
          turnCount: Number(sessionSummary.turnCount || 0),
          lastCompactedAt: sessionSummary.lastCompactedAt || null,
          lastCompactionFailedAt: sessionSummary.lastCompactionFailedAt || null,
          estimatedPromptTokens: decision.estimatedPromptTokens || Number(
            sessionSummary.retainedContextTokens ?? sessionSummary.lastEnginePromptTokens ?? 0,
          ),
          contextWindowTokens: decision.contextWindowTokens || null,
          outputReserveTokens: decision.outputReserveTokens || null,
          usableInputTokens: decision.usableInputTokens || null,
          compactionTriggerTokens: decision.compactionTriggerTokens || null,
          tokenPressureThreshold: decision.tokenPressureThreshold || null,
          tokenSource: decision.tokenSource || sessionSummary.retainedContextTokenSource || sessionSummary.lastEnginePromptTokenSource || "",
          budgetSource: decision.budgetSource || "",
          providerID: decision.providerID || model?.providerID || "",
          modelID: decision.modelID || model?.modelID || "",
          unsupportedReason: decision.unsupportedReason || "",
        }, { turnId: null });
        if (decision.action !== "compact") return;
        const beforeFailureAt = sessionSummary.lastCompactionFailedAt || "";
        this._emit(sessionId, "engine.notice", {
          notice: {
            code: "compactBoundary",
            level: "progress",
            panel: true,
            done: false,
            detail: "Preparing to compact conversation context.",
          },
        }, { turnId: null });
        const compacted = await runner.compactContext({
          ...(model?.providerID && model?.modelID
            ? { providerID: model.providerID, modelID: model.modelID }
            : {}),
          auto: true,
          reason: decision.reason,
        });
        if (!compacted) {
          const afterSummary = readSessionSummary(sessionId) || {};
          if ((afterSummary.lastCompactionFailedAt || "") === beforeFailureAt) {
            markSessionCompactionFailed(sessionId, {
              runtime: "opencode",
              mode: "native",
              reason: decision.reason,
              providerID: model?.providerID || "",
              modelID: model?.modelID || "",
              code: "compact_returned_false",
              error: "Runtime compaction returned false.",
            });
          }
          this._emit(sessionId, "engine.notice", {
            notice: {
              code: "compactFailed",
              level: "info",
              panel: true,
              done: true,
              replace: true,
              replacesCode: "compactBoundary",
              detail: "Conversation memory maintenance was skipped after a runtime error. The current chat can continue.",
            },
          }, { turnId: null });
        }
      } catch (err) {
        log.warn(`background context compaction failed: ${err?.message || String(err)}`);
        try {
          require("./session-memory").markSessionCompactionFailed(sessionId, {
            runtime: "opencode",
            mode: "native",
            reason: "background_compaction_exception",
            code: err?.name || "exception",
            error: err?.message || String(err),
          });
        } catch (memoryErr) {
          log.warn(`background compaction failure memory update failed: ${memoryErr?.message || String(memoryErr)}`);
        }
        this._emit(sessionId, "engine.notice", {
          notice: {
            code: "compactFailed",
            level: "info",
            panel: true,
            done: true,
            replace: true,
            replacesCode: "compactBoundary",
            detail: "Conversation memory maintenance was skipped after a runtime error. The current chat can continue.",
          },
        }, { turnId: null });
      }
    }, 0);
    timer.unref?.();
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
        this._completeQueuedScheduledRun(next, "turn.failed", {
          errorCode: result?.error || "QUEUE_DISPATCH_FAILED",
          error: result?.detail || result?.error || "Queued turn failed to start.",
        });
        this._emitQueue(sessionId);
        if (state.phase === "idle" && state.queue.length > 0) {
          void this._dispatchNext(sessionId);
        }
        return;
      }
      state.queue.shift();
      this._emitQueue(sessionId);
      if (state.phase === "idle" && state.queue.length > 0) {
        void this._dispatchNext(sessionId);
      }
    } catch (err) {
      log.warn("_dispatchNext error: %s", err?.message || err);
      state.queue.shift();
      this._completeQueuedScheduledRun(next, "turn.failed", {
        errorCode: err?.name || "QUEUE_DISPATCH_EXCEPTION",
        error: err?.message || String(err),
      });
      this._emitQueue(sessionId);
      if (state.phase === "idle" && state.queue.length > 0) {
        void this._dispatchNext(sessionId);
      }
    }
  }

  _afterTurnFinalized(sessionId) {
    // Queue progression is part of the turn boundary. Usage reporting is
    // telemetry and may hit disk or network, so it must never delay the next
    // user-visible turn.
    void this._dispatchNext(sessionId);
    void this._flushUsage(sessionId);
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

  _completeQueuedScheduledRun(item, terminalType, payload = {}) {
    const runId = item?.options?.scheduledTaskRunId || null;
    if (!runId) return;
    try {
      this.ctx.scheduledTaskManager?.completeQueuedRun?.(runId, terminalType, payload);
    } catch (err) {
      log.warn("scheduled queued run completion failed: %s", err?.message || err);
    }
  }

  _emitQueue(sessionId) {
    const state = this._state(sessionId);
    this._emit(sessionId, "queue.updated", {
      items: state.queue.map((item) => compactQueueItem(item)),
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

  _scheduleSubagentWatch(sessionId, toolId, tool = {}) {
    const { isSubagentTool, SLOW_SUBAGENT_MS, VERY_SLOW_SUBAGENT_MS, subagentTitle } = require("./subagent-telemetry");
    if (!isSubagentTool(tool)) return;
    const state = this._state(sessionId);
    if (!state.subagentTimers) state.subagentTimers = new Map();
    this._clearSubagentWatch(sessionId, toolId);
    const timers = [];
    const title = subagentTitle(tool);
    for (const [ms, code] of [[SLOW_SUBAGENT_MS, "subagentSlow"], [VERY_SLOW_SUBAGENT_MS, "subagentVerySlow"]]) {
      const timer = setTimeout(() => {
        const current = this._state(sessionId).tools.get(toolId);
        if (!current || current.status !== "running") return;
        this._emitEngineNotice(sessionId, {
          code,
          level: "progress",
          panel: true,
          replace: true,
          replacesCode: `subagent:${toolId}`,
          detail: `子任务仍在运行：${title}（已 ${Math.round(ms / 1000)} 秒）。正在等待 Lily 子任务回传结果。`,
        });
      }, ms);
      timer.unref?.();
      timers.push(timer);
    }
    state.subagentTimers.set(toolId, timers);
  }

  _clearSubagentWatch(sessionId, toolId) {
    const state = this._state(sessionId);
    const timers = state.subagentTimers?.get(toolId) || [];
    for (const timer of timers) clearTimeout(timer);
    state.subagentTimers?.delete(toolId);
  }

  _emitSubagentDoneNotice(sessionId, tool = {}) {
    const { isSubagentTool, SLOW_SUBAGENT_MS, subagentTitle } = require("./subagent-telemetry");
    if (!isSubagentTool(tool)) return;
    const durationMs = Number(tool.durationMs || 0);
    if (durationMs < SLOW_SUBAGENT_MS) return;
    const seconds = Math.max(1, Math.round(durationMs / 1000));
    this._emitEngineNotice(sessionId, {
      code: "subagentCompleted",
      level: "progress",
      panel: true,
      replace: true,
      replacesCode: `subagent:${tool.id}`,
      done: true,
      detail: `子任务完成：${subagentTitle(tool)}（${seconds} 秒）。`,
    });
  }

  _syncSubagentFromTool(sessionId, tool = {}) {
    const { isSubagentTool, subagentTitle } = require("./subagent-telemetry");
    if (!isSubagentTool(tool)) return null;
    const meta = tool.metadata || {};
    const childSessionId = meta.sessionId || meta.sessionID || "";
    if (!childSessionId) return null;
    const state = this._state(sessionId);
    if (!state.subagents) state.subagents = new Map();
    const current = state.subagents.get(childSessionId) || {
      sessionId: childSessionId,
      parentToolId: tool.id || "",
      label: String(tool.input?.subagent_type || tool.input?.subagentType || "general"),
      description: subagentTitle(tool),
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      tools: new Map(),
      textPreview: "",
      thinkingPreview: "",
      textFull: "",
      thinkingFull: "",
      metadata: {},
      pendingPermissions: [],
      pendingQuestions: [],
      phase: "starting",
      phaseDetail: "",
      stats: {},
    };
    current.parentToolId = tool.id || current.parentToolId || "";
    current.label = String(tool.input?.subagent_type || tool.input?.subagentType || current.label || "general");
    current.description = subagentTitle(tool) || current.description || "";
    current.status = tool.status === "failed" ? "failed" : (tool.status === "done" || tool.status === "completed") ? "done" : "running";
    current.metadata = { ...(current.metadata || {}), ...meta };
    current.updatedAt = Date.now();
    this._refreshSubagentPhase(current);
    state.subagents.set(childSessionId, current);
    return current;
  }

  _compactSubagent(item = {}) {
    this._refreshSubagentPhase(item);
    return {
      sessionId: item.sessionId || "",
      parentToolId: item.parentToolId || "",
      label: item.label || "general",
      description: item.description || "",
      status: item.status || "running",
      startedAt: item.startedAt || 0,
      updatedAt: item.updatedAt || 0,
      metadata: item.metadata || {},
      currentToolId: item.currentToolId || "",
      tools: [...(item.tools?.values?.() || [])].slice(-20),
      textPreview: item.textPreview || "",
      thinkingPreview: item.thinkingPreview || "",
      textFull: item.textFull || "",
      pendingPermissions: item.pendingPermissions || [],
      pendingQuestions: item.pendingQuestions || [],
      phase: item.phase || "starting",
      phaseDetail: item.phaseDetail || "",
      stats: item.stats || {},
      ...(item.lastError ? { lastError: item.lastError } : {}),
    };
  }

  _beginTaskRun(sessionId, objective, opts = {}) {
    try {
      const state = this._state(sessionId);
      if (state.taskRun) return state.taskRun;
      if (!state.turnId) return null;
      state.taskRun = createTaskRun({
        sessionId,
        turnId: state.turnId,
        objective,
        startedAt: state.startedAt || Date.now(),
      });
      if (opts.scheduledTask) {
        state.taskRun.resumeState = {
          ...(state.taskRun.resumeState || {}),
          scheduledTaskId: opts.scheduledTask.id || "",
          scheduledTaskRunId: opts.scheduledTask.runId || "",
        };
      }
      if (opts.localAssistant) {
        markTaskPhase(state.taskRun, "local_assistant", "Preparing local assistant response");
      }
      this._emitTaskEvent(sessionId, "task.created", {
        taskRun: compactTaskRun(state.taskRun),
      });
      this._emitTaskEvent(sessionId, "task.plan.updated", {
        taskRunId: state.taskRun.id,
        plan: state.taskRun.plan,
        activeStep: state.taskRun.activeStep,
      });
      return state.taskRun;
    } catch (err) {
      log.warn("TaskRun begin failed: %s", err?.message || err);
      return null;
    }
  }

  _shouldBeginTaskRunAtTurnStart({ taskContract = null, turnPolicy = null, scheduledTask = null } = {}) {
    if (scheduledTask?.runId) return true;
    if (taskContract?.active) return true;
    return Boolean(turnPolicy && turnPolicy.rigor && turnPolicy.rigor !== "fast");
  }

  _ensureTaskRun(sessionId, reason = "runtime_event") {
    try {
      const state = this._state(sessionId);
      if (state.taskRun) return state.taskRun;
      if (!state.turnId) return null;
      const payload = state.currentPayload || {};
      const taskRun = this._beginTaskRun(sessionId, payload.rawText || payload.text || "", {
        displayFiles: payload.displayFiles || [],
        scheduledTask: state.scheduledTask || null,
      });
      if (taskRun) {
        taskRun.resumeState = {
          ...(taskRun.resumeState || {}),
          createdBy: reason,
        };
      }
      return taskRun;
    } catch (err) {
      log.warn("TaskRun ensure failed: %s", err?.message || err);
      return null;
    }
  }

  _markTaskProgress(sessionId, phase, label, opts = {}) {
    try {
      const state = this._state(sessionId);
      if (!state.taskRun) this._ensureTaskRun(sessionId, "tool_or_progress");
      if (!state.taskRun) return null;
      if (opts.tool) noteTaskToolUse(state.taskRun, opts.tool);
      markTaskPhase(state.taskRun, phase, label, {
        resumeState: opts.resumeState || null,
      });
      this._emitTaskEvent(sessionId, "task.step.progress", {
        taskRunId: state.taskRun.id,
        phase: state.taskRun.phase,
        activeStep: state.taskRun.activeStep,
        progress: state.taskRun.progress,
        tool: opts.tool
          ? {
              id: opts.tool.id || "",
              name: opts.tool.name || "unknown",
              status: opts.tool.status || "",
              title: opts.tool.title || "",
            }
          : null,
        taskRun: compactTaskRun(state.taskRun),
      });
      return state.taskRun;
    } catch (err) {
      log.warn("TaskRun progress failed: %s", err?.message || err);
      return null;
    }
  }

  _markTaskAwaitingUser(sessionId, code, message) {
    try {
      const state = this._state(sessionId);
      if (!state.taskRun) this._ensureTaskRun(sessionId, "awaiting_user");
      if (!state.taskRun) return null;
      markTaskPhase(state.taskRun, "awaiting_user", message, { status: "awaiting_user" });
      const risk = addTaskRisk(state.taskRun, {
        code,
        level: "info",
        message,
      });
      this._emitTaskEvent(sessionId, "task.risk.detected", {
        taskRunId: state.taskRun.id,
        risk,
        taskRun: compactTaskRun(state.taskRun),
      });
      return risk;
    } catch (err) {
      log.warn("TaskRun awaiting-user mark failed: %s", err?.message || err);
      return null;
    }
  }

  _addTaskEvidence(sessionId, evidence, opts = {}) {
    try {
      const state = this._state(sessionId);
      if (!state.taskRun && opts.tool) this._ensureTaskRun(sessionId, "tool_evidence");
      if (!state.taskRun) return null;
      const item = addTaskEvidence(state.taskRun, evidence);
      this._emitTaskEvent(sessionId, "task.evidence.added", {
        taskRunId: state.taskRun.id,
        evidence: item,
        tool: opts.tool
          ? {
              id: opts.tool.id || "",
              name: opts.tool.name || "unknown",
              status: opts.tool.status || "",
              title: opts.tool.title || "",
            }
          : null,
        taskRun: compactTaskRun(state.taskRun),
      });
      return item;
    } catch (err) {
      log.warn("TaskRun evidence failed: %s", err?.message || err);
      return null;
    }
  }

  _updateTaskPlanFromTodos(sessionId, todos = []) {
    try {
      const state = this._state(sessionId);
      if (!state.taskRun) this._ensureTaskRun(sessionId, "todo_updated");
      if (!state.taskRun) return null;
      const before = JSON.stringify(state.taskRun.plan || []);
      applyTaskPlanFromTodos(state.taskRun, todos);
      const after = JSON.stringify(state.taskRun.plan || []);
      if (after === before) return state.taskRun;
      this._emitTaskEvent(sessionId, "task.plan.updated", {
        taskRunId: state.taskRun.id,
        plan: state.taskRun.plan,
        activeStep: state.taskRun.activeStep,
        taskRun: compactTaskRun(state.taskRun),
      });
      return state.taskRun;
    } catch (err) {
      log.warn("TaskRun plan fusion failed: %s", err?.message || err);
      return null;
    }
  }

  _updateTaskLivenessFromNotice(sessionId, notice = {}, eventType = "engine.notice") {
    try {
      const state = this._state(sessionId);
      if (!notice) return null;
      const code = String(notice.code || "").trim();
      const detail = String(notice.detail || notice.message || "").trim();
      let status = "runtime_notice";
      let phase = "";
      let countsAsActivity = false;
      if (code === "longWait" || code === "waitingForFirstResponse") {
        status = "no_visible_progress";
        phase = "waiting";
      } else if (code === "toolProgress" || code === "shellLongRunning") {
        status = "tool_running";
        phase = "tool_running";
      } else if (code === "workProgress") {
        status = "work_running";
        phase = "work_running";
        countsAsActivity = true;
      } else if (eventType === "engine.warning" || notice.level === "warning") {
        status = "warning";
      } else if (notice.level === "progress") {
        status = "running";
      }
      if (!state.taskRun) return null;
      const ts = Date.now();
      const livenessSig = `${status}\0${code}\0${detail}`;
      const previousLiveness = state.taskRun._lastLivenessEmit || null;
      if (
        previousLiveness?.sig === livenessSig &&
        Number.isFinite(previousLiveness.ts) &&
        ts - previousLiveness.ts < 750
      ) {
        return state.taskRun.liveness || null;
      }
      state.taskRun._lastLivenessEmit = { sig: livenessSig, ts };
      const liveness = updateTaskLiveness(state.taskRun, {
        status,
        detail,
        noticeCode: code,
        countsAsActivity,
      });
      if (phase && detail) {
        const progressValue = progressValueFromNotice(notice);
        state.taskRun.phase = phase;
        state.taskRun.progress = {
          label: detail,
          value: progressValue,
        };
        state.taskRun.resumeState = {
          ...(state.taskRun.resumeState || {}),
          lastLivenessCode: code,
        };
      }
      this._emitTaskEvent(sessionId, "task.liveness.updated", {
        taskRunId: state.taskRun.id,
        liveness,
        notice: {
          code,
          level: notice.level || "",
          detail,
          progress: notice.progress && typeof notice.progress === "object" ? notice.progress : null,
        },
        taskRun: compactTaskRun(state.taskRun),
      });
      if (status === "no_visible_progress") {
        const risk = addTaskRisk(state.taskRun, {
          code: "NO_VISIBLE_PROGRESS",
          level: "info",
          message: detail || "NO_VISIBLE_PROGRESS",
        });
        this._emitTaskEvent(sessionId, "task.risk.detected", {
          taskRunId: state.taskRun.id,
          risk,
          taskRun: compactTaskRun(state.taskRun),
        });
      } else if (status === "warning") {
        const risk = addTaskRisk(state.taskRun, {
          code: code || "ENGINE_WARNING",
          level: "warning",
          message: detail || code || "ENGINE_WARNING",
        });
        this._emitTaskEvent(sessionId, "task.risk.detected", {
          taskRunId: state.taskRun.id,
          risk,
          taskRun: compactTaskRun(state.taskRun),
        });
      }
      return liveness;
    } catch (err) {
      log.warn("TaskRun liveness update failed: %s", err?.message || err);
      return null;
    }
  }

  _completeTaskRun(sessionId, terminalType, opts = {}) {
    try {
      const state = this._state(sessionId);
      if (!state.taskRun) return null;
      const verification = terminalType === "turn.completed"
        ? assessTaskVerification({
            taskType: state.turnPolicy?.taskType || state.taskContract?.taskType || "",
            evidence: state.taskRun.evidence || [],
            evidenceGateAssessment: opts.evidenceGateAssessment || null,
          })
        : { status: "not_verified", reason: "" };
      completeTaskRun(state.taskRun, terminalType, verification);
      const eventType = terminalType === "turn.failed"
        ? "task.failed"
        : terminalType === "turn.interrupted"
          ? "task.interrupted"
          : terminalType === "turn.stalled"
            ? "task.stalled"
            : "task.completed";
      this._emitTaskEvent(sessionId, eventType, {
        taskRunId: state.taskRun.id,
        status: state.taskRun.status,
        verification: state.taskRun.verification,
        evidenceSummary: opts.evidenceSummary || null,
        taskRun: compactTaskRun(state.taskRun),
      });
      return state.taskRun;
    } catch (err) {
      log.warn("TaskRun completion failed: %s", err?.message || err);
      return null;
    }
  }

  _emitTaskEvent(sessionId, type, payload = {}) {
    try {
      const state = this._state(sessionId);
      if (!state.turnId) return null;
      return this.eventBus.emit(sessionId, {
        type,
        turnId: state.turnId,
        source: "task-run",
        payload,
      })[0] || null;
    } catch (err) {
      log.warn("TaskRun event dropped (%s): %s", type, err?.message || err);
      return null;
    }
  }

  _applySubagentEvent(sessionId, payload = {}) {
    const childSessionId = String(payload.sessionId || "").trim();
    if (!childSessionId) return null;
    const state = this._state(sessionId);
    if (!state.subagents) state.subagents = new Map();
    const item = state.subagents.get(childSessionId) || {
      sessionId: childSessionId,
      parentToolId: "",
      label: "general",
      description: "",
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      tools: new Map(),
      textPreview: "",
      thinkingPreview: "",
      textFull: "",
      thinkingFull: "",
      metadata: {},
      pendingPermissions: [],
      pendingQuestions: [],
      phase: "starting",
      phaseDetail: "",
      stats: {},
    };
    for (const event of payload.events || []) {
      if (event.kind === "tool") {
        const id = event.id || `tool_${item.tools.size + 1}`;
        const existing = item.tools.get(id) || { id, startedAt: event.ts || Date.now() };
        const next = {
          ...existing,
          id,
          name: event.name || existing.name || "unknown",
          status: event.status || existing.status || "running",
          input: event.input || existing.input || {},
          result: event.result ?? existing.result ?? null,
          metadata: event.metadata || existing.metadata || {},
          title: event.title || existing.title || "",
          updatedAt: event.ts || Date.now(),
        };
        item.tools.set(id, next);
        item.currentToolId = id;
        item.status = next.status === "failed" ? "failed" : item.status === "done" ? "done" : "running";
      } else if (event.kind === "text") {
        item.textPreview = `${item.textPreview || ""}${event.text || ""}`.slice(-600);
        item.textFull = `${item.textFull || ""}${event.text || ""}`.slice(-8_000);
      } else if (event.kind === "thinking") {
        item.thinkingPreview = `${item.thinkingPreview || ""}${event.text || ""}`.slice(-300);
        item.thinkingFull = `${item.thinkingFull || ""}${event.text || ""}`.slice(-4_000);
      } else if (event.kind === "usage") {
        item.usage = event.usage || {};
      } else if (event.kind === "permission") {
        const requestId = event.requestId || event.rawRequestId || "";
        item.pendingPermissions = Array.isArray(item.pendingPermissions) ? item.pendingPermissions : [];
        if (event.status === "requested" && requestId && !item.pendingPermissions.some((p) => p.requestId === requestId)) {
          item.pendingPermissions.push({
            requestId,
            rawRequestId: event.rawRequestId || "",
            toolName: event.toolName || "",
            status: event.status,
            ts: event.ts || Date.now(),
          });
        } else if (requestId && event.status !== "requested") {
          item.pendingPermissions = item.pendingPermissions.filter((p) => p.requestId !== requestId && p.rawRequestId !== requestId);
        }
      } else if (event.kind === "question") {
        const requestId = event.requestId || event.rawRequestId || "";
        item.pendingQuestions = Array.isArray(item.pendingQuestions) ? item.pendingQuestions : [];
        if (event.status === "requested" && requestId && !item.pendingQuestions.some((q) => q.requestId === requestId)) {
          item.pendingQuestions.push({
            requestId,
            rawRequestId: event.rawRequestId || "",
            status: event.status,
            ts: event.ts || Date.now(),
          });
        } else if (requestId && event.status !== "requested") {
          item.pendingQuestions = item.pendingQuestions.filter((q) => q.requestId !== requestId && q.rawRequestId !== requestId);
        }
      } else if (event.kind === "error") {
        item.status = "failed";
        item.lastError = {
          message: String(event.message || "").slice(0, 500),
          ts: event.ts || Date.now(),
        };
        this._noteSubagentEngineError(sessionId, childSessionId, item.lastError.message);
      }
      item.updatedAt = event.ts || Date.now();
    }
    this._refreshSubagentPhase(item);
    state.subagents.set(childSessionId, item);
    return { subagent: this._compactSubagent(item) };
  }

  /** A subagent's ENGINE died (model/gateway failure inside the child session).
   *  This signal used to be dropped entirely — the parent only saw a generic
   *  "Task failed". Feed it to the SAME learning loops the parent turn already
   *  has: timeline notice (visibility), model-failure diagnostics (telemetry),
   *  and background self-heal for healable signatures (the platform repairs the
   *  compatibility profile so the NEXT subtask works). Observe-only: the running
   *  turn is never interrupted or retried from here; every path fails open. */
  _noteSubagentEngineError(sessionId, childSessionId, message) {
    try {
      const state = this._state(sessionId);
      const compact = String(message || "").replace(/\s+/g, " ").trim().slice(0, 260);
      log.warn(`subagent engine error: session=${sessionId} child=${childSessionId} msg=${compact.slice(0, 200)}`);
      this._emitEngineNotice(sessionId, {
        code: "subagentEngineError",
        level: "warning",
        detail: compact,
        replacesCode: `subagentEngineError:${childSessionId}`,
      });
      const classified = classifyAssistantError(message);
      void reportModelFailureDiagnostic(this.ctx, sessionId, {
        source: "subagent_engine_error",
        turnId: state.turnId,
        raw: message,
        classified,
        payload: { childSessionId },
      });
      const { attemptModelSelfHeal, isHealableFailureCode } = require("./model-self-heal");
      if (classified?.code && isHealableFailureCode(classified.code)) {
        void attemptModelSelfHeal({
          code: classified.code,
          systemPromptProbeText: this._selfHealProbeText(sessionId),
        });
      }
    } catch (err) {
      log.warn(`subagent engine error handling failed open: ${err?.message || String(err)}`);
    }
  }

  _refreshSubagentPhase(item = {}) {
    const tools = [...(item.tools?.values?.() || [])];
    const runningTools = tools.filter((tool) => {
      const status = String(tool.status || "");
      return status === "running" || status === "pending";
    });
    const failedTools = tools.filter((tool) => String(tool.status || "") === "failed");
    const doneTools = tools.filter((tool) => ["done", "completed"].includes(String(tool.status || "")));
    const nestedTasks = tools.filter((tool) => String(tool.name || "").toLowerCase() === "task");
    const pending = (item.pendingPermissions?.length || 0) + (item.pendingQuestions?.length || 0);
    const current =
      runningTools.find((tool) => tool.id === item.currentToolId) ||
      runningTools.at(-1) ||
      tools.find((tool) => tool.id === item.currentToolId) ||
      tools.at(-1) ||
      null;
    item.stats = {
      totalTools: tools.length,
      runningTools: runningTools.length,
      doneTools: doneTools.length,
      failedTools: failedTools.length,
      nestedTasks: nestedTasks.length,
      pendingPrompts: pending,
    };
    item.phaseDetail = this._subagentPhaseDetail(current);
    if (item.status === "failed" || failedTools.length) item.phase = "failed";
    else if (item.status === "done" || item.status === "completed") item.phase = "done";
    else if (pending > 0) item.phase = "awaiting_user";
    else if (current && String(current.name || "").toLowerCase() === "task" && ["running", "pending"].includes(String(current.status || ""))) item.phase = "delegating";
    else if (current && ["running", "pending"].includes(String(current.status || ""))) item.phase = this._subagentToolPhase(current.name);
    else if (String(item.textPreview || "").trim()) item.phase = "summarizing";
    else if (String(item.thinkingPreview || "").trim()) item.phase = "planning";
    else item.phase = "starting";
    return item;
  }

  _subagentToolPhase(name) {
    const tool = String(name || "").toLowerCase();
    if (["read", "grep", "glob", "list", "ls"].includes(tool)) return "searching";
    if (tool === "bash") return "running_command";
    if (["edit", "write", "patch", "multiedit"].includes(tool)) return "editing";
    if (tool.includes("web")) return "researching";
    return "using_tool";
  }

  _subagentPhaseDetail(tool = null) {
    if (!tool) return "";
    const input = tool.input || {};
    return String(
      input.file_path ||
      input.path ||
      input.pattern ||
      input.query ||
      input.command ||
      input.description ||
      input.prompt ||
      tool.title ||
      tool.name ||
      "",
    ).trim().slice(0, 180);
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

  _hasPendingUserBlocks(state = {}) {
    return Boolean(
      state.pendingPermissions?.size ||
      state.pendingQuestions?.size ||
      state.pendingHooks?.size,
    );
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
        turnPolicy: null,
        evidenceLedger: null,
        taskRun: null,
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
        subagentTimers: new Map(),
        subagents: new Map(),
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

module.exports = { TurnOrchestrator, prepareTurnCapabilityReadiness };
