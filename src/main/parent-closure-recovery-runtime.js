"use strict";

const crypto = require("node:crypto");
const { getLogger } = require("./logger");
const {
  buildParentClosurePrompt,
  createParentClosureLedger,
  shouldRecoverParentClosure,
} = require("./parent-task-closure");

const log = getLogger("parent-closure-recovery-runtime");

function persistedSource(source = {}, evidence = {}) {
  return {
    objective: String(source.objective || source.state?.enginePayload?.rawText || "").trim(),
    files: Array.isArray(source.files) ? source.files.slice(0, 64) : [],
    taskContract: source.taskContract || null,
    continuationHandoff: source.payload?.continuationHandoff || null,
    workState: source.workState || null,
    executionProgressKeys: source.payload?.executionProgressKeys || [],
    // The immutable task core remains in turn_inputs. Persist only its
    // identity here; restart recovery rehydrates the full envelope by source
    // turn id instead of duplicating a potentially large context snapshot.
    taskCoreFingerprint: source.taskCore?.fingerprint || "",
    evidence: {
      done: Array.isArray(evidence.done) ? evidence.done.slice(-32) : [],
      failed: Array.isArray(evidence.failed) ? evidence.failed.slice(-32) : [],
      running: Array.isArray(evidence.running) ? evidence.running.slice(-32) : [],
    },
  };
}

