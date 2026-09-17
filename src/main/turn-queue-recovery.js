"use strict";

const {
  normalizeQueueRecoveryEnvelope,
} = require("./turn-queue-recovery-envelope");
const { DISPATCH_OUTCOME_UNKNOWN_ASSISTANT } = require("./turn-recovery-projection");

function recoveredQueueOptions(admitted, queueDispatchOptions, sourceTaskCore = null) {
  const metadata = admitted?.metadata || {};
  const recovery = normalizeQueueRecoveryEnvelope(metadata.queueRecovery);
  const persisted = (
    recovery
    && recovery.schemaVersion === 2
    && recovery.options
    && typeof recovery.options === "object"
  ) ? recovery.options : {
    scheduledTaskId: metadata.scheduledTaskId || null,
    scheduledTaskRunId: metadata.scheduledTaskRunId || null,
    queueOrigin: metadata.scheduledTaskId ? "scheduled_task" : "recovered",
    queueVisibility: metadata.scheduledTaskId ? "background" : "composer",
  };
  return {
    id: typeof recovery?.queueItemId === "string" && recovery.queueItemId
      ? recovery.queueItemId
      : `queue_recovered_${admitted.turnId}`,
    displayFiles: Array.isArray(recovery?.fileRefs)
      ? recovery.fileRefs
      : admitted.files,
    options: queueDispatchOptions({
      ...persisted,
      ...(sourceTaskCore && typeof sourceTaskCore === "object" ? { sourceTaskCore } : {}),
    }),
  };
}

