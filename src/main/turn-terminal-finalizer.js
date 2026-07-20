"use strict";

const { evaluateAnswerEvidenceWithJudge, shouldBufferAssistantAnswer } = require("./answer-evidence-finalizer");
const { clearDocumentDeliveryTurnState } = require("./document-delivery-turn");
const { getLogger } = require("./logger");
const { compactTaskRun } = require("./task-run-state");
const { buildEvidenceRecoveryContext } = require("./turn-recovery-context");
const { TERMINAL_TYPES } = require("./turn-event-types");
const {
  appendTimelineNotice,
  appendTimelineText,
  closeStreamingBlocks,
  resetTimelineState,
  upsertTimelineTool,
} = require("./turn-timeline");

const log = getLogger("turn-terminal-finalizer");
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
    try {
      ctx.sessionManager?.markTurnInputTerminal?.(completedTurnId, type, {
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
    if (type === "turn.completed") collectLearnedSkills(ctx, sessionId, state);
    closeStreamingBlocks(state, Date.now());

    let assistant = String(payload.assistant || state.assistantText || "").trim();
    const finalizerUserText = String(state.enginePayload?.rawText || "");
    const evidenceTools = [
      ...(Array.isArray(state.inheritedEvidenceTools) ? state.inheritedEvidenceTools : []),
      ...(state.tools?.values?.() || []),
    ];
    const evidenceSummary = state.evidenceLedger?.summary?.() || null;
    const verificationPlan = state.taskContract?.externalFactPolicy?.verificationPlan || null;
    let effectiveEvidenceSummary = evidenceSummary;
    let record = turnArchive?.buildRecord(state, type, { ...payload, assistant });
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
    if (scheduledTaskRunId) {
      try {
        ctx.scheduledTaskManager?.completeRun?.(sessionId, completedTurnId, type, payload);
      } catch (err) {
        log.warn("scheduled task completeRun failed: %s", err?.message || err);
      }
    }
    subagentRuntime?.clearAllWatches?.(sessionId);
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