function createParentClosureRecoveryRuntime(options = {}) {
  const ctx = options.ctx || {};
  const emit = options.emit || (() => null);
  const emitNotice = options.emitNotice || null;
  // Readiness probe for the model-silent lane (injectable for tests).
  const probeModelReady = typeof options.probeModelReady === "function"
    ? options.probeModelReady
    : (input) => require("./model-ping").pingModel(input);
  const modelWatchKey = (sessionId) => `parent-closure:${sessionId}`;
  const sendUserMessage = options.sendUserMessage;
  const ledger = options.parentClosureLedger || createParentClosureLedger();
  const now = options.now || Date.now;
  const schedule = options.setTimeout || setTimeout;
  const unschedule = options.clearTimeout || clearTimeout;
  const leases = new Map();
  const retryCounts = new Map();
  const generations = new Map();
  let disposed = false;

  function clearLease(sessionId) {
    const lease = leases.get(sessionId);
    if (lease) unschedule(lease.timer);
    leases.delete(sessionId);
  }

  function cancelPendingParentClosures(sessionId, options = {}) {
    generations.set(sessionId, (generations.get(sessionId) || 0) + 1);
    clearLease(sessionId);
    try { require("./model-recovery-watch").cancelModelRecoveryWatch(modelWatchKey(sessionId)); } catch { /* optional */ }
    try { ctx.sessionManager?.cancelPendingParentClosureRecoveries?.(sessionId, options); }
    catch (err) { log.warn("parent closure cancellation failed: %s", err?.message || err); }
  }

  function dispose() {
    disposed = true;
    for (const sessionId of leases.keys()) clearLease(sessionId);
    retryCounts.clear();
    generations.clear();
  }

  function scheduleFutureClaims(sessionId) {
    if (disposed) return;
    const manager = ctx.sessionManager;
    const candidate = manager?.listFutureParentClosureRecoveries?.(sessionId, now())?.[0];
    const prior = leases.get(sessionId);
    if (prior?.expiresAt === candidate?.claimExpiresAt && prior?.ownerScope === candidate?.ownerScope) return;
    // A live send may finish after expiry. A scan's final future-only refresh
    // must not erase its separately scheduled, still-authoritative reconciliation.
    if (!candidate && prior?.reconcileSourceTurnId
      && manager?.getParentClosureRecovery?.(sessionId, prior.reconcileSourceTurnId)?.status === "claimed") return;
    clearLease(sessionId);
    if (!candidate) return;
    armLease(sessionId, { expiresAt: candidate.claimExpiresAt, ownerScope: candidate.ownerScope });
  }

  function armLease(sessionId, lease) {
    const manager = ctx.sessionManager;
    lease.generation = generations.get(sessionId) || 0;
    leases.set(sessionId, lease);
    lease.timer = schedule(async () => {
      if (disposed || leases.get(sessionId) !== lease) return;
      leases.delete(sessionId);
      try {
        const owner = manager.resolveTurnOwnerScope?.(sessionId)?.ownerScope;
        if (owner !== lease.ownerScope || !manager._find?.(sessionId)) return;
        await resumePendingParentClosures(sessionId, lease);
      }
      catch (err) { log.warn("parent closure lease resume failed: %s", err?.message || err); }
    }, Math.max(0, lease.expiresAt - now()));
    lease.timer?.unref?.();
  }

  function commitNotice(sessionId, sourceTurnId, reason, info = {}) {
    return require("./parent-closure-notice").commitParentClosureNotice(ctx, sessionId, { sourceTurnId, reason, info });
  }

  // A cut-off long task (stalled / step budget / silent model) that the gate
  // refuses to continue must say so in the conversation, not vanish.
  // Only a turn that stopped WITHOUT already explaining itself gets this record.
  // A classified failure (model silent, auth, connection…) has its own honest
  // message, and a handoff/step-budget stop already carries one: adding a second
  // card there both repeated the point and contradicted it — the failure copy
  // says Lily will continue once the model recovers, while this one said the
  // task is out of scope for continuation (seen 3× in production 2026-09-15).
  function noteDenied(sessionId, source, decision) {
    const payload = source.payload || {};
    if (payload.failed || payload.errorCode || payload.continuationHandoff || payload.stepBudgetExhausted) return;
    if (require("./parent-task-closure").isModelSilentFailure(payload)) return;
    if (!payload.stalled || !source.state?.turnId) return;
    if (["NON_EXECUTION_TASK", "NO_EXECUTION_EVIDENCE"].includes(decision.reason)) commitNotice(sessionId, source.state.turnId, decision.reason);
  }

  /** Persisted recovery source of a given turn (any status), for follow-ups. */
  function recoverySourceForTurn(sessionId, sourceTurnId) {
    try { return ctx.sessionManager?.getParentClosureRecovery?.(sessionId, sourceTurnId)?.source || null; }
    catch { return null; }
  }

  function decisionFor(sessionId, source = {}) {
    return shouldRecoverParentClosure({
      sessionId,
      taskContract: source.taskContract || null,
      state: source.state || {},
      payload: source.payload || {},
      allowProductiveContinuation: typeof ctx.sessionManager?.reserveTaskContinuation === "function",
    });
  }

  function prepareParentClosureRecovery(sessionId, source = {}) {
    try {
      const decision = decisionFor(sessionId, source);
      if (!decision.ok) return { ok: false, prepared: false, reason: decision.reason, decision };
      const manager = ctx.sessionManager;
      if (typeof manager?.prepareParentClosureRecovery !== "function") {
        return { ok: true, prepared: false, durable: false, decision };
      }
      const result = manager.prepareParentClosureRecovery(sessionId, {
        sourceTurnId: decision.sourceTurnId,
        recoveryKey: decision.recoveryKey,
        source: persistedSource(source, decision.evidence),
      });
      return {
        ok: Boolean(result?.ok),
        prepared: Boolean(result?.ok),
        durable: true,
        reason: result?.reason || null,
        decision,
        recovery: result?.recovery || null,
      };
    } catch (err) {
      log.warn("parent closure preparation failed open: %s", err?.message || err);
      return { ok: true, prepared: false, durable: false, reason: "PREPARE_ERROR" };
    }
  }

  async function maybeParentClosureRecovery(sessionId, source = {}) {
    let attempted = false;
    let unconfirmed = false;
    let durableClaim = null;
    const generation = generations.get(sessionId) || 0;
    try {
      if (disposed) return { ok: false, attempted: false, reason: "DISPOSED" };
      const decision = decisionFor(sessionId, source);
      if (!decision.ok) { noteDenied(sessionId, source, decision); return { ok: false, attempted: false, reason: decision.reason }; }
      // The model returned nothing: dispatching now would hit the same silent
      // upstream and burn a continuation round. Wait for a successful readiness
      // probe, then run this exact recovery once (bounded by the watch).
      if (decision.modelSilent && !source.modelReady) return deferUntilModelReady(sessionId, source, decision);
      const manager = ctx.sessionManager;
      if (typeof manager?.claimParentClosureRecovery === "function") {
        // A claim write can succeed before its acknowledgement fails. Once
        // ownership is attempted, an exception cannot authorize another retry lane.
        attempted = true;
        durableClaim = manager.claimParentClosureRecovery(sessionId, {
          sourceTurnId: decision.sourceTurnId,
          recoveryKey: decision.recoveryKey,
          now: now(),
        });
        if (durableClaim?.reason === "NOT_FOUND") {
          const prepared = prepareParentClosureRecovery(sessionId, source);
          if (prepared.prepared) {
            durableClaim = manager.claimParentClosureRecovery(sessionId, {
              sourceTurnId: decision.sourceTurnId,
              recoveryKey: decision.recoveryKey,
              now: now(),
            });
          }
        }
        if (!durableClaim?.ok) {
          return { ok: false, attempted: Boolean(durableClaim?.recovery), reason: durableClaim?.reason || "CLAIM_UNAVAILABLE" };
        }
      } else if (!ledger.claim(decision.recoveryKey)) {
        return { ok: false, attempted: true, reason: "ALREADY_CLAIMED" };
      }
      attempted = true;
      const durableRecovery = durableClaim?.recovery || null;
      const emitRecovery = (phase, extra = {}) => {
        emit(sessionId, "turn.parent_closure_recovery", {
          phase,
          sourceTurnId: decision.sourceTurnId,
          recoveryKey: decision.recoveryKey,
          attempt: durableRecovery?.attemptCount || 1,
          evidence: {
            done: decision.evidence.done.length,
            failed: decision.evidence.failed.length,
            running: decision.evidence.running.length,
          },
          ...extra,
        }, { turnId: decision.sourceTurnId });
        if (phase === "unavailable" && /^TASK_CONTINUATION_(NO_PROGRESS|BUDGET_EXHAUSTED|DEADLINE)$/.test(String(extra.reason || ""))) {
          commitNotice(sessionId, decision.sourceTurnId, extra.reason);
        }
        if (typeof emitNotice === "function") {
          const stopDetails = {
            TASK_CONTINUATION_NO_PROGRESS: "未观察到跨轮新增执行进展，已停止自动接续；原任务尚未完成。",
            TASK_CONTINUATION_BUDGET_EXHAUSTED: "本任务已达到 8 次自动接续上限；已保留进展，剩余工作尚未完成。",
            TASK_CONTINUATION_DEADLINE: "本任务已达到 24 小时自动接续时限；已保留进展，剩余工作尚未完成。",
            TASK_CONTINUATION_CANCELLED: "任务已停止，不再自动接续。",
          };
          const detail = stopDetails[extra.reason] || (phase === "started"
            ? "检测到父任务尚未收尾，正在基于已有工具结果继续执行"
            : phase === "dispatched"
              ? "已在原会话中继续执行，并将完成剩余验证"
              : "自动续跑未启动，本轮将保留失败原因并等待用户处理");
          emitNotice(sessionId, {
            code: "parentTaskClosureRecovery",
            level: phase === "unavailable" ? "warning" : "progress",
            panel: true,
            replace: true,
            replacesCode: "parentTaskClosureRecovery",
            detail,
          });
        }
      };
      const rawObjective = String(source.objective || source.state?.enginePayload?.rawText || "").trim();
      const guidance = buildParentClosurePrompt({ objective: rawObjective, evidence: decision.evidence, continuationHandoff: source.payload?.continuationHandoff, workState: source.workState || null });
      if (typeof sendUserMessage !== "function" || !rawObjective) {
        if (durableClaim?.ok) {
          manager.markParentClosureRecoveryUnavailable(sessionId, {
            sourceTurnId: decision.sourceTurnId,
            recoveryKey: decision.recoveryKey,
            claimToken: durableClaim.claimToken,
            reason: "SEND_UNAVAILABLE",
          });
        } else ledger.clear(decision.recoveryKey);
        emitRecovery("unavailable", { reason: "SEND_UNAVAILABLE" });
        return { ok: false, attempted: true, reason: "SEND_UNAVAILABLE" };
      }
      const recoveryTurnId = durableRecovery?.recoveryTurnId || null;
      // Shared with process-job wakes. Persistence failures never authorize a
      // fallback send, and uncertain sends retain their reserved budget.
      if (typeof manager?.reserveTaskContinuation === "function") {
        const reservation = manager.reserveTaskContinuation(sessionId, {
          sourceTurnId: decision.sourceTurnId, continuationTurnId: recoveryTurnId,
          minProgress: require("./store/task-continuation-budget").minProgressPerRound(),
          progressKeys: source.payload?.executionProgressKeys || [], now: now(),
        });
        if (!reservation?.ok) {
          const reason = reservation?.reason || "TASK_CONTINUATION_UNAVAILABLE";
          manager.markParentClosureRecoveryUnavailable?.(sessionId, {
            sourceTurnId: decision.sourceTurnId, recoveryKey: decision.recoveryKey,
            claimToken: durableClaim?.claimToken, reason,
          });
          emitRecovery("unavailable", { reason });
          return { ok: false, attempted: true, reason };
        }
      }
      emitRecovery("started");
      if (recoveryTurnId && typeof manager?.getTurnInputByTurnId === "function") {
        const existing = manager.getTurnInputByTurnId(sessionId, recoveryTurnId);
        if (existing) {
          const marked = manager.markParentClosureRecoveryDispatched(sessionId, {
            sourceTurnId: decision.sourceTurnId,
            recoveryKey: decision.recoveryKey,
            recoveryTurnId,
            claimToken: durableClaim.claimToken,
          });
          if (marked?.ok === false) throw new Error(marked.reason || "RECEIPT_UNCONFIRMED");
          emitRecovery("dispatched", { recoveryTurnId, existing: true });
          return { ok: true, attempted: true, turnId: recoveryTurnId, existing: true };
        }
      }
      const sent = await sendUserMessage(sessionId, rawObjective, Array.isArray(source.files) ? source.files : [], {
        recordUser: false,
        spawnEngine: true,
        ...(recoveryTurnId ? { turnId: recoveryTurnId } : {}),
        sourceTurnId: decision.sourceTurnId,
        sourceTaskCore: source.taskCore || null,
        recovery: { kind: "parent_task_closure", guidance },
      });
      if (!sent?.ok) {
        if (durableClaim?.ok) {
          manager.markParentClosureRecoveryUnavailable(sessionId, {
            sourceTurnId: decision.sourceTurnId,
            recoveryKey: decision.recoveryKey,
            claimToken: durableClaim.claimToken,
            reason: sent?.error || "DISPATCH_FAILED",
          });
        } else ledger.clear(decision.recoveryKey);
        emitRecovery("unavailable", { reason: sent?.error || "DISPATCH_FAILED" });
        return { ok: false, attempted: true, reason: sent?.error || "DISPATCH_FAILED" };
      }
      if (durableClaim?.ok) {
        const marked = manager.markParentClosureRecoveryDispatched(sessionId, {
          sourceTurnId: decision.sourceTurnId,
          recoveryKey: decision.recoveryKey,
          recoveryTurnId: recoveryTurnId || sent.turnId || "",
          claimToken: durableClaim.claimToken,
        });
        if (marked?.ok === false) throw new Error(marked.reason || "RECEIPT_UNCONFIRMED");
      }
      emitRecovery("dispatched", { recoveryTurnId: sent.turnId || null });
      return { ok: true, attempted: true, turnId: sent.turnId || null };
    } catch (err) {
      unconfirmed = true;
      log.warn("parent closure recovery failed open: %s", err?.message || err);
      return { ok: false, attempted, reason: err?.message || "RECOVERY_ERROR" };
    } finally {
      if (attempted && !disposed && generation === (generations.get(sessionId) || 0)) {
        try { scheduleFutureClaims(sessionId); }
        catch (err) {
          log.warn("live parent closure lease discovery failed: %s", err?.message || err);
          unconfirmed = true;
        }
        const recovery = durableClaim?.recovery;
        if (unconfirmed && !leases.has(sessionId) && recovery?.ownerScope && recovery.claimExpiresAt) {
          // The response may arrive after the lease expired. Keep one delayed
          // authoritative reconciliation, never replay the unknown send here.
          armLease(sessionId, { ownerScope: recovery.ownerScope, reconcileSourceTurnId: recovery.sourceTurnId, expiresAt: Math.max(recovery.claimExpiresAt, now() + 120000) });
        }
      }
    }
  }

  function deferUntilModelReady(sessionId, source, decision) {
    const { startModelRecoveryWatch } = require("./model-recovery-watch");
    const generation = generations.get(sessionId) || 0;
    const stillCurrent = () => !disposed && generation === (generations.get(sessionId) || 0);
    const notice = (level, detail) => {
      if (typeof emitNotice !== "function") return;
      emitNotice(sessionId, { code: "modelRecoveryWatch", level, panel: true, replace: true, replacesCode: "modelRecoveryWatch", detail });
    };
    const watch = startModelRecoveryWatch({
      key: modelWatchKey(sessionId),
      probe: () => probeModelReady({ sessionId }),
      onReady: async ({ attempts }) => {
        if (!stillCurrent()) return;
        notice("progress", `模型已恢复响应（探测 ${attempts} 次），正在自动接续未完成的任务。`);
        emit(sessionId, "turn.model_recovery", { phase: "ready", attempts, sourceTurnId: decision.sourceTurnId }, { turnId: decision.sourceTurnId });
        await maybeParentClosureRecovery(sessionId, { ...source, modelReady: true });
      },
      onGiveUp: ({ attempts }) => {
        if (!stillCurrent()) return;
        notice("warning", `模型在 ${attempts} 次探测内没有恢复，已停止等待；任务进展已保留，换一个模型或稍后说"继续"即可接着做。`);
        commitNotice(sessionId, decision.sourceTurnId, "MODEL_RECOVERY_GAVE_UP", { attempts });
        emit(sessionId, "turn.model_recovery", { phase: "gave_up", attempts, sourceTurnId: decision.sourceTurnId }, { turnId: decision.sourceTurnId });
      },
    });
    if (!watch) return { ok: false, attempted: false, reason: "MODEL_RECOVERY_WATCH_DISABLED" };
    notice("progress", "模型暂时没有响应；Lily 会在它恢复后自动接续本任务（最多等待约 15 分钟）。也可以直接换一个模型继续。");
    emit(sessionId, "turn.model_recovery", { phase: "waiting", sourceTurnId: decision.sourceTurnId, recoveryKey: decision.recoveryKey }, { turnId: decision.sourceTurnId });
    return { ok: false, attempted: false, reason: "AWAITING_MODEL_RECOVERY", watching: true };
  }

  async function resumePendingParentClosures(sessionId, lease = null) {
    const manager = ctx.sessionManager;
    const generation = lease?.generation ?? (generations.get(sessionId) || 0);
    const ownerScope = lease?.ownerScope || manager?.resolveTurnOwnerScope?.(sessionId)?.ownerScope;
    try {
      const result = await scanPendingParentClosures(sessionId);
      retryCounts.delete(sessionId);
      return result;
    } catch (err) {
      log.warn("parent closure discovery failed: %s", err?.message || err);
      // Two delayed retries per failed discovery sequence. Preserve the claim
      // and its stable admission identity; unavailable reads never authorize a send.
      const retries = retryCounts.get(sessionId) || 0;
      if (!disposed && retries < 2 && generation === (generations.get(sessionId) || 0)
        && ownerScope && manager?.resolveTurnOwnerScope?.(sessionId)?.ownerScope === ownerScope
        && manager?._find?.(sessionId)) {
        retryCounts.set(sessionId, retries + 1);
        clearLease(sessionId);
        armLease(sessionId, { ownerScope, expiresAt: now() + 120000 });
      }
      return 0;
    }
  }

  async function scanPendingParentClosures(sessionId) {
    const manager = ctx.sessionManager;
    if (disposed || typeof manager?.listPendingParentClosureRecoveries !== "function") return 0;
    const candidates = manager.listPendingParentClosureRecoveries(sessionId, now()) || [];
    try { scheduleFutureClaims(sessionId); }
    catch (err) { log.warn("parent closure lease discovery failed: %s", err?.message || err); }
    let resumed = 0;
    for (const candidate of candidates) {
      if (disposed) break;
      if (typeof manager.resolveTurnOwnerScope === "function"
        && (manager.resolveTurnOwnerScope(sessionId)?.ownerScope !== candidate.ownerScope || !manager._find?.(sessionId))) break;
      const source = candidate.source || {};
      const evidence = source.evidence || {};
      const sourceTurn = manager.getTurnInputByTurnId?.(sessionId, candidate.sourceTurnId);
      if (sourceTurn?.status === "interrupted" || sourceTurn?.status === "cancelled") continue;
      const tools = [...(evidence.done || []), ...(evidence.failed || []), ...(evidence.running || [])]
        .map((tool) => [tool.id || tool.name || crypto.randomUUID(), tool]);
      const result = await maybeParentClosureRecovery(sessionId, {
        taskContract: source.taskContract,
        taskCore: sourceTurn?.taskCore || null,
        objective: source.objective,
        files: source.files,
        workState: source.workState || null,
        state: {
          turnId: candidate.sourceTurnId,
          enginePayload: { rawText: source.objective },
          tools: new Map(tools),
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          pendingHooks: new Map(),
          currentPayload: { parentClosureRecovery: false },
        },
        payload: { executionProgressKeys: source.executionProgressKeys || [], ...(source.continuationHandoff ? { code: 0, continuationHandoff: source.continuationHandoff } : { stalled: true }) },
      });
      if (result.ok) resumed += 1;
    }
    scheduleFutureClaims(sessionId);
    return resumed;
  }

  async function resumePendingParentClosuresForSessions(sessions = []) {
    let resumed = 0;
    for (const session of sessions || []) resumed += await resumePendingParentClosures(session?.id);
    return resumed;
  }

  return {
    dispose,
    cancelPendingParentClosures,
    maybeParentClosureRecovery,
    recoverySourceForTurn,
    prepareParentClosureRecovery,
    resumePendingParentClosures,
    resumePendingParentClosuresForSessions,
  };
}

module.exports = { createParentClosureRecoveryRuntime };
