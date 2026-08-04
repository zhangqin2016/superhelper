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
  appendTimelineNotice,
  resetTimelineState,
  setActivityLabel,
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
const { withTaskContractPrefix } = require("./task-contract");
const { applyInternalRecoveryLayer, initializeTurnEvidenceState } = require("./turn-recovery-context");
const { applyDocumentDeliveryTurnState, documentDeliveryDispatchOptions, documentDeliveryTurnIntelligence } = require("./document-delivery-turn");
const {
  compactCapabilityContext,
  recommendSkillCapabilityGraph,
  shouldInjectCapabilityContext,
} = require("./capability-broker");
const { PROJECT_ROOT } = require("./config");
const { TurnRunCoordinator } = require("./turn-run-coordinator");
const { compactTaskRun } = require("./task-run-state");
const { resolveTurnIntelligence } = require("./turn-intelligence");
const {
  buildDependencyAdvisoryForTurn,
  prepareTurnCapabilityReadiness,
} = require("./turn-capability-readiness");
const {
  findBlockingRunningProcessJobs,
  runningProcessJobNotice,
} = require("./process-job-turn-guard");
const { createSubagentRuntimeProjection } = require("./subagent-runtime-projection");
const {
  createTaskRunRuntime,
  shouldBeginTaskRunAtTurnStart,
} = require("./task-run-runtime");
const { createExternalCommandRuntime } = require("./external-command-runtime");
const { createTurnRecoveryRuntime, modelRecipes, selfHealProbeText } = require("./turn-recovery-runtime");
const { createContextCompactionRuntime } = require("./context-compaction-runtime");
const { createTurnTerminalFinalizer } = require("./turn-terminal-finalizer");
const { emitRuntimePackProgress } = require("./turn-progress-notices");
const { isCurrentTurnStart, startCancellationResult } = require("./turn-start-guard");
const { TERMINAL_TYPES, TURN_OPTIONAL_TYPES } = require("./turn-event-types");
const { createTurnRuntimeEventRouter } = require("./turn-runtime-event-router");
const { cancelQueuedScheduledRun, scheduledQueueCapacityBlock, scheduledTaskTurnOptions } = require("./scheduled-task-turn-options");
const {
  snapshotFromMetadata,
} = require("./character-worlds/turn-binding-snapshot");
const { createCharacterWorldsRuntime } = require("./character-worlds/turn-runtime-adapter");
const { compileTurnContext } = require("./character-worlds/compile-turn-context");
const { normalizeRequiredTools } = require("./required-tool-completion");
const log = getLogger("turn-orchestrator");
const MANAGED_MODEL_CONFIG_SEND_TIMEOUT_MS = 90_000;
const RUNTIME_DIAGNOSTIC_TEXT_LIMIT = 4000;
function newTurnId() {
  return `turn_${crypto.randomUUID()}`;
}
function newQueueId() {
  return `queue_${crypto.randomUUID()}`;
}

