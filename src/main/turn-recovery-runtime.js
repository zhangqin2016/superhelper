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
const { turnReplayInput } = require("./turn-replay-input");

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
    now: options.now, setTimeout: options.setTimeout, clearTimeout: options.clearTimeout,
  });

  function stateFor(sessionId) {
    if (typeof getState !== "function") throw new Error("getState adapter is required");
    return getState(sessionId);
  }

  async function retryLastMessage(sessionId, retryOptions = {}) {
    const session = ctx.sessionManager?.findById?.(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const lastUser = ctx.sessionManager?.getLastUserMessage?.(sessionId);
    if (typeof sendUserMessage !== "function") return { ok: false, error: "SEND_UNAVAILABLE" };
    const sourceTurnId = retryOptions.sourceTurnId || lastUser?.turnId || lastUser?.record?.turnId || null;
    const sourceTurn = sourceTurnId
      ? ctx.sessionManager?.getTurnInputByTurnId?.(sessionId, sourceTurnId)
      : null;
    const explicitSource = Boolean(retryOptions.sourceTurnId);
    if (explicitSource && (!sourceTurn || sourceTurn.sessionId !== sessionId || sourceTurn.turnId !== sourceTurnId
      || typeof sourceTurn.userText !== "string" || !sourceTurn.userText.trim())) {
      return { ok: false, error: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" };
    }
    let replay = lastUser;
    if (sourceTurn) {
      try { replay = await turnReplayInput(ctx.sessionManager, sessionId, sourceTurn); }
      catch (error) {
        log.warn("retry source revisions unavailable: %s", error?.message || error);
        return { ok: false, error: "TASK_CONTINUATION_SOURCE_UNAVAILABLE" };
      }
    }
    if (!replay) return { ok: false, error: "NO_USER_MESSAGE" };
    if (!explicitSource) transcriptStore?.removeLastAssistantMessage?.(sessionId);
    const result = await sendUserMessage(sessionId, replay.content, replay.files || [], {
      recordUser: false,
      spawnEngine: true,
      ...retryOptions,
      sourceTurnId,
      sourceTaskCore: sourceTurn?.taskCore || null,
      // Only the explicit retry IPC renews authority. Internal self-heal uses
      // this same helper and must remain part of the original finite chain.
      newTaskAttempt: retryOptions.userInitiated === true,
    });
    if (result?.ok && explicitSource) {
      await transcriptStore?.supersedeAssistantTurn?.(sessionId, sourceTurnId, result.turnId);
      emit(sessionId, "assistant.supersedes", { supersedes: sourceTurnId }, { turnId: sourceTurnId });
    }
    return result;
  }

  // In-pool failover (auto mode only). When the model that ran fails for a
  // model-attributable reason, re-run the turn on ANOTHER model the user
  // selected. The escaped model is excluded EXPLICITLY (avoidModelIds), never by
  // inference — the 2026-09-27 field loop re-sent 13 times to the same dead model
  // because the retry re-pinned the source turn's model. Hard-bounded per session
  // (FAILOVER_MAX within FAILOVER_WINDOW_MS), only on side-effect-free turns, only
  // while a selected, unmarked alternative exists, and never after the user
  // switched to a manual pick. Kill switch: LILY_MODEL_HEALTH_ROUTING=0.
  const FAILOVER_MAX = 3;
  const FAILOVER_WINDOW_MS = 10 * 60_000;
  const failoverBudget = new Map(); // sessionId -> { count, avoid:Set, resetAt }
  async function maybeFailoverToHealthyPoolModel(sessionId, failure) {
    try {
      if (process.env.LILY_MODEL_HEALTH_ROUTING === "0") return false;
      const availability = require("./model-availability");
      if (!availability.isModelAttributableFailure(failure?.code)) return false;
      const route = failure?.modelRoute || null;
      if (!route || route.mode !== "auto" || !route.selectionId) return false;
      const failedId = String(route.selectionId);
      availability.noteModelFailure({ providerID: route.providerId || "", modelID: route.modelId || "" }, { code: failure.code });
      const catalog = require("./model-selection-catalog");
      const current = catalog.getSessionModelSelection?.(sessionId);
      if (current && current.mode !== "auto") return false;
      const now = Date.now();
      let budget = failoverBudget.get(sessionId);
      if (!budget || now > budget.resetAt) budget = { count: 0, avoid: new Set(), resetAt: now + FAILOVER_WINDOW_MS };
      if (budget.count >= FAILOVER_MAX) { log.info("model failover budget exhausted: session=%s", sessionId); return false; }
      // We already escaped this model once in the window and a turn landed on it
      // again: the escape did not hold, so another replay would only repeat it.
      if (budget.avoid.has(failedId)) { log.warn("model failover stopped: %s failed again after being escaped (session=%s)", failedId, sessionId); return false; }
      const avoid = new Set([...budget.avoid, failedId]);
      const pub = catalog.listModelSelectionPublic(sessionId);
      const pool = new Set(pub?.selection?.autoModelIds || []);
      const alternatives = (pub?.models || []).filter((m) => pool.has(m.id) && !avoid.has(m.id) && !m.unavailable && m.capabilities?.toolCall !== false);
      if (!alternatives.length) return false;
      const state = stateFor(sessionId);
      if (state.turnId || state.queue.length) return false;
      if (ctx.runnerPool?.get?.(sessionId)?.isBusy?.()) return false;
      const { isSideEffectFreeToolRun } = require("./tool-call-rescue");
      if (!isSideEffectFreeToolRun([...(state.tools?.values?.() || [])])) {
        log.info("model failover retry skipped (non-read-only tools ran): session=%s", sessionId);
        return false;
      }
      budget.count += 1; budget.avoid = avoid; failoverBudget.set(sessionId, budget);
      require("./runner-live-config").terminateIdleRunners(ctx.runnerPool);
      log.info("model failover retry: session=%s from=%s avoid=%s attempt=%d/%d code=%s", sessionId, failedId, [...avoid].join(","), budget.count, FAILOVER_MAX, failure.code);
      const retried = await retryLastMessage(sessionId, { sourceTurnId: failure?.sourceTurnId || failure?.supersedesTurnId, avoidModelIds: [...avoid] });
      if (!retried?.ok) { log.warn("model failover retry not sent: %s", retried?.error || "unknown"); return false; }
      // Emit against the NEW turn so the renderer shows it (an emit before the
      // retry turn exists is dropped as an orphan).
      emit(sessionId, "turn.model_failover", { fromModelId: failedId, errorCode: failure.code || "", attempt: budget.count }, retried.turnId ? { turnId: retried.turnId } : undefined);
      return true;
    } catch (err) {
      log.warn("model failover failed open: %s", err?.message || err);
      return false;
    }
  }

  async function maybeSelfHealAndRetry(sessionId, failure) {
    // An overflow is not retryable as such, but once the session has kept its
    // conversation and recorded it, a retry is exactly what compacts it away.
    if (failure?.code === "CONTEXT_LIMIT" && require("./context-overflow-recovery").retryReady(sessionId)) {
      failure = { ...failure, retryable: true };
    }
    if (failure?.retryable === false) return;
    try {
      if (await maybeFailoverToHealthyPoolModel(sessionId, failure)) return;
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
      const retried = await retryLastMessage(sessionId, { sourceTurnId: failure?.sourceTurnId || failure?.supersedesTurnId });
      if (!retried?.ok) log.warn("model self-heal retry not sent: %s", retried?.error || "unknown");
    } catch (err) {
      log.warn("model self-heal failed open: %s", err?.message || err);
    }
  }

  async function maybeToolCallRescueRetry(sessionId, failure) {
    if (failure?.retryable === false) return false;
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
      // LILY_DELIVERY_CHECK_CONTINUES=0: the check replaces the answer, as before 2026-09-30.
      const continuesAnswer = strategy.kind === "document_verify_retry" && process.env.LILY_DELIVERY_CHECK_CONTINUES !== "0";
      const documentRecovery = strategy.kind === "document_verify_retry"
        ? prepareDocumentDeliveryRecovery(failure, { onlyPending: continuesAnswer })
        : null;
      if (strategy.kind === "document_verify_retry" && !documentRecovery) return false;
      const checkContinues = Boolean(documentRecovery) && continuesAnswer;
      const ranTools = [...(state.tools?.values?.() || [])];
      // A leaked tool call on a turn that already had side effects used to get
      // no rescue at all: replay would re-run the edits, so the guard refused
      // and the user saw the raw failure. Continue the same session instead —
      // nothing is re-done, only the missing next action is asked for.
      const continueInstead = !documentRecovery
        && rescue.shouldContinueInsteadOfReplay(failure?.code, ranTools);
      if (!documentRecovery && !continueInstead && !rescue.isSideEffectFreeToolRun(ranTools)) return false;
      const sourceTurnId = failure?.supersedesTurnId || failure?.sourceTurnId || null;
      const sourceTurn = sourceTurnId
        ? ctx.sessionManager?.getTurnInputByTurnId?.(sessionId, sourceTurnId)
        : null;
      if (failure?.sourceTurnId && (!sourceTurn || sourceTurn.sessionId !== sessionId
        || sourceTurn.turnId !== sourceTurnId || typeof sourceTurn.userText !== "string" || !sourceTurn.userText.trim())) return false;
      const lastUser = documentRecovery || continueInstead
        ? null
        : sourceTurn && failure?.sourceTurnId
          ? await turnReplayInput(ctx.sessionManager, sessionId, sourceTurn)
        : ctx.sessionManager?.getLastUserMessage?.(sessionId);
      if (!documentRecovery && !continueInstead && !lastUser) return false;
      rescue.markRescueAttempt(sessionId, failure.code);
      log.info(
        "turn rescue retry: session=%s kind=%s mode=%s",
        sessionId,
        strategy.kind,
        continueInstead ? "continuation" : "replay",
      );
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

      const deferAssistantRemoval = strategy.kind === "evidence_verify_retry"
        || strategy.kind === "source_coverage_retry" || documentRecovery || sourceTurnId;
      if (!deferAssistantRemoval) transcriptStore?.removeLastAssistantMessage?.(sessionId);
      const content = documentRecovery
        ? documentRecovery.content
        : strategy.kind === "source_coverage_retry"
          ? rescue.sourceCoverageHintFor(modelRecipes(), {
              observed: failure?.sourceCoverage?.observed,
              total: failure?.sourceCoverage?.total,
              truncated: failure?.sourceCoverage?.truncated === true,
            })
          : continueInstead
            ? rescue.continuationHintFor(modelRecipes())
            : String(lastUser.content || "").trim();
      const replaySourceTurnId = sourceTurnId
        || lastUser?.turnId
        || lastUser?.record?.turnId
        || null;
      const replaySource = sourceTurn || (replaySourceTurnId
        ? ctx.sessionManager?.getTurnInputByTurnId?.(sessionId, replaySourceTurnId) : null);
      const recipes = modelRecipes();
      // A strategy that knows what it needs says so, even when continuing: the
      // generic continuation hint would tell a coverage round only to "carry on",
      // losing the one instruction that makes it useful — read the REMAINDER.
      const hint = strategy.kind === "source_coverage_retry"
        ? rescue.sourceCoverageHintFor(recipes, {
            observed: failure?.sourceCoverage?.observed,
            total: failure?.sourceCoverage?.total,
            truncated: failure?.sourceCoverage?.truncated === true,
          })
        : continueInstead
        ? rescue.continuationHintFor(recipes)
        : strategy.kind === "tool_call_rescue"
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
          documentRecovery || continueInstead ? [] : (lastUser.files || []),
        {
          recordUser: false,
          spawnEngine: true,
          rescueAttempt: true,
          skipPreflight: !strategy.preflight,
          expectedArtifactPaths: documentRecovery?.paths || [],
          documentDeliveryRecovery: Boolean(documentRecovery),
          continuesTurnId: checkContinues ? sourceTurnId || "" : "",
          sourceTurnId: replaySourceTurnId,
          sourceTaskCore: replaySource?.taskCore || null,
          recovery: {
            kind: strategy.kind,
            mode: continueInstead ? "continuation" : "replay",
            // Only a replay sends the user's own words; any other `content` is
            // the platform's, so the turn carries the user's request forward.
            objective: lastUser ? ""
              : String(sourceTurn?.userText || ctx.sessionManager?.getLastUserMessage?.(sessionId)?.content || "").trim(),
            guidance: hint || "",
            evidenceContext: strategy.kind === "evidence_verify_retry" || strategy.kind === "source_coverage_retry"
              ? failure?.evidenceRecoveryContext || null
              : null,
          },
        },
      );
      if (!retried?.ok) log.warn("turn rescue retry not sent: %s", retried?.error || "unknown");
      // A delivery check continues the answer it checks; everything else replaces its answer.
      if (retried?.ok && deferAssistantRemoval && !checkContinues) {
        let superseded = null;
        try {
          superseded = await transcriptStore?.supersedeAssistantTurn?.(
            sessionId,
            sourceTurnId,
            retried.turnId,
          );
        } catch {
          superseded = null;
        }
        if (!superseded && !sourceTurnId) transcriptStore?.removeLastAssistantMessage?.(sessionId);
        if (sourceTurnId) {
          emit(sessionId, "assistant.supersedes", { supersedes: sourceTurnId }, {
            turnId: sourceTurnId,
          });
        }
      }
      return true;
    } catch (err) {
      log.warn("turn rescue failed open: %s", err?.message || err);
      return false;
    }
  }

  async function afterParentClosureTerminal(sessionId, source, { failed = false, failure = null, selfHeal, afterFinalize, suppressRecovery = false } = {}) {
    let parentClosure = { attempted: false };
    if (source && !suppressRecovery) parentClosure = await parentClosureRuntime.maybeParentClosureRecovery(sessionId, source);
    if (!suppressRecovery && !parentClosure.attempted && failed && typeof selfHeal === "function") {
      await selfHeal(sessionId, { ...failure, sourceTurnId: failure?.sourceTurnId || source?.state?.turnId });
    }
    if (typeof afterFinalize === "function") afterFinalize(sessionId);
    return parentClosure;
  }

  /** Blame-free "we already retried N times" suffix for the terminal copy. */
  // The rescue that ran says what kind of problem it was. A model slip (a
  // leaked tool call) is not an outage, and "服务恢复后" sent the user waiting
  // for nothing; every other failure keeps the service wording.
  function rescueRetryNotice(sessionId, wasRescueAttempt, code = "") {
    if (!wasRescueAttempt) return "";
    const rescue = require("./tool-call-rescue");
    const attempts = Math.max(1, rescue.rescueAttemptCount(sessionId));
    if (rescue.rescueStrategyFor(code)?.contextOverflow) {
      return "\n\n（对话已超过该模型的上下文窗口，平台压缩后重试仍未成功。可以新开对话继续，或在设置里确认该模型的上下文窗口。）";
    }
    if (rescue.rescueStrategyFor(code)?.modelOutputSlip) {
      return `\n\n（平台已自动修复重试 ${attempts} 次仍未恢复。已完成的步骤都已保留，发送“继续”即可接着做。）`;
    }
    return `\n\n（平台已自动修复重试 ${attempts} 次仍未恢复，判定为持续性故障。服务恢复后可随时继续。）`;
  }

  return {
    disposeParentClosureRecovery: parentClosureRuntime.dispose,
    cancelPendingParentClosures: parentClosureRuntime.cancelPendingParentClosures,
    maybeSelfHealAndRetry,
    maybeParentClosureRecovery: parentClosureRuntime.maybeParentClosureRecovery,
    recoverySourceForTurn: parentClosureRuntime.recoverySourceForTurn,
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
