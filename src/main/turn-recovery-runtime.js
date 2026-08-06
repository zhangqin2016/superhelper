"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sessionGuideDir } = require("./config");
const { appendLargeInputProtocolGuidance } = require("./large-input-protocol");
const { getLogger } = require("./logger");
const { appendProcessJobProtocolGuidance } = require("./process-job-protocol");
const { prepareDocumentDeliveryRecovery } = require("./document-delivery-turn");
const { createParentClosureRecoveryRuntime } = require("./parent-closure-recovery-runtime");

const log = getLogger("turn-recovery-runtime");

function modelRecipes() {
  try {
    return JSON.parse(require("./spawn-env").resolveLilyEnv().LILY_MODEL_RECIPES || "{}") || {};
  } catch {
    return {};
  }
}

function selfHealProbeText(sessionId) {
  try {
    const guide = path.join(sessionGuideDir(sessionId), "AGENT.md");
    const base = fs.existsSync(guide) ? fs.readFileSync(guide, "utf8") : "";
    if (!base.trim()) return "";
    return appendProcessJobProtocolGuidance(appendLargeInputProtocolGuidance(base));
  } catch {
    return "";
  }
}

function createTurnRecoveryRuntime(options = {}) {
  const ctx = options.ctx || {};
  const transcriptStore = options.transcriptStore;
  const getState = options.getState;
  const emit = options.emit || (() => null);
  const emitNotice = options.emitNotice || null;
  const sendUserMessage = options.sendUserMessage;
  const attemptRescue = options.attemptRescue;
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const parentClosureRuntime = createParentClosureRecoveryRuntime({
    ctx,
    emit,
    emitNotice,
    sendUserMessage,
    parentClosureLedger: options.parentClosureLedger,
  });

  function stateFor(sessionId) {
    if (typeof getState !== "function") throw new Error("getState adapter is required");
    return getState(sessionId);
  }

  async function retryLastMessage(sessionId, retryOptions = {}) {
    const session = ctx.sessionManager?.findById?.(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const lastUser = ctx.sessionManager?.getLastUserMessage?.(sessionId);
    if (!lastUser) return { ok: false, error: "NO_USER_MESSAGE" };
    transcriptStore?.removeLastAssistantMessage?.(sessionId);
    if (typeof sendUserMessage !== "function") return { ok: false, error: "SEND_UNAVAILABLE" };
    const sourceTurnId = lastUser.turnId || lastUser.record?.turnId || null;
    const sourceTurn = sourceTurnId
      ? ctx.sessionManager?.getTurnInputByTurnId?.(sessionId, sourceTurnId)
      : null;
    return sendUserMessage(sessionId, lastUser.content, lastUser.files || [], {
      recordUser: false,
      spawnEngine: true,
      sourceTurnId,
      sourceTaskCore: sourceTurn?.taskCore || null,
      ...retryOptions,
    });
  }

  async function maybeSelfHealAndRetry(sessionId, failure) {
    try {
      if (typeof attemptRescue === "function" && await attemptRescue(sessionId, failure)) return;
      const { attemptModelSelfHeal, isHealableFailureCode } = require("./model-self-heal");
      if (!isHealableFailureCode(failure?.code)) return;
      const result = await attemptModelSelfHeal({
        code: failure.code,
        systemPromptProbeText: selfHealProbeText(sessionId),
      });
      if (result?.attempted && !result.healed) {
        emit(sessionId, "turn.self_heal_notice", {
          kind: "probe_no_change",
          errorCode: failure?.code || "",
        });
      }
      if (!result?.healed) return;
      const state = stateFor(sessionId);
      if (state.turnId || state.queue.length) return;
      if (ctx.runnerPool?.get?.(sessionId)?.isBusy?.()) return;
      const { isSideEffectFreeToolRun } = require("./tool-call-rescue");
      if (!isSideEffectFreeToolRun([...(state.tools?.values?.() || [])])) {
        log.info("model self-heal retry skipped (non-read-only tools ran): session=%s", sessionId);
        return;
      }
      require("./runner-live-config").terminateIdleRunners(ctx.runnerPool);
      log.info("model self-heal retry: session=%s code=%s", sessionId, failure.code);
      emit(sessionId, "turn.self_heal_retry", { errorCode: failure.code });
      const retried = await retryLastMessage(sessionId);
      if (!retried?.ok) log.warn("model self-heal retry not sent: %s", retried?.error || "unknown");
    } catch (err) {
      log.warn("model self-heal failed open: %s", err?.message || err);
    }
  }

  async function maybeToolCallRescueRetry(sessionId, failure) {
    try {
      const rescue = require("./tool-call-rescue");
      const strategy = rescue.rescueStrategyFor(failure?.code);
      if (!strategy) return false;
      const maxAttempts = Number(strategy.maxAttempts) || 1;
      // Single-attempt strategies keep the original no-chaining guard;
      // multi-attempt strategies (model_connection_retry) may chain while
      // their per-episode budget lasts — shouldAttemptRescue enforces it.
      if (maxAttempts <= 1 && stateFor(sessionId).wasRescueAttempt) return false;
      // LILY_RESCUE_DELAY_MS overrides the strategy delay (tests / ops tuning).
      const delayMs = Number(process.env.LILY_RESCUE_DELAY_MS) || strategy.delayMs;
      // The double-fire debounce must stay below the chain spacing: a fast-
      // failing retried turn would otherwise eat the 5s default and never
      // earn its next budgeted attempt. Same-failure double-fire arrives
      // within milliseconds, so half the chain delay still catches it.
      const debounceMs = maxAttempts > 1 ? Math.max(1, Math.floor(delayMs / 2)) : undefined;
      if (!rescue.shouldAttemptRescue(sessionId, failure.code, Date.now(), maxAttempts, debounceMs)) return false;
      if (delayMs > 0) await sleep(delayMs);

      const state = stateFor(sessionId);
      if (state.turnId || state.queue.length) return false;
      if (ctx.runnerPool?.get?.(sessionId)?.isBusy?.()) return false;
      const documentRecovery = strategy.kind === "document_verify_retry"
        ? prepareDocumentDeliveryRecovery(failure)
        : null;
      if (strategy.kind === "document_verify_retry" && !documentRecovery) return false;
      if (!documentRecovery && !rescue.isSideEffectFreeToolRun([...(state.tools?.values?.() || [])])) return false;
      const lastUser = documentRecovery ? null : ctx.sessionManager?.getLastUserMessage?.(sessionId);
      if (!documentRecovery && !lastUser) return false;
      rescue.markRescueAttempt(sessionId, failure.code);
      log.info("turn rescue retry: session=%s kind=%s", sessionId, strategy.kind);
      emit(sessionId, "turn.self_heal_retry", { errorCode: failure.code, kind: strategy.kind });
      if (strategy.kind === "model_connection_retry") {
        // Hot-refresh the model env (managed config, active preset, keys)
        // before the retry — a stale route is a common cause of repeated
        // connection failures and the refresh costs nothing when current.
        try {
          const liveConfig = require("./runner-live-config");
          liveConfig.applyLiveEnvToPool(ctx.runnerPool, liveConfig.buildLiveEngineEnvPatch());
        } catch (refreshErr) {
          log.warn("model connection env refresh failed open: %s", refreshErr?.message || refreshErr);
        }
      }
      if (strategy.recycleEngine) {
        try {
          ctx.runnerPool?.get?.(sessionId)?.recycleIdleEngine?.("turn_rescue");
        } catch {
          // A plain same-runner retry preserves the previous fallback.
        }
      }

      const deferAssistantRemoval = strategy.kind === "evidence_verify_retry" || documentRecovery;
      if (!deferAssistantRemoval) transcriptStore?.removeLastAssistantMessage?.(sessionId);
      const content = documentRecovery
        ? documentRecovery.content
        : String(lastUser.content || "").trim();
      const sourceTurnId = failure?.supersedesTurnId
        || lastUser?.turnId
        || lastUser?.record?.turnId
        || null;
      const sourceTurn = sourceTurnId
        ? ctx.sessionManager?.getTurnInputByTurnId?.(sessionId, sourceTurnId)
        : null;
      const recipes = modelRecipes();
      const hint = strategy.kind === "tool_call_rescue"
        ? rescue.correctiveHintFor(recipes)
        : strategy.kind === "evidence_verify_retry"
          ? rescue.evidenceVerifyHintFor(recipes, {
              reason: failure?.evidenceReason,
              verificationPlan: failure?.verificationPlan,
              evidenceSummary: failure?.evidenceSummary,
            })
          : strategy.hint;
      if (typeof sendUserMessage !== "function") return false;
      const retried = await sendUserMessage(
        sessionId,
        content,
        documentRecovery ? [] : (lastUser.files || []),
        {
          recordUser: false,
          spawnEngine: true,
          rescueAttempt: true,
          skipPreflight: !strategy.preflight,
          expectedArtifactPaths: documentRecovery?.paths || [],
          documentDeliveryRecovery: Boolean(documentRecovery),
          sourceTurnId,
          sourceTaskCore: sourceTurn?.taskCore || null,
          recovery: {
            kind: strategy.kind,
            guidance: hint || "",
            evidenceContext: strategy.kind === "evidence_verify_retry"
              ? failure?.evidenceRecoveryContext || null
              : null,
          },
        },
      );
      if (!retried?.ok) log.warn("turn rescue retry not sent: %s", retried?.error || "unknown");
      if (retried?.ok && deferAssistantRemoval) {
        let superseded = null;
        try {
          superseded = transcriptStore?.supersedeAssistantTurn?.(
            sessionId,
            failure?.supersedesTurnId,
            retried.turnId,
          );
        } catch {
          superseded = null;
        }
        if (!superseded) transcriptStore?.removeLastAssistantMessage?.(sessionId);
        if (failure?.supersedesTurnId) {
          emit(sessionId, "assistant.supersedes", { supersedes: failure.supersedesTurnId }, {
            turnId: failure.supersedesTurnId,
          });
        }
      }
      return true;
    } catch (err) {
      log.warn("turn rescue failed open: %s", err?.message || err);
      return false;
    }
  }

  async function afterParentClosureTerminal(sessionId, source, { failed = false, failure = null, selfHeal, afterFinalize } = {}) {
    let parentClosure = { attempted: false };
    if (source) parentClosure = await parentClosureRuntime.maybeParentClosureRecovery(sessionId, source);
    if (!parentClosure.attempted && failed && typeof selfHeal === "function") await selfHeal(sessionId, failure);
    if (typeof afterFinalize === "function") afterFinalize(sessionId);
    return parentClosure;
  }

  /** Blame-free "we already retried N times" suffix for the terminal copy. */
  function rescueRetryNotice(sessionId, wasRescueAttempt) {
    if (!wasRescueAttempt) return "";
    const attempts = Math.max(1, require("./tool-call-rescue").rescueAttemptCount(sessionId));
    return `\n\n（平台已自动修复重试 ${attempts} 次仍未恢复，判定为持续性故障。服务恢复后可随时继续。）`;
  }

  return {
    maybeSelfHealAndRetry,
    maybeParentClosureRecovery: parentClosureRuntime.maybeParentClosureRecovery,
    prepareParentClosureRecovery: parentClosureRuntime.prepareParentClosureRecovery,
    resumePendingParentClosures: parentClosureRuntime.resumePendingParentClosures,
    resumePendingParentClosuresForSessions: parentClosureRuntime.resumePendingParentClosuresForSessions,
    afterParentClosureTerminal,
    maybeToolCallRescueRetry,
    rescueRetryNotice,
    retryLastMessage,
  };
}

module.exports = {
  createTurnRecoveryRuntime,
  modelRecipes,
  selfHealProbeText,
};
