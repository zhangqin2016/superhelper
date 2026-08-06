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
    objective: String(source.objective || source.state?.enginePayload?.rawText || "").trim().slice(0, 1200),
    files: Array.isArray(source.files) ? source.files.slice(0, 64) : [],
    taskContract: source.taskContract || null,
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
  const sendUserMessage = options.sendUserMessage;
  const ledger = options.parentClosureLedger || createParentClosureLedger();

  function decisionFor(sessionId, source = {}) {
    return shouldRecoverParentClosure({
      sessionId,
      taskContract: source.taskContract || null,
      state: source.state || {},
      payload: source.payload || {},
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
    try {
      const decision = decisionFor(sessionId, source);
      if (!decision.ok) return { ok: false, attempted: false, reason: decision.reason };
      const manager = ctx.sessionManager;
      let durableClaim = null;
      if (typeof manager?.claimParentClosureRecovery === "function") {
        durableClaim = manager.claimParentClosureRecovery(sessionId, {
          sourceTurnId: decision.sourceTurnId,
          recoveryKey: decision.recoveryKey,
        });
        if (durableClaim?.reason === "NOT_FOUND") {
          const prepared = prepareParentClosureRecovery(sessionId, source);
          if (prepared.prepared) {
            durableClaim = manager.claimParentClosureRecovery(sessionId, {
              sourceTurnId: decision.sourceTurnId,
              recoveryKey: decision.recoveryKey,
            });
          }
        }
        if (!durableClaim?.ok) {
          return { ok: false, attempted: false, reason: durableClaim?.reason || "CLAIM_UNAVAILABLE" };
        }
      } else if (!ledger.claim(decision.recoveryKey)) {
        return { ok: false, attempted: false, reason: "ALREADY_CLAIMED" };
      }
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
        if (typeof emitNotice === "function") {
          const detail = phase === "started"
            ? "检测到父任务尚未收尾，正在基于已有工具结果继续执行"
            : phase === "dispatched"
              ? "已在原会话中继续执行，并将完成剩余验证"
              : "自动续跑未启动，本轮将保留失败原因并等待用户处理";
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
      emitRecovery("started");
      const rawObjective = String(source.objective || source.state?.enginePayload?.rawText || "").trim();
      const guidance = buildParentClosurePrompt({ objective: rawObjective, evidence: decision.evidence });
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
      if (recoveryTurnId && typeof manager?.getTurnInputByTurnId === "function") {
        const existing = manager.getTurnInputByTurnId(sessionId, recoveryTurnId);
        if (existing) {
          manager.markParentClosureRecoveryDispatched(sessionId, {
            sourceTurnId: decision.sourceTurnId,
            recoveryKey: decision.recoveryKey,
            recoveryTurnId,
            claimToken: durableClaim.claimToken,
          });
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
        manager.markParentClosureRecoveryDispatched(sessionId, {
          sourceTurnId: decision.sourceTurnId,
          recoveryKey: decision.recoveryKey,
          recoveryTurnId: recoveryTurnId || sent.turnId || "",
          claimToken: durableClaim.claimToken,
        });
      }
      emitRecovery("dispatched", { recoveryTurnId: sent.turnId || null });
      return { ok: true, attempted: true, turnId: sent.turnId || null };
    } catch (err) {
      log.warn("parent closure recovery failed open: %s", err?.message || err);
      return { ok: false, attempted: false, reason: err?.message || "RECOVERY_ERROR" };
    }
  }

  async function resumePendingParentClosures(sessionId) {
    const manager = ctx.sessionManager;
    if (typeof manager?.listPendingParentClosureRecoveries !== "function") return 0;
    let candidates;
    try {
      candidates = manager.listPendingParentClosureRecoveries(sessionId) || [];
    } catch (err) {
      log.warn("pending parent closure scan failed open: %s", err?.message || err);
      return 0;
    }
    let resumed = 0;
    for (const candidate of candidates) {
      const source = candidate.source || {};
      const evidence = source.evidence || {};
      const sourceTurn = manager.getTurnInputByTurnId?.(sessionId, candidate.sourceTurnId);
      const tools = [...(evidence.done || []), ...(evidence.failed || []), ...(evidence.running || [])]
        .map((tool) => [tool.id || tool.name || crypto.randomUUID(), tool]);
      const result = await maybeParentClosureRecovery(sessionId, {
        taskContract: source.taskContract,
        taskCore: sourceTurn?.taskCore || null,
        objective: source.objective,
        files: source.files,
        state: {
          turnId: candidate.sourceTurnId,
          enginePayload: { rawText: source.objective },
          tools: new Map(tools),
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          pendingHooks: new Map(),
          currentPayload: { parentClosureRecovery: false },
        },
        payload: { stalled: true },
      });
      if (result.ok) resumed += 1;
    }
    return resumed;
  }

  async function resumePendingParentClosuresForSessions(sessions = []) {
    let resumed = 0;
    for (const session of sessions || []) resumed += await resumePendingParentClosures(session?.id);
    return resumed;
  }

  return {
    maybeParentClosureRecovery,
    prepareParentClosureRecovery,
    resumePendingParentClosures,
    resumePendingParentClosuresForSessions,
  };
}

module.exports = { createParentClosureRecoveryRuntime };
