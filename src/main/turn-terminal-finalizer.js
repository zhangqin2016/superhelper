"use strict";

const crypto = require("node:crypto");
const { evaluateAnswerEvidenceWithJudge, shouldBufferAssistantAnswer } = require("./answer-evidence-finalizer");
const { clearDocumentDeliveryTurnState } = require("./document-delivery-turn");
const { getLogger } = require("./logger");
const { compactTaskRun } = require("./task-run-state");
const { buildEvidenceRecoveryContext } = require("./turn-recovery-context");
const { TERMINAL_TYPES } = require("./turn-event-types");
const { promoteTerminalNarrative } = require("./turn-terminal-narrative");
const { attachDraftReceipts } = require("./character-worlds/receipt-finalizer");
const {
  appendTimelineNotice,
  appendTimelineText,
  closeStreamingBlocks,
  resetTimelineState,
  upsertTimelineTool,
} = require("./turn-timeline");
const log = getLogger("turn-terminal-finalizer");
// Durable turn-input row statuses that prove a terminal winner exists. Mirrors
// the store's terminal set; kept local so the finalizer stays a pure projection.
const TERMINAL_RECORD_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "stalled",
]);
function terminalTypeForWinner(winner, fallback) {
  if (TERMINAL_TYPES.has(winner?.terminalType)) return winner.terminalType;
  switch (winner?.status) {
    case "completed": return "turn.completed";
    case "interrupted":
    case "cancelled": return "turn.interrupted";
    case "stalled": return "turn.stalled";
    case "failed": return "turn.failed";
    default: return fallback;
  }
}

function collectLearnedSkills(ctx, sessionId, state) {
  try {
    const { collectLearnedSkillDrafts } = require("./learned-skills");
    const skillManager = require("./skill-manager");
    const session = ctx.sessionManager?.findById?.(sessionId) || null;
    const project = session?.projectId && ctx.projectManager?.find
      ? ctx.projectManager.find(session.projectId)
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
    if (!learned.length) return;
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
  } catch (err) {
    log.warn("learned skill collection failed: %s", err?.message || err);
  }
}

function clearTurnState(state) {
  state.phase = "idle";
  state.turnId = null;
  state.finalizing = false;
  state.steerCount = 0;
  state.admittedSeq = null;
  state.admittedTurnInput = null;
  state.dispatchAttemptId = null;
  state.characterWorldsSnapshot = null;
  state.characterWorldsRuntimeSnapshot = null;
  state.pendingWorldBookCheckpoint = null;
  state.requiredToolResults = [];
  state.assistantText = "";
  state.thinkingText = "";
  state.contentBlocks = [];
  state.protocolUnknown = [];
  state.processEvents = [];
  state.notices = [];
  state.usage = null;
  state.lastStopReason = "";
  state.sawRecognizedStopReason = false;
  state.scaffoldStreamGate = null;
  state.taskContract = null;
  state.pendingTaskContract = null;
  state.turnPolicy = null;
  state.evidenceLedger = null;
  state.inheritedEvidenceTools = [];
  state.taskRun = null;
  state.enginePayload = null;
  clearDocumentDeliveryTurnState(state);
  resetTimelineState(state);
  state.blockIndexToToolId = new Map();
  state.currentPayload = null;
  state.scheduledTask = null;
  state.pendingPermissions.clear();
  state.pendingQuestions.clear();
  state.pendingHooks.clear();
}