function createTurnQueueRecoveryMethods({ log, queueDispatchOptions }) {
  return {
    /**
     * An outcome-unknown turn becomes visible, and is ANNOUNCED exactly once.
     *
     * The in-memory guard below is a within-process cache, and the thing it has
     * to survive is a restart — which empties it. So the durable row is the fact
     * and memory is its projection: a row that already reads `outcome_unknown`
     * was announced by an earlier run and is adopted in silence, while a turn
     * still in flight is a genuinely new outcome, announced and written down.
     *
     * Measured before this: 228 announcements for 10 turns, one from 09-01
     * re-announced 52 times over four days, each restart telling the user to
     * re-send something from a conversation they had long finished.
     * [gate: announce-once-across-restart]
     */
    _recordDispatchOutcomeUnknown(sessionId, admitted, reason = "restart") {
      if (!admitted?.turnId) return null;
      const state = this._state(sessionId);
      state.outcomeUnknownTurns ||= [];
      state.outcomeUnknownTurnIds ||= new Set();
      if (state.outcomeUnknownTurnIds.has(admitted.turnId)) {
        return state.outcomeUnknownTurns.find((turn) => turn.turnId === admitted.turnId) || null;
      }
      const alreadyAnnounced = String(admitted.status || "") === "outcome_unknown";
      const recovery = normalizeQueueRecoveryEnvelope(
        admitted.metadata?.queueRecovery,
      );
      const info = Object.freeze({
        turnId: admitted.turnId,
        status: admitted.status,
        delivery: admitted.delivery,
        userText: String(admitted.userText || "").slice(0, 4000),
        dispatchAttemptId: admitted.dispatchAttemptId || null,
        dispatchStartedAt: admitted.dispatchStartedAt || null,
        acceptedAt: admitted.acceptedAt || admitted.promotedAt || null,
        queueItemId: recovery?.queueItemId || null,
        scheduledTaskId: recovery?.options?.scheduledTaskId || null,
        scheduledTaskRunId: recovery?.options?.scheduledTaskRunId || null,
        commandId: recovery?.options?.externalCommand?.commandId || null,
        reason,
        assistant: DISPATCH_OUTCOME_UNKNOWN_ASSISTANT,
        errorCode: "DISPATCH_OUTCOME_UNKNOWN",
        automaticReplay: false,
        manualRecoveryRequired: true,
      });
      state.outcomeUnknownTurnIds.add(admitted.turnId);
      state.outcomeUnknownTurns.push(info);
      if (state.outcomeUnknownTurns.length > 100) {
        const removed = state.outcomeUnknownTurns.shift();
        state.outcomeUnknownTurnIds.delete(removed?.turnId);
      }
      if (recovery?.options?.externalCommand) {
        const sourceTurn = recovery.options.sourceTurnId
          ? this.ctx.sessionManager?.getTurnInputByTurnId?.(sessionId, recovery.options.sourceTurnId)
          : null;
        const recovered = recoveredQueueOptions(admitted, queueDispatchOptions, sourceTurn?.taskCore || null);
        this.externalCommandRuntime?.restoreRecovered?.(sessionId, {
          id: recovered.id,
          options: recovered.options,
          admittedTurnInput: admitted,
        });
      }
      if (!alreadyAnnounced) {
        // Write the fact down BEFORE announcing, so a crash between the two
        // repeats the announcement at most once more rather than forever.
        try {
          this.ctx.sessionManager?.markTurnInputOutcomeUnknown?.(sessionId, admitted.turnId);
        } catch (err) {
          // Fail open to the in-memory guard, which is exactly the previous
          // behaviour — never block the notice on bookkeeping.
          log.warn(
            "outcome-unknown persistence failed open: session=%s turn=%s error=%s",
            sessionId,
            admitted.turnId,
            err?.message || err,
          );
        }
        this._emit(sessionId, "turn.dispatch_outcome_unknown", info, {
          turnId: admitted.turnId,
        });
      }
      return info;
    },

    _restoreOutcomeUnknownIntoState(sessionId) {
      const manager = this.ctx.sessionManager;
      if (typeof manager?.outcomeUnknownTurnInputs !== "function") return 0;
      let turns;
      try {
        turns = manager.outcomeUnknownTurnInputs(sessionId);
      } catch (err) {
        log.warn(
          "turn dispatch outcome recovery failed open: session=%s error=%s",
          sessionId,
          err?.message || err,
        );
        return 0;
      }
      let restored = 0;
      for (const admitted of turns) {
        const before = this._state(sessionId).outcomeUnknownTurnIds?.size || 0;
        this._recordDispatchOutcomeUnknown(sessionId, admitted, "restart");
        const after = this._state(sessionId).outcomeUnknownTurnIds?.size || 0;
        if (after > before) restored += 1;
      }
      return restored;
    },

    _restorePendingTurnsIntoState(sessionId, state) {
      const manager = this.ctx.sessionManager;
      if (!manager?.findById?.(sessionId) || typeof manager.pendingTurnInputs !== "function") {
        return 0;
      }
      this._restoreOutcomeUnknownIntoState(sessionId);
      let pending;
      try {
        pending = manager.pendingTurnInputs(sessionId);
      } catch (err) {
        log.warn("pending turn recovery failed open: session=%s error=%s", sessionId, err?.message || err);
        return 0;
      }
      const turnIds = new Set([
        state.turnId,
        ...state.queue.map((item) => item.admittedTurnInput?.turnId),
      ].filter(Boolean));
      const runIds = new Set(
        state.queue.map((item) => item.options?.scheduledTaskRunId).filter(Boolean),
      );
      const commandIds = new Set(
        state.queue.map((item) => item.options?.externalCommand?.commandId).filter(Boolean),
      );
      let restored = 0;
      for (const admitted of pending) {
        if (!admitted?.turnId || turnIds.has(admitted.turnId)) continue;
        if (
          admitted.delivery !== "queue"
          || admitted.status !== "admitted"
          || !normalizeQueueRecoveryEnvelope(admitted.metadata?.queueRecovery)
        ) continue;
        const sourceTurn = admitted.metadata?.queueRecovery?.options?.sourceTurnId
          ? manager.getTurnInputByTurnId?.(sessionId, admitted.metadata.queueRecovery.options.sourceTurnId)
          : null;
        const recovered = recoveredQueueOptions(admitted, queueDispatchOptions, sourceTurn?.taskCore || null);
        const runId = recovered.options.scheduledTaskRunId || null;
        const commandId = recovered.options.externalCommand?.commandId || null;
        if ((runId && runIds.has(runId)) || (commandId && commandIds.has(commandId))) continue;
        const item = {
          id: recovered.id,
          text: admitted.userText,
          files: admitted.files,
          displayFiles: recovered.displayFiles,
          options: recovered.options,
          admittedTurnInput: admitted,
          recovered: true,
        };
        state.queue.push(item);
        turnIds.add(admitted.turnId);
        if (runId) runIds.add(runId);
        if (commandId) commandIds.add(commandId);
        this.externalCommandRuntime?.restoreRecovered?.(sessionId, item);
        restored += 1;
      }
      if (restored > 0) {
        this.recoveredQueueSessions.add(sessionId);
        this._emitQueue(sessionId);
      }
      return restored;
    },

    restorePendingTurns(sessionId) {
      const state = this._state(sessionId);
      return this._restorePendingTurnsIntoState(sessionId, state);
    },

    async startRecoveredTurns(sessionId = null) {
      const sessionIds = sessionId
        ? [sessionId]
        : [...this.recoveredQueueSessions];
      await Promise.all(sessionIds.map(async (targetSessionId) => {
        this.restorePendingTurns(targetSessionId);
        await this._dispatchNext(targetSessionId);
      }));
    },
  };
}

module.exports = { createTurnQueueRecoveryMethods, recoveredQueueOptions };
