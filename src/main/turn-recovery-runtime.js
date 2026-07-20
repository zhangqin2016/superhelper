"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sessionGuideDir } = require("./config");
const { appendLargeInputProtocolGuidance } = require("./large-input-protocol");
const { getLogger } = require("./logger");
const { appendProcessJobProtocolGuidance } = require("./process-job-protocol");
const { prepareDocumentDeliveryRecovery } = require("./document-delivery-turn");

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
  const sendUserMessage = options.sendUserMessage;
  const attemptRescue = options.attemptRescue;
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  function stateFor(sessionId) {
    if (typeof getState !== "function") throw new Error("getState adapter is required");
    return getState(sessionId);
  }

  async function retryLastMessage(sessionId) {
    const session = ctx.sessionManager?.findById?.(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const lastUser = ctx.sessionManager?.getLastUserMessage?.(sessionId);
    if (!lastUser) return { ok: false, error: "NO_USER_MESSAGE" };
    transcriptStore?.removeLastAssistantMessage?.(sessionId);
    if (typeof sendUserMessage !== "function") return { ok: false, error: "SEND_UNAVAILABLE" };
    return sendUserMessage(sessionId, lastUser.content, lastUser.files || [], {
      recordUser: false,
      spawnEngine: true,
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
      if (stateFor(sessionId).wasRescueAttempt) return false;
      if (!rescue.shouldAttemptRescue(sessionId, failure.code)) return false;
      if (strategy.delayMs > 0) await sleep(strategy.delayMs);

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

  return {
    maybeSelfHealAndRetry,
    maybeToolCallRescueRetry,
    retryLastMessage,
  };
}

module.exports = {
  createTurnRecoveryRuntime,
  modelRecipes,
  selfHealProbeText,
};