function createTurnTerminalFinalizer(options = {}) {
  const ctx = options.ctx || {};
  const turnArchive = options.turnArchive;
  const taskRunRuntime = options.taskRunRuntime;
  const subagentRuntime = options.subagentRuntime;
  const getState = options.getState;
  const emit = options.emit || (() => null);
  const attemptVerifyRetry = options.attemptVerifyRetry || (() => Promise.resolve(false));
  const scheduleBackgroundCompaction = options.scheduleBackgroundCompaction || (() => {});

  function stateFor(sessionId) {
    if (typeof getState !== "function") throw new Error("getState adapter is required");
    return getState(sessionId);
  }

  // finalize awaits the (fail-open) evidence entailment judge, so it is async.
  // Callers fire-and-forget; this wrapper keeps that contract crash-safe.
  function finalize(sessionId, type, payload = {}) {
    return finalizeAsync(sessionId, type, payload).catch((err) => {
      log.warn("turn finalize failed open: %s", err?.message || err);
      // Release the re-entrancy latch so a later terminal (e.g. the stall
      // watchdog) can still finalize this turn instead of leaving it stuck.
      try {
        stateFor(sessionId).finalizing = false;
      } catch {
        /* state already gone */
      }
    });
  }

  async function finalizeAsync(sessionId, type, payload = {}) {
    const state = stateFor(sessionId);
    if (!state.turnId || state.terminalEmitted) return;
    // Re-entrancy latch: the judge await yields the event loop, so a racing
    // second terminal (e.g. stall watchdog vs completion) must not double-run.
    if (state.finalizing) return;
    state.finalizing = true;
    if (!TERMINAL_TYPES.has(type)) throw new Error(`Invalid terminal event ${type}`);
    const completedTurnId = state.turnId;
    const terminalClaim = {
      ownerScope: state.admittedTurnInput?.ownerScope || null,
      sessionId,
      turnId: completedTurnId,
      dispatchAttemptId: state.dispatchAttemptId || null,
      fromStatuses: state.dispatchAttemptId
        ? ["dispatching", "promoted", "accepted", "outcome_unknown"]
        : ["admitted"],
    };
    const markTerminal = ctx.sessionManager?.markTurnInputTerminal;
    // Whether THIS finalization proved a successful durable terminal: true
    // when no terminal CAS is configured (legacy/test path) or the CAS below
    // succeeds; false on CAS loss/error or a pre-recorded terminal. Gates
    // the world-book checkpoint write (§10.4.6).
    let terminalPersisted = typeof markTerminal !== "function";
    // A dedicated pre-send terminal CAS (see _markPreSendFailure) may already
    // have recorded this exact terminal durably. Re-running the CAS would
    // lose against that own mark and take the winner-projection path, which
    // deliberately strips the user-facing payload — so skip the CAS here.
    const terminalAlreadyRecorded = payload.terminalAlreadyRecorded === true
      && TERMINAL_RECORD_STATUSES.has(state.admittedTurnInput?.status);
    delete payload.terminalAlreadyRecorded;
    if (typeof markTerminal === "function" && !terminalAlreadyRecorded) {
      // The durable terminal CAS is the authority. Losing it (or failing to
      // reach the store) must never silently clear the live projection: a
      // proven durable winner is projected verbatim, and an unresolved outcome
      // emits the registered outcome-unknown event with a recovery id instead
      // of pretending the turn simply ended.
      let casLost = false;
      let casError = null;
      let durableWinner = null;
      let durableTurn = null;
      const queryDurableTurn = () => {
        if (durableTurn !== null) return durableTurn;
        try {
          durableTurn = ctx.sessionManager?.getTurnInputByTurnId?.(
            sessionId,
            completedTurnId,
          ) || null;
        } catch (lookupErr) {
          log.warn(
            "terminal winner lookup failed: session=%s turn=%s error=%s",
            sessionId,
            completedTurnId,
            lookupErr?.message || lookupErr,
          );
          durableTurn = null;
        }
        return durableTurn;
      };
      try {
        const terminalResult = markTerminal.call(
          ctx.sessionManager,
          terminalClaim,
          type,
          {
            errorCode: payload.errorCode || payload.code || "",
          },
        );
        if (terminalResult?.ok === false) {
          casLost = true;
          if (TERMINAL_RECORD_STATUSES.has(terminalResult.turn?.status)) {
            durableWinner = terminalResult.turn;
          }
          log.warn(
            "turn input terminal CAS rejected: session=%s turn=%s reason=%s",
            sessionId,
            completedTurnId,
            terminalResult.reason || "UNKNOWN",
          );
        } else if (terminalResult?.turn?.externalCommandId) {
          try {
            options.reconcileExternalCommand?.(terminalResult.turn);
          } catch (reconcileErr) {
            log.warn(
              "external command terminal reconcile failed open: %s",
              reconcileErr?.message || reconcileErr,
            );
          }
        }
      } catch (err) {
        casLost = true;
        casError = err;
        log.warn("turn input terminal mark failed: %s", err?.message || err);
      }
      if (casLost) {
        if (!durableWinner) {
          const durable = queryDurableTurn();
          if (TERMINAL_RECORD_STATUSES.has(durable?.status)) {
            durableWinner = durable;
          }
        }
        if (durableWinner) {
          // Project the immutable first winner, never the late loser: switch
          // to the durable terminal type and drop the loser's payload so its
          // failure cannot overwrite what actually won. The scheduled draft
          // card survives — it describes user-visible work, not the race.
          // Note: the durable row carries no assistant text, so the visible
          // final still uses this process's state.assistantText — correct for
          // the in-process races that dominate (retry/steer vs completion);
          // a cross-process loser may project its local text under the
          // winner's type, which is cosmetic and bounded by the single
          // terminal event guarantee.
          type = terminalTypeForWinner(durableWinner, type);
          payload = payload.scheduledDraft
            ? { scheduledDraft: payload.scheduledDraft }
            : {};
        } else {
          const durableStatus = queryDurableTurn()?.status || "unknown";
          const recoveryId = `recovery_${completedTurnId}_${
            crypto.randomUUID().replace(/-/g, "").slice(0, 12)
          }`;
          log.warn(
            "turn terminal outcome unknown: session=%s turn=%s status=%s recovery=%s",
            sessionId,
            completedTurnId,
            durableStatus,
            recoveryId,
          );
          emit(sessionId, "turn.dispatch_outcome_unknown", {
            turnId: completedTurnId,
            status: durableStatus,
            dispatchAttemptId: terminalClaim.dispatchAttemptId,
            reason: casError ? "TERMINAL_CAS_ERROR" : "TERMINAL_CAS_REJECTED",
            automaticReplay: false,
            manualRecoveryRequired: true,
            recoveryId,
          }, { turnId: completedTurnId });
          // Close the live projection with one visible failure. The durable
          // row keeps its pre-terminal status, so restart recovery can still
          // surface this turn through the outcome-unknown path.
          type = "turn.failed";
          payload = {
            failed: true,
            assistant: "本次回复的持久化结果无法确认（可能已完成，也可能未送达）。为避免重复执行，系统不会自动重试，请核对后手动重发。",
            errorCode: "DISPATCH_OUTCOME_UNKNOWN",
            errorCategory: "durability",
            retryable: false,
            recoveryId,
          };
        }
      }
      if (!casLost) terminalPersisted = true;
    }
    const scheduledTaskRunId = state.scheduledTask?.runId || null;
    state.phase = "finalizing";
    for (const tool of state.tools.values()) {
      if (tool?.status !== "running") continue;
      tool.status = type === "turn.completed" ? "done" : "failed";
      upsertTimelineTool(state, tool, Date.now());
    }
    if (type === "turn.completed") collectLearnedSkills(ctx, sessionId, state);
    closeStreamingBlocks(state, Date.now());

    let assistant = String(payload.assistant || state.assistantText || "").trim();
    let terminalNarrativePromoted = false;
    if (type === "turn.completed") {
      try {
        const promoted = promoteTerminalNarrative(state.timeline, assistant);
        if (promoted.promoted) {
          assistant = promoted.assistant;
          state.timeline = promoted.timeline;
          terminalNarrativePromoted = true;
        }
      } catch (err) {
        log.warn("terminal narrative promotion failed open: %s", err?.message || err);
      }
    }
    // Strip an echoed compaction/handoff scaffold ("Objective / Work State / …")
    // BEFORE the evidence gate judges and before anything is emitted or
    // persisted — the user never sees internal tracking (2026-07-22 field case).
    // Fail-open: an ambiguous boundary keeps the original verbatim; only a
    // message that is ENTIRELY scaffold is replaced by a plain note.
    let statusScaffoldAction = "";
    try {
      const { stripStatusScaffoldPrefix, statusScaffoldNote } = require("./status-scaffold");
      const strip = stripStatusScaffoldPrefix(assistant);
      if (strip.stripped) {
        statusScaffoldAction = strip.pure ? "replaced-pure" : "stripped-prefix";
        assistant = strip.pure
          ? statusScaffoldNote(String(state.enginePayload?.rawText || ""))
          : strip.text;
        log.warn(
          "status scaffold %s (%s, headers=%d)",
          statusScaffoldAction,
          type,
          strip.analysis.headers.length,
        );
      }
    } catch (err) {
      log.warn("status scaffold strip failed open: %s", err?.message || err);
    }
    const finalizerUserText = String(state.enginePayload?.rawText || "");
    const evidenceTools = [
      ...(Array.isArray(state.inheritedEvidenceTools) ? state.inheritedEvidenceTools : []),
      ...(state.tools?.values?.() || []),
    ];
    const evidenceSummary = state.evidenceLedger?.summary?.() || null;
    const verificationPlan = state.taskContract?.externalFactPolicy?.verificationPlan || null;
    let effectiveEvidenceSummary = evidenceSummary;
    let record = turnArchive?.buildRecord(state, type, { ...payload, assistant });
    if (type === "turn.completed") record = attachDraftReceipts({ record, ctx, sessionId, turnId: completedTurnId, evidence: state.requiredToolResults, log });
    if (record && statusScaffoldAction) {
      record.meta = { ...(record.meta || {}), statusScaffold: statusScaffoldAction };
    }
    if (record && terminalNarrativePromoted) {
      record.meta = { ...(record.meta || {}), terminalNarrativePromoted: true };
    }
    let evidenceGateAssessment = null;
    let triggerVerifyRetry = false;
    let triggerDocumentVerifyRetry = false;
    let documentDelivery = null;

    if (type === "turn.completed" && state.taskContract?.evidencePolicy?.required) {
      const guarded = await evaluateAnswerEvidenceWithJudge({
        assistant,
        taskContract: state.taskContract,
        turnPolicy: state.turnPolicy,
        evidenceSummary,
        tools: evidenceTools,
        fileChangeCount: record?.fileChanges?.length || 0,
        userText: finalizerUserText,
        inputFiles: Array.isArray(state.enginePayload?.files) ? state.enginePayload.files : [],
        artifacts: record?.artifacts || [],
        recoveryAttempt: Boolean(state.wasRescueAttempt),
      });
      assistant = guarded.assistant;
      evidenceGateAssessment = guarded.assessment;
      triggerVerifyRetry = guarded.triggerVerifyRetry;
      triggerDocumentVerifyRetry = guarded.triggerDocumentVerifyRetry;
      documentDelivery = guarded.documentDelivery || guarded.assessment?.documentDelivery || null;
      effectiveEvidenceSummary = guarded.evidenceSummary || evidenceSummary;
      if (record) {
        record.assistantText = assistant;
        record.meta = {
          ...(record.meta || {}),
          ...(guarded.assessment ? { evidenceGate: guarded.assessment } : {}),
          ...(documentDelivery ? { documentDelivery } : {}),
          evidenceSummary: effectiveEvidenceSummary,
        };
      }
    }
    const evidenceRecoveryContext = triggerVerifyRetry
      ? buildEvidenceRecoveryContext({ sourceTurnId: completedTurnId, tools: evidenceTools })
      : null;
    if (shouldBufferAssistantAnswer(state.taskContract) && assistant) {
      appendTimelineText(state, assistant, Date.now());
      if (record) record.timeline = (state.timeline || []).slice(-100);
    }
    taskRunRuntime?.complete?.(sessionId, type, {
      evidenceGateAssessment,
      evidenceSummary: effectiveEvidenceSummary,
      fileChangeCount: record?.fileChanges?.length || 0,
      artifactCount: record?.artifacts?.length || 0,
    });
    if (record && state.taskRun) {
      record.meta = {
        ...(record.meta || {}),
        taskRun: compactTaskRun(state.taskRun),
      };
    }
    const meaningful = Boolean(
      assistant ||
      state.tools?.size ||
      record?.fileChanges?.length ||
      record?.resultBlocks?.length,
    );
    if (!meaningful) record = null;

    let committedMessageId = "";
    if (record) {
      if (assistant) {
        emit(sessionId, "assistant.final", {
          assistant,
          failed: type === "turn.failed",
          ...(payload.scheduledDraft ? { scheduledDraft: payload.scheduledDraft } : {}),
        });
      }
      try {
        const committed = turnArchive.commit(sessionId, record);
        committedMessageId = committed?.id || "";
      } catch (err) {
        log.warn("turn archive commit failed: %s", err?.message || err);
      }
    }
    state.terminalEmitted = true;
    emit(sessionId, type, {
      ...payload,
      assistant,
      record,
      messageId: committedMessageId,
      toolsSummary: { count: state.tools.size },
    });
    require("./public-hooks").observePublicTerminalHook(ctx, type, sessionId, completedTurnId, state, assistant);
    if (scheduledTaskRunId) {
      try {
        ctx.scheduledTaskManager?.completeRunById?.(scheduledTaskRunId, type, {
          ...payload,
          assistant,
        });
      } catch (err) {
        log.warn("scheduled task completeRun failed: %s", err?.message || err);
      }
    }
    subagentRuntime?.clearAllWatches?.(sessionId);
    // §11 P3-1: scene memory advances ONLY on a proven successful terminal.
    if (type === "turn.completed" && terminalPersisted) {
      try {
        require("./character-worlds/scene-memory").advanceMemoryOnCompleted(ctx, sessionId, state, completedTurnId);
      } catch (memoryErr) {
        log.warn("scene memory advance failed open: %s", memoryErr?.message || memoryErr);
      }
    }
    // §10.4.6 durable half: a turn's pending world-book checkpoint persists
    // ONLY on a proven successful terminal (turn.completed + winning CAS).
    if (type === "turn.completed" && terminalPersisted && state.pendingWorldBookCheckpoint) {
      try {
        const repository = ctx.characterWorldsRepository
          || ctx.sessionManager?._store?.()?.characterWorlds?.() || null;
        require("./character-worlds/turn-world-book").persistTurnWorldBookCheckpoint({
          repository, pending: { ...state.pendingWorldBookCheckpoint, sessionId }, log,
        });
      } catch (checkpointErr) {
        log.warn("world book checkpoint persist failed open: %s", checkpointErr?.message || checkpointErr);
      }
    }
    clearTurnState(state);

    if (triggerVerifyRetry || triggerDocumentVerifyRetry) {
      try {
        void attemptVerifyRetry(sessionId, {
          code: triggerDocumentVerifyRetry ? "DOCUMENT_DELIVERY_UNVERIFIED" : "EVIDENCE_UNVERIFIED",
          supersedesTurnId: completedTurnId,
          documentDelivery,
          evidenceReason: evidenceGateAssessment?.reason || "",
          verificationPlan,
          evidenceSummary: effectiveEvidenceSummary,
          evidenceRecoveryContext,
          userText: finalizerUserText,
        }).catch((err) => log.warn("evidence verify retry failed open: %s", err?.message || err));
      } catch (err) {
        log.warn("evidence verify retry dispatch failed open: %s", err?.message || err);
      }
    }
    if (type === "turn.completed") scheduleBackgroundCompaction(sessionId);
  }

  return { finalize };
}

module.exports = {
  clearTurnState,
  createTurnTerminalFinalizer,
};
