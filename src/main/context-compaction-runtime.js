"use strict";

const {
  decideBackgroundCompaction,
  decidePreTurnCompaction,
  estimateTokensForText,
} = require("./context-budget-manager");
const { getLogger } = require("./logger");
const { OPENCODE_RUNTIME_CAPABILITIES } = require("./runtime/runtime-capabilities");
const { markSessionCompactionFailed, readSessionSummary, writeSessionSummary } = require("./session-memory");

const log = getLogger("context-compaction-runtime");

function compactOptions(model, reason) {
  return {
    ...(model?.providerID && model?.modelID
      ? { providerID: model.providerID, modelID: model.modelID }
      : {}),
    auto: true,
    reason,
  };
}

function failureNotice(detail = "Conversation memory maintenance was skipped after a runtime error. The current chat can continue.") {
  return {
    notice: {
      code: "compactFailed",
      level: "info",
      panel: true,
      done: true,
      replace: true,
      replacesCode: "compactBoundary",
      detail,
    },
  };
}

function recordFalseCompaction(sessionId, sessionSummary, decision, model) {
  const afterSummary = readSessionSummary(sessionId) || {};
  if ((afterSummary.lastCompactionFailedAt || "") !== (sessionSummary.lastCompactionFailedAt || "")) return;
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

function createContextCompactionRuntime(options = {}) {
  const ctx = options.ctx || {};
  const emit = options.emit || (() => null);
  const scheduleTimer = options.setTimeout || setTimeout;

  async function maybeCompactBeforeTurn(sessionId, runner, enginePayload = {}, characterWorldsSnapshot = null) {
    try {
      if (!runner?.compactContext) return { action: "skip", reason: "adapter_missing_compaction" };
      const sessionSummary = readSessionSummary(sessionId) || {};
      // §10.5: record the CURRENT active binding (metadata-only) so the
      // compaction summary distinguishes it from historical roles — the
      // section is whitelist-guarded and never carries card instructions.
      if (characterWorldsSnapshot && typeof characterWorldsSnapshot === "object") {
        const cw = require("./character-worlds/compaction");
        const section = cw.characterWorldsSummarySection(characterWorldsSnapshot);
        if (section) {
          const prior = sessionSummary.characterWorlds;
          if (
            !prior ||
            prior.characterRevisionId !== section.characterRevisionId ||
            prior.bindingVersion !== section.bindingVersion ||
            prior.personaRevisionId !== section.personaRevisionId
          ) {
            writeSessionSummary(sessionId, { ...sessionSummary, characterWorlds: section });
          }
        }
      }
      const model = enginePayload?.model || runner.spawnOptions?.model || null;
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
      emit(sessionId, "context.compactionDecision", event, { turnId: null });
      if (decision.action !== "compact") return event;

      emit(sessionId, "engine.notice", {
        notice: {
          code: "compactBoundary",
          level: "progress",
          panel: true,
          done: false,
          detail: "Preparing to compact conversation context before this turn.",
        },
      }, { turnId: null });
      const compacted = await runner.compactContext(compactOptions(model, decision.reason));
      if (!compacted) {
        recordFalseCompaction(sessionId, sessionSummary, decision, model);
        emit(sessionId, "engine.notice", failureNotice(), { turnId: null });
        return { ...event, compacted: false };
      }
      emit(sessionId, "engine.notice", {
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
      log.warn("pre-turn context compaction failed open: %s", err?.message || err);
      return {
        action: "skip",
        reason: "pre_turn_compaction_exception",
        error: err?.message || String(err),
      };
    }
  }

  async function runBackgroundCompaction(sessionId) {
    try {
      const runner = ctx.runnerPool?.get?.(sessionId);
      if (!runner?.compactContext) {
        emit(sessionId, "context.compactionDecision", {
          action: "skip",
          reason: "adapter_missing_compaction",
        }, { turnId: null });
        return;
      }
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
      emit(sessionId, "context.compactionDecision", {
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

      emit(sessionId, "engine.notice", {
        notice: {
          code: "compactBoundary",
          level: "progress",
          panel: true,
          done: false,
          detail: "Preparing to compact conversation context.",
        },
      }, { turnId: null });
      const compacted = await runner.compactContext(compactOptions(model, decision.reason));
      if (!compacted) {
        recordFalseCompaction(sessionId, sessionSummary, decision, model);
        emit(sessionId, "engine.notice", failureNotice(), { turnId: null });
      }
    } catch (err) {
      log.warn("background context compaction failed: %s", err?.message || err);
      try {
        markSessionCompactionFailed(sessionId, {
          runtime: "opencode",
          mode: "native",
          reason: "background_compaction_exception",
          code: err?.name || "exception",
          error: err?.message || String(err),
        });
      } catch (memoryErr) {
        log.warn("background compaction failure memory update failed: %s", memoryErr?.message || memoryErr);
      }
      emit(sessionId, "engine.notice", failureNotice(), { turnId: null });
    }
  }

  function scheduleBackgroundCompaction(sessionId) {
    const timer = scheduleTimer(() => void runBackgroundCompaction(sessionId), 0);
    timer?.unref?.();
  }

  return {
    maybeCompactBeforeTurn,
    runBackgroundCompaction,
    scheduleBackgroundCompaction,
  };
}

module.exports = {
  createContextCompactionRuntime,
  failureNotice,
};