function queueDispatchOptions(opts = {}) {
  const localAssistant =
    opts.localAssistant && typeof opts.localAssistant === "object"
      ? opts.localAssistant
      : null;
  const queueOrigin = opts.queueOrigin ||
    (opts.scheduledTaskId ? "scheduled_task" : localAssistant ? "local_assistant" : "user");
  const options = {
    engineText: typeof opts.engineText === "string" ? opts.engineText : null,
    recordUser: opts.recordUser !== false,
    recovery: opts.recovery && typeof opts.recovery === "object" ? opts.recovery : null,
    localAssistant,
    reloadSkillsBeforeStart: Boolean(opts.reloadSkillsBeforeStart),
    spawnEngine: opts.spawnEngine,
    skipPreflight: Boolean(opts.skipPreflight),
    skipVision: Boolean(opts.skipVision),
    skipDocument: Boolean(opts.skipDocument),
    ...scheduledTaskTurnOptions(opts),
    queueOrigin,
    queueVisibility: opts.queueVisibility === "background" ? "background" : "composer",
    ...documentDeliveryDispatchOptions(opts),
    // Mobile Command: durable command metadata must survive _tryStartQueuedItem
    // dispatch into the started turn (contract §3.2), so it rides the options.
    externalCommand: opts.externalCommand && typeof opts.externalCommand === "object"
      ? opts.externalCommand
      : null,
    requiredSuccessfulTools: normalizeRequiredTools(opts.requiredSuccessfulTools),
    turnId: typeof opts.turnId === "string" ? opts.turnId : null,
    durableQueueKey: typeof opts.durableQueueKey === "string" ? opts.durableQueueKey : null,
  };
  if (Object.hasOwn(opts, "sourceTurnId")) {
    options.sourceTurnId = opts.sourceTurnId;
  }
  return options;
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
  let classified = opts.classified || classifyAssistantError(opts.raw || "");
  // Report EVERY failure class incl. unclassified — a model-only gate blinds us to "activated but unusable" bugs.
  if (!classified?.code) classified = { code: "UNCLASSIFIED_FAILURE", category: "unknown", retryable: true };
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

function appendPreflightFallback(text, context, title) {
  return require("./engine-message-layers").appendExtractedContext(text, context, title);
}

class TurnOrchestrator {
  static QUEUE_RETRY_DELAY_MS = 80;
  // Consecutive RUNNER_BUSY dispatch retries (× QUEUE_RETRY_DELAY_MS ≈ 2.4s of
  // grace for a normal abort-settle) before a runner that stays busy while the
  // session is idle is treated as wedged and recycled.
  static STALE_RUNNER_BUSY_DISPATCHES = 30;

  constructor(ctx) {
    this.ctx = ctx;
    this.eventBus = ctx.eventBus;
    this.transcriptStore = ctx.transcriptStore;
    this.turnArchive = ctx.turnArchive;
    this.states = new Map();
    this.boundRunners = new WeakSet();
    this.runCoordinator = ctx.turnRunCoordinator || new TurnRunCoordinator();
    this.dispatchRetryTimers = new Map();
    this.dispatchInFlight = new Map();
    this.principalEpoch = 0;
    this.dispatchLinearizationGate = {
      active: false,
      pending: [],
    };
    this.characterWorldsRuntime = createCharacterWorldsRuntime(this, log);
    this.recoveredQueueSessions = new Set();
    this.subagentRuntime = createSubagentRuntimeProjection({
      getState: (sessionId) => this._state(sessionId),
      emitEngineNotice: (sessionId, notice) => this._emitEngineNotice(sessionId, notice),
      onEngineError: (sessionId, childSessionId, message) => (
        this._noteSubagentEngineError(sessionId, childSessionId, message)
      ),
    });
    this.taskRunRuntime = createTaskRunRuntime({
      getState: (sessionId) => this._state(sessionId),
      emitEvent: (sessionId, event) => this.eventBus.emit(sessionId, event),
      agentTaskGraphStore: ctx.agentTaskGraphStore || null,
      publicHookRuntime: ctx.publicHookRuntime || null,
    });
    // External-command dedup ledgers, keyed by lilySessionId → Map(commandId →
    // record). Backed by a durable store so exactly-once ADMISSION survives a
    // desktop restart (contract §3.3): a replayed mobile commandId resolves to
    // its original admission instead of enqueuing a second turn. Fail-open — if
    // the store can't be built or loaded, fall back to an in-memory-only Map
    // (the prior behaviour), never worse.
    this.externalCommandRuntime = createExternalCommandRuntime({
      ledgerStore: ctx.externalCommandLedgerStore || null,
      findSession: (sessionId) => this.ctx.sessionManager.findById(sessionId),
      getState: (sessionId) => this._state(sessionId),
      createQueueId: newQueueId,
      buildQueueOptions: queueDispatchOptions,
      lookupDurableExternalIdentity:
        typeof this.ctx.sessionManager.findTurnInputByExternalIdentity === "function"
          ? (sessionId, identity) => (
              this.ctx.sessionManager.findTurnInputByExternalIdentity(
                sessionId,
                identity,
              ) || null
            )
          : null,
      admitQueueItem: (session, item) => this._admitQueuedTurn(session, item, {
        delivery: "queue",
        metadata: {
          fromQueue: true,
          externalCommand: true,
          commandId: item.options?.externalCommand?.commandId || null,
        },
      }),
      emitQueue: (sessionId) => this._emitQueue(sessionId),
      dispatchNext: (sessionId) => this._dispatchNext(sessionId),
    });
    this.turnRecoveryRuntime = createTurnRecoveryRuntime({
      ctx: this.ctx,
      transcriptStore: this.transcriptStore,
      getState: (sessionId) => this._state(sessionId),
      emit: (sessionId, type, payload, opts) => this._emit(sessionId, type, payload, opts),
      sendUserMessage: (sessionId, text, files, opts) => this.sendUserMessage(sessionId, text, files, opts),
      attemptRescue: (sessionId, failure) => this._maybeToolCallRescueRetry(sessionId, failure),
    });
    this.contextCompactionRuntime = createContextCompactionRuntime({
      ctx: this.ctx,
      emit: (sessionId, type, payload, opts) => this._emit(sessionId, type, payload, opts),
    });
    this.terminalFinalizer = createTurnTerminalFinalizer({
      ctx: { ...this.ctx, characterWorldsRuntime: this.characterWorldsRuntime },
      turnArchive: this.turnArchive,
      taskRunRuntime: this.taskRunRuntime,
      subagentRuntime: this.subagentRuntime,
      getState: (sessionId) => this._state(sessionId),
      emit: (sessionId, type, payload, opts) => this._emit(sessionId, type, payload, opts),
      attemptVerifyRetry: (sessionId, failure) => this._maybeToolCallRescueRetry(sessionId, failure),
      scheduleBackgroundCompaction: (sessionId) => this._scheduleBackgroundCompaction(sessionId),
      reconcileExternalCommand: (turn) => (
        this.externalCommandRuntime.reconcileTurnInput(turn)
      ),
    });
    this.runtimeEventRouter = createTurnRuntimeEventRouter({
      ctx: this.ctx,
      taskRunRuntime: this.taskRunRuntime,
      subagentRuntime: this.subagentRuntime,
      getState: (sessionId) => this._state(sessionId),
      emit: (sessionId, type, payload, opts) => this._emit(sessionId, type, payload, opts),
      claimAgentResumeId: (sessionId, agentResumeId) => this._claimAgentResumeId(sessionId, agentResumeId),
      handleRuntimeControl: (sessionId, payload) => this._handleRuntimeControl(sessionId, payload),
    });
    for (const session of this.ctx.sessionManager?.iterateSessions?.() || []) {
      this.restorePendingTurns(session.id);
    }
    // Safety net for phases no engine watchdog covers ("starting"/"finalizing").
    this.stuckPhaseGuard = require("./turn-start-guard").startStuckPhaseGuard(this);
  }

  /**
   * The ONLY external (mobile) command admission entry (MC-SPEC-008 §3.3).
   * Mobile code must never call sendUserMessage/runner directly. Validates and
   * admits exactly once: a replayed commandId returns its existing ledger state
   * without re-enqueuing; a same-key/different-payload command is rejected; an
   * absent/misowned session is a non-admission. A requested steer is admitted
   * as queue (downgradeReason recorded); runner.steer is never invoked.
   * Returns the admission response shape mobile consumes. Fail-open: internal
   * errors surface as a structured non-admission, never a thrown turn.
   */
  async admitExternalCommand(envelope = {}, checks = {}) {
    return this.externalCommandRuntime.admit(envelope, checks);
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
      outcomeUnknownTurns: (state.outcomeUnknownTurns || []).slice(),
      runtime: this.eventBus.snapshot(sessionId),
      taskRun: compactTaskRun(state.taskRun),
    };
  }

  bindRunner(runner) {
    if (!runner || this.boundRunners.has(runner)) return;
    this.boundRunners.add(runner);
    runner.bindOrchestrator?.(this);
    const sessionId = runner.sessionId;
    this.restorePendingTurns(sessionId);
    void this._dispatchNext(sessionId);

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
      this.runtimeEventRouter.applyDraft(sessionId, draft);
    }
  }

  notifyRunnerDone(sessionId, payload) {
    void this._handleDone(sessionId, payload);
  }

  notifyRunnerError(sessionId, message) {
    void this._handleError(sessionId, message);
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

  async completeLocalAssistantTurn(sessionId, text, files = [], opts = {}) {
    const session = this.ctx.sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const displayText = String(text || "").trim();
    if (!displayText && (!files || files.length === 0)) return { ok: false, error: "EMPTY" };

    const state = this._state(sessionId);
    if ((state.phase !== "idle" || state.startInFlight) && !opts.fromQueue) {
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
      const admission = this._admitQueuedTurn(session, item, {
        metadata: {
          fromQueue: true,
          localAssistant: true,
        },
      });
      if (!admission.ok) return admission;
      if (admission.duplicate) {
        return this._durableDuplicateResult(admission, state.queue.length);
      }
      state.queue.push(item);
      this._emitQueue(sessionId);
      return { ok: true, queued: true, queueLength: state.queue.length, itemId: item.id };
    }

    return require("./turn-start-guard").guardLocalAssistantTurn(
      this,
      session,
      displayText,
      files,
      opts,
    );
  }

  /** Runtime self-heal: a healable failure triggers a forced re-probe of the
   *  active custom model in the background. If the compatibility profile
   *  actually changed, the failed message is retried once, silently. Runs
   *  after the turn already finalized as failed, so every internal error here
   *  fails open to the normal failure UX. */
  async _maybeSelfHealAndRetry(sessionId, failure) {
    return this.turnRecoveryRuntime.maybeSelfHealAndRetry(sessionId, failure);
  }

  /** Turn rescue: immediate silent retry-once for failures a retry plausibly
   *  fixes without config changes — leaked tool-call text (retry carries a
   *  corrective instruction on the ENGINE-facing text) and empty completions
   *  (plain retry absorbs gateway flakes). The visible transcript stays
   *  untouched. Returns true when a rescue retry was dispatched (the self-heal
   *  path is then skipped for this failure; the background probe still runs so
   *  the platform keeps learning). Fail-open: any error → normal failure flow. */
  async _maybeToolCallRescueRetry(sessionId, failure) {
    return this.turnRecoveryRuntime.maybeToolCallRescueRetry(sessionId, failure);
  }

  /** The active model's probed recipes (capability.recipes), or {} — never throws. */
  _modelRecipes() {
    return modelRecipes();
  }

  /** The active session guide (AGENT.md + protocol appendices) — same text the
   *  save-time probe uses, so the re-probe measures realistic prompt sizes. */
  _selfHealProbeText(sessionId) {
    return selfHealProbeText(sessionId);
  }

  async retryLastMessage(sessionId, retryOptions = {}) {
    return this.turnRecoveryRuntime.retryLastMessage(sessionId, retryOptions);
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

  async _startLocalAssistantTurn(session, text, files, opts = {}) {
    const rawUserText = String(text || "").trim();
    const state = this._state(session.id);
    const preadmitted = opts.admittedTurnInput?.sessionId === session.id
      ? opts.admittedTurnInput
      : null;
    state.phase = "starting";
    state.turnGeneration = (state.turnGeneration || 0) + 1;
    // Reuse a pre-echoed turnId (see echoUserMessage) so the already-shown user
    // message and this turn's assistant card belong to the SAME turn.
    state.turnId = preadmitted?.turnId || opts.turnId || newTurnId();
    // Sticky across finalize (NOT cleared in the idle reset): the rescue hook
    // runs after turn-state reset and must know this turn was a rescue attempt.
    state.wasRescueAttempt = Boolean(opts.rescueAttempt || opts.recovery);
    applyDocumentDeliveryTurnState(state, opts);
    state.steerCount = 0;
    state.admittedSeq = null;
    state.admittedTurnInput = null;
    state.dispatchAttemptId = opts.dispatchAttemptId || null;
    state.characterWorldsSnapshot = null;
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
    initializeTurnEvidenceState(state);
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
    this.taskRunRuntime.begin(session.id, rawUserText, {
      displayFiles,
      localAssistant: true,
    });
    state.currentPayload = {
      rawText: rawUserText,
      text: rawUserText,
      files,
      displayFiles,
    };
    const admissionOptions = {
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
    };
    if (Object.hasOwn(opts, "sourceTurnId")) {
      admissionOptions.sourceTurnId = opts.sourceTurnId;
    }
    const admitted = preadmitted || this._admitTurnInput(session, admissionOptions);
    state.admittedSeq = admitted?.admittedSeq || null;
    state.admittedTurnInput = admitted || null;
    require("./public-hooks").observePublicHook(this.ctx.publicHookRuntime, "turn.admitted", { sessionId: session.id, turnId: state.turnId, principalId: admitted?.ownerScope || "", delivery: admitted?.delivery || "local" });
    state.characterWorldsSnapshot = snapshotFromMetadata(admitted?.metadata);
    state.characterWorldsRuntimeSnapshot = null;

    if (opts.recordUser !== false) {
      this.transcriptStore.commitUserMessage(session.id, {
        text: rawUserText,
        files: displayFiles,
        turnId: state.turnId || "turn:legacy-runtime",
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

  cancelQueuedScheduledRun(sessionId, runId) { return cancelQueuedScheduledRun(this, sessionId, runId); }

  async _startTurn(session, text, files, opts = {}) {
    const rawUserText = String(text || "").trim();
    const preadmitted = opts.admittedTurnInput?.sessionId === session.id
      ? opts.admittedTurnInput
      : null;
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
        const cancellation = startCancellationResult(this, session.id);
        if (cancellation) return cancellation;
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
    const cancellation = startCancellationResult(this, session.id);
    if (cancellation) return cancellation;
    const allowImageFileParts = Boolean(require("./model-presets").activePresetSupportsVision());
    state.phase = "starting";
    state.turnGeneration = (state.turnGeneration || 0) + 1;
    state.turnId = preadmitted?.turnId || newTurnId();
    state.wasRescueAttempt = Boolean(opts.rescueAttempt || opts.recovery);
    applyDocumentDeliveryTurnState(state, opts);
    state.steerCount = 0;
    state.admittedSeq = null;
    state.admittedTurnInput = null;
    state.dispatchAttemptId = opts.dispatchAttemptId || null;
    state.characterWorldsSnapshot = null;
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
    initializeTurnEvidenceState(state, opts.recovery);
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
    const turnStartId = state.turnId;
    const turnStartGeneration = state.turnGeneration;
    const isCurrentStart = () => isCurrentTurnStart(
      state,
      turnStartId,
      turnStartGeneration,
    );
    const staleStartResult = () => ({
      ok: false,
      error: "TURN_START_ABORTED",
      staleStart: true,
      turnId: turnStartId,
    });
    const displayFiles = mergeDisplayFileMetadata(displaySourceFiles, opts.displayFiles);
    let dependencyAdvisory = buildDependencyAdvisoryForTurn(rawUserText, files);
    state.currentPayload = {
      rawText: rawUserText,
      text: rawUserText,
      files,
      displayFiles,
    };
    const admissionOptions = {
      turnId: state.turnId,
      delivery: opts.fromQueue ? "queue" : "direct",
      status: "admitted",
      userText: rawUserText,
      files: displayFiles,
      metadata: {
        fromQueue: Boolean(opts.fromQueue),
        scheduledTaskId: opts.scheduledTaskId || null,
        scheduledTaskRunId: opts.scheduledTaskRunId || null,
      },
      createdAt: state.startedAt,
    };
    if (Object.hasOwn(opts, "sourceTurnId")) {
      admissionOptions.sourceTurnId = opts.sourceTurnId;
    }
    const admitted = preadmitted || this._admitTurnInput(session, admissionOptions);
    state.admittedSeq = admitted?.admittedSeq || null;
    state.admittedTurnInput = admitted || null;
    require("./public-hooks").observePublicHook(this.ctx.publicHookRuntime, "turn.admitted", { sessionId: session.id, turnId: state.turnId, principalId: admitted?.ownerScope || "", delivery: admitted?.delivery || "direct" });
    state.characterWorldsSnapshot = snapshotFromMetadata(admitted?.metadata);
    state.characterWorldsRuntimeSnapshot = null;
    state.scheduledTask = opts.scheduledTaskRunId
      ? {
          id: opts.scheduledTaskId || null,
          runId: opts.scheduledTaskRunId,
          title: opts.scheduledTaskTitle || "",
        }
      : null;
    if (opts.recordUser !== false) {
      this.transcriptStore.commitUserMessage(session.id, {
        text: rawUserText,
        files: displayFiles,
        turnId: state.turnId || "turn:legacy-runtime",
      });
      this._emit(session.id, "user.committed", {
        text: rawUserText,
        files: displayFiles.length ? displayFiles : null,
      }, { turnId: state.turnId });
    }

    const turnIntelligence = resolveTurnIntelligence({
      ctx: this.ctx,
      session,
      project,
      text: rawUserText,
      files,
      turnId: state.turnId,
    });
    const { taskContract, turnPolicy } = documentDeliveryTurnIntelligence(turnIntelligence, state.documentDeliveryRecovery);
    const committedMessages = turnIntelligence.committedMessages || [];
    const sessionSummary = turnIntelligence.sessionSummary || null;
    state.pendingTaskContract = taskContract;
    state.taskContract = taskContract.active ? taskContract : null;
    state.turnPolicy = turnPolicy;
    if (taskContract.taskType === "content_extraction" && taskContract.priorSourceContentEvidence) {
      state.evidenceLedger?.recordSourceContentObservation?.({
        sourceType: "conversation_context",
        method: "prior_turn_source_context",
        status: "available",
        sourceCount: Number(taskContract.priorSourceContentEvidence.sourceCount || 1),
      });
    }
    if (shouldBeginTaskRunAtTurnStart({ taskContract, turnPolicy, scheduledTask: state.scheduledTask })) {
      this.taskRunRuntime.begin(session.id, rawUserText, {
        displayFiles,
        scheduledTask: state.scheduledTask,
        intentContract: taskContract.intentContract || null,
      });
    }

    const capabilityReadinessTrace = opts.skipPreflight
      ? null
      : await prepareTurnCapabilityReadiness({
          ctx: this.ctx,
          sessionId: session.id,
          turnId: state.turnId,
          text: rawUserText,
          files,
          taskContract,
          turnPolicy,
          deps: this.ctx.capabilityReadinessDeps,
          onProgress: (progress) => emitRuntimePackProgress(this, session.id, progress),
        });
    if (!isCurrentStart()) return staleStartResult();
    if (capabilityReadinessTrace?.status === "ready") {
      dependencyAdvisory = buildDependencyAdvisoryForTurn(rawUserText, files);
    }

    ensured = opts.skipPreflight
      ? { runner: this.ctx.runnerPool.get(session.id) }
      : ensureSessionRunner(this.ctx, session.id, {
          spawn: opts.spawnEngine !== false,
          permissionMode: opts.permissionMode,
          disallowedTools: opts.disallowedTools,
          turnId: state.turnId,
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
        if (!isCurrentStart()) return staleStartResult();
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
            disallowedTools: opts.disallowedTools,
            turnId: state.turnId,
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
      if (!isCurrentStart()) return staleStartResult();
      if (vision.visionEvidence) state.evidenceLedger?.recordVisionObservation?.(vision.visionEvidence);
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
      if (!isCurrentStart()) return staleStartResult();
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
      const { withShortFollowupContext } = require("./session-followup-context");
      const { buildContextMemoryAsync } = require("./memory-registry");
      const { readProjectMemoryIndex } = require("./project-memory");
      const { buildWorkspaceDigest, readLearnedConventions } = require("./learned-context");
      const { readMemoryPreferences } = require("./memory-preferences");
      const { addLayersToEngineText } = require("./engine-message-layers");
      const summary = sessionSummary;
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
      contextMemory = await buildContextMemoryAsync({
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
      if (!isCurrentStart()) return staleStartResult();
      contextMemory.contextEpoch = Number(summary?.contextEpoch || 0);
      contextMemory.deduped = Boolean(
        contextMemory.fingerprint &&
        summary?.lastContextMemoryFingerprint === contextMemory.fingerprint &&
        !ensured.coldStart &&
        !rehydrated,
      );
      const platformContextParts = [require("./turn-clock-context").currentDateTimeLine()];
      if (contextMemory.text && !contextMemory.deduped) platformContextParts.push(contextMemory.text);
      // Proactive workspace retrieval (opt-in LILY_WORKSPACE_AUTOINJECT=1): on
      // substantive (grounded/coverage) turns only — never casual/fast chat, so
      // no context dilution on ordinary turns. Bounded, freshness-verified
      // (no deleted files), "retrieval not proof", fail-open → floor = baseline.
      if (process.env.LILY_WORKSPACE_AUTOINJECT === "1" && project?.path &&
          (turnPolicy.rigor === "grounded" || turnPolicy.rigor === "coverage")) {
        try {
          const hit = require("./mcp/file-intelligence-index").retrieveWorkspaceContext({
            workspacePath: project.path,
            query: rawUserText,
          });
          if (hit?.text) platformContextParts.push(hit.text);
        } catch { /* fail-open — inject nothing */ }
      }
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
    engineText = applyInternalRecoveryLayer(engineText, opts.recovery);
    engineText = withTaskContractPrefix(engineText, taskContract);
    state.enginePayload = {
      rawText: rawUserText,
      text: engineText,
      turnId: state.turnId,
      taskRunId: state.taskRun?.id || "",
      files,
      displayFiles,
      allowImageFileParts,
      taskContract: state.taskContract,
      turnPolicy: state.turnPolicy,
      nonInteractive: Boolean(opts.nonInteractive || state.wasRescueAttempt || state.documentDeliveryRecovery),
      requiredSuccessfulTools: normalizeRequiredTools(opts.requiredSuccessfulTools),
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
    const characterContext = this._compileTurnCharacterContext(session, state, runner);
    state.enginePayload.characterContext = characterContext?.status === "compiled" ? characterContext : null;
    if (state.characterWorldsSnapshot?.snapshotStatus === "ready") {
      // Metadata only — card contents never enter the trace.
      state.enginePayload.trace.characterContext = characterContext?.status === "compiled"
        ? {
            status: "compiled",
            fingerprint: characterContext.fingerprint,
            revisionId: state.characterWorldsSnapshot.characterRevisionId,
            expressionProfile: characterContext.expressionProfile,
            activatedFields: characterContext.activatedFields,
            omitted: characterContext.omitted,
            warnings: characterContext.warnings,
            tokenEstimate: characterContext.tokenEstimate,
            activatedEntryCount: (characterContext.activatedWorldEntries || []).length,
            worldBookBindings: Array.isArray(state.characterWorldsSnapshot.worldBookBindings)
              ? state.characterWorldsSnapshot.worldBookBindings.map((binding) => ({
                  revisionId: binding.worldBookRevisionId,
                  scope: binding.scope,
                }))
              : characterContext.worldBook
                ? [{ revisionId: characterContext.worldBook.revisionId, scope: "character" }]
                : [],
            compiledAt: new Date().toISOString(), ...(characterContext.persona ? { persona: characterContext.persona } : {}),
          }
        : {
            status: "native",
            revisionId: state.characterWorldsSnapshot.characterRevisionId,
            ...(state.characterWorldsPolicyReason
              ? { policyReason: state.characterWorldsPolicyReason }
              : {}),
          };
    }
    const preTurnCompaction = await this._maybeCompactBeforeTurn(session.id, runner, state.enginePayload, state.characterWorldsSnapshot);
    if (!isCurrentStart()) return staleStartResult();
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

    if (this.ctx.publicHookRuntime && process.env.LILY_PUBLIC_HOOKS_V1 !== "0") {
      const hookDecision = await this.ctx.publicHookRuntime.run("turn.before_dispatch", {
        sessionId: session.id,
        turnId: state.turnId,
        taskRunId: state.taskRun?.id || "",
        principalId: state.admittedTurnInput?.ownerScope || "",
        text: state.enginePayload.text,
        files: state.enginePayload.displayFiles || [],
      });
      if (!isCurrentStart()) return staleStartResult();
      if (!hookDecision.allow) {
        this._finalize(session.id, "turn.failed", {
          assistant: "",
          code: "PUBLIC_HOOK_DENIED",
          errorCode: "PUBLIC_HOOK_DENIED",
          error: hookDecision.reason || "A configured security hook denied this turn.",
        });
        return { ok: false, error: "PUBLIC_HOOK_DENIED", hookDecision };
      }
      if (hookDecision.contextAppend) {
        state.enginePayload.text = `${state.enginePayload.text}\n\n${hookDecision.contextAppend}`;
      }
    }

    // Linearized dispatch: revalidate the queue selection / owner against the
    // principal epoch, run the durable dispatch CAS, and only then touch the
    // engine — all inside one synchronous critical section. Every deterministic
    // preflight above has already completed, so a durable "dispatching" row
    // can only exist when the engine was actually invoked next.
    if (!isCurrentStart()) return staleStartResult();
    const dispatch = this._invokePreparedEngineDispatch(session, state, runner, {
      ...opts,
      queueSelection: opts.queueSelection || null,
    });
    if (!dispatch.ok) {
      if (dispatch.ownerPause) {
        // The principal changed while preflight was awaiting.
        if (!opts.queueSelection) {
          // Direct send: no queue recovery exists for this durable
          // admission, so close it visibly (admitted -> interrupted) instead
          // of leaking an admitted row that nothing can re-dispatch.
          this._finalize(session.id, "turn.interrupted", {
            interrupted: true,
            assistant: "",
            code: "PRINCIPAL_CHANGED",
            errorCode: "PRINCIPAL_CHANGED",
          });
          return {
            ok: false,
            ownerPause: true,
            error: dispatch.error || "OWNER_SCOPE_MISMATCH",
          };
        }
        // Queue turn: the durable admission stays recoverable ("admitted")
        // so a later epoch can re-dispatch it — but the live projection must
        // still close visibly, or the renderer keeps a running bubble for a
        // turn that is no longer running. The signal must be NON-terminal:
        // the bus permanently filters post-terminal events per turnId, and
        // this exact turnId is designed to be revived by re-dispatch.
        const pausedTurnId = state.turnId;
        require("./turn-terminal-finalizer").clearTurnState(state);
        if (pausedTurnId) {
          this._emit(session.id, "turn.paused", {
            paused: true,
            principalChanged: true,
            resumable: true,
            code: "PRINCIPAL_CHANGED",
            errorCode: "PRINCIPAL_CHANGED",
          }, { turnId: pausedTurnId });
        }
        return {
          ok: false,
          ownerPause: true,
          error: dispatch.error || "OWNER_SCOPE_MISMATCH",
        };
      }
      if (dispatch.retry) {
        require("./turn-terminal-finalizer").clearTurnState(state);
        return {
          ok: false,
          retry: true,
          error: dispatch.error || "DISPATCH_LINEARIZATION_BUSY",
        };
      }
      if (dispatch.preSendFailure) {
        // The claim succeeded but the engine provably never received the
        // turn: the dedicated dispatching -> failed CAS already ran inside
        // the critical section; project it visibly exactly once. When that
        // CAS succeeded, tell the finalizer the durable row is already
        // terminal so it does not lose a second CAS to its own mark and
        // strip the user-facing payload (see terminalAlreadyRecorded).
        this._finalize(session.id, "turn.failed", {
          failed: true,
          assistant: "The assistant engine did not accept the message. Please retry.",
          code: dispatch.error === "PRE_SEND_THROW"
            ? "PRE_SEND_THROW"
            : "RUNNER_REJECTED",
          ...(dispatch.terminal?.ok ? { terminalAlreadyRecorded: true } : {}),
        });
        return {
          ok: false,
          error: "RUNNER_ERROR",
          detail: dispatch.detail
            || runner.lastSpawnError
            || "The assistant engine did not accept the message. Please retry.",
        };
      }
      return dispatch.result;
    }
    const dispatchAttemptId = dispatch.attemptId;
    state.phase = "running";
    this._injectTurnDispatchFault("after_engine_accept", {
      sessionId: session.id,
      turnId: state.turnId,
      dispatchAttemptId,
    });
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
      this._markTurnDispatchAccepted(state.turnId, dispatchAttemptId, {
        engineTextChanged: engineText !== rawUserText,
        taskContract: Boolean(state.taskContract),
      });
    } catch {
      // The dispatching row remains outcome-unknown and is never auto-replayed.
    }
    require("./usage-reporter").recordUserSend(session.id, files);
    return {
      ok: true,
      turnId: state.turnId,
      userCommitted: opts.recordUser === false ? null : { text: rawUserText, files: displayFiles },
    };
  }

  async _maybeCompactBeforeTurn(sessionId, runner, enginePayload = {}, characterWorldsSnapshot = null) {
    return this.contextCompactionRuntime.maybeCompactBeforeTurn(sessionId, runner, enginePayload, characterWorldsSnapshot);
  }

  /**
   * Effective Character Worlds rollout policy for this turn (spec §16/§18).
   * Resolution order: ctx override (tests) → the signed remote config via the
   * constants resolver. Any resolution failure fails closed to disabled; the
   * LILY_CHARACTER_WORLDS=0 kill switch is honored inside the resolver.
   */
  _characterWorldsPolicy() {
    try {
      if (typeof this.ctx?.characterWorldsPolicy === "function") {
        return this.ctx.characterWorldsPolicy();
      }
      const { characterWorldsPolicy } = require("./character-worlds/constants");
      const remoteConfig = require("./remote-config");
      return characterWorldsPolicy(remoteConfig.getRemoteEffectiveConfigSync());
    } catch {
      return { enabled: false, reason: "policy_error" };
    }
  }

  /**
   * Compile the admitted character snapshot into the bounded lower-authority
   * context for this turn (spec §10). The immutable revision named by the
   * admitted snapshot is resolved — never the current binding — and any
   * failure fails open to native Lily (null). Only metadata is logged.
   */
  _compileTurnCharacterContext(session, state, runner) {
    return compileTurnContext({ orchestrator: this, session, state, runner, log });
  }

  async _handleDone(sessionId, payload) {
    const state = this._state(sessionId);
    state.requiredToolResults = Array.isArray(payload?.requiredToolResults) ? payload.requiredToolResults : [];
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

    let finalizeDone = null;
    const terminalMeta = {
      durationMs: state.durationMs ?? null,
      totalCostUsd: state.totalCostUsd ?? null,
      // Rewind anchor: the engine message id of this turn (session:rewind reverts
      // the engine session to it). Null on turns that never reached the engine.
      engineMessageId: payload?.engineMessageId || null,
    };
    if (interrupted) {
      finalizeDone = this._finalize(sessionId, "turn.interrupted", {
        interrupted: true,
        assistant: normalized.text || state.assistantText,
        ...terminalMeta,
      });
    } else if (stalled) {
      finalizeDone = this._finalize(sessionId, "turn.stalled", {
        stalled: true,
        assistant: appendIncompleteTurnSummary(normalized.text || state.assistantText, state, payload),
        ...terminalMeta,
      });
    } else if (failed) {
      let friendly = failure.message || normalized.text || sanitizeError(collectFailureTextFromState(state)) || "The assistant engine encountered an error. Please retry.";
      // Make the invisible self-heal visible: a retried turn that still fails
      // must say so — two naked failures read as "no recovery".
      friendly += this.turnRecoveryRuntime.rescueRetryNotice(sessionId, state.wasRescueAttempt);
      const rawFailureText = collectFailureTextFromState(state) || normalized.text || payload?.error || payload?.message || friendly;
      const failedTurnId = state.turnId;
      finalizeDone = this._finalize(sessionId, "turn.failed", {
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
      // Rescue after finalize so its resend never races phase "finalizing".
      Promise.resolve(finalizeDone).then(() => { void this._maybeSelfHealAndRetry(sessionId, failure); });
    } else if (blockingProcessJobs.length) {
      const notice = runningProcessJobNotice(blockingProcessJobs);
      finalizeDone = this._finalize(sessionId, "turn.stalled", {
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
      finalizeDone = this._finalize(sessionId, "turn.completed", {
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
    Promise.resolve(finalizeDone).then(() => this._afterTurnFinalized(sessionId));
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
    const finalizeDone = this._finalize(sessionId, "turn.failed", {
      failed: true,
      assistant: text,
      errorCode: classified?.code || "ENGINE_ERROR",
      errorCategory: classified?.category || "",
      retryable: classified?.retryable !== false,
      error: raw,
    });
    void this._maybeSelfHealAndRetry(sessionId, classified);
    Promise.resolve(finalizeDone).then(() => this._afterTurnFinalized(sessionId));
  }

  _finalize(sessionId, type, payload = {}) {
    return this.terminalFinalizer.finalize(sessionId, type, payload);
  }

  _scheduleBackgroundCompaction(sessionId) {
    this.contextCompactionRuntime.scheduleBackgroundCompaction(sessionId);
  }

  _afterTurnFinalized(sessionId) {
    // Queue progression is part of the turn boundary. Usage reporting is
    // telemetry and may hit disk or network, so it must never delay the next
    // user-visible turn.
    void this._dispatchNext(sessionId);
    void this._flushUsage(sessionId);
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
    if (
      state.phase === "starting" &&
      (type === "engine.notice" || type === "engine.warning")
    ) {
      state.updatedAt = Date.now();
    }
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
      const state = {
        sessionId,
        phase: "idle",
        turnId: null,
        turnGeneration: 0,
        admittedSeq: null,
        admittedTurnInput: null,
        dispatchAttemptId: null,
        characterWorldsSnapshot: null,
        characterWorldsRuntimeSnapshot: null,
        requiredToolResults: [],
        assistantText: "",
        thinkingText: "",
        contentBlocks: [],
        protocolUnknown: [],
        processEvents: [],
        notices: [],
        usage: null,
        taskContract: null,
        pendingTaskContract: null,
        turnPolicy: null,
        evidenceLedger: null,
        inheritedEvidenceTools: [],
        taskRun: null,
        enginePayload: null,
        legacyContextHydrated: false,
        timeline: [],
        activityLabel: null,
        durationMs: null,
        totalCostUsd: null,
        blockIndexToToolId: new Map(),
        queue: [],
        outcomeUnknownTurns: [],
        outcomeUnknownTurnIds: new Set(),
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
      };
      this.states.set(sessionId, state);
      this._restorePendingTurnsIntoState?.(sessionId, state);
    }
    return this.states.get(sessionId);
  }
}

const turnAdmissionMethods = require("./turn-admission-runtime").createTurnAdmissionMethods({
  log,
  mergeDisplayFileMetadata,
  newQueueId,
  newTurnId,
  queueDispatchOptions,
});
const turnQueueRecoveryMethods = require("./turn-queue-recovery").createTurnQueueRecoveryMethods({
  log,
  queueDispatchOptions,
});
const turnQueueDispatchMethods = require("./turn-queue-dispatch").createTurnQueueDispatchMethods({
  documentDeliveryDispatchOptions,
  log,
  scheduledQueueCapacityBlock,
  scheduledTaskTurnOptions,
});
const turnDispatchMethods = require("./turn-dispatch-runtime").createTurnDispatchMethods({
  log,
});
const turnSteerMethods = require("./turn-steer-runtime").createTurnSteerMethods({
  appendTimelineNotice,
  log,
  mergeDisplayFileMetadata,
});
const turnQueueLifecycleMethods = require("./turn-queue-lifecycle").createTurnQueueLifecycleMethods({
  log,
});
Object.defineProperties(
  TurnOrchestrator.prototype,
  Object.fromEntries(Object.entries({
    ...turnAdmissionMethods,
    ...turnDispatchMethods,
    ...turnQueueDispatchMethods,
    ...turnQueueRecoveryMethods,
    ...turnSteerMethods,
    ...turnQueueLifecycleMethods,
  }).map(([name, value]) => [
    name,
    { configurable: true, writable: true, value },
  ])),
);
module.exports = { TurnOrchestrator, prepareTurnCapabilityReadiness };
