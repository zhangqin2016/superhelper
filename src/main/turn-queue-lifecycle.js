"use strict";

const {
  ownerScopeFromPrincipal,
} = require("./character-worlds/owner-scope");
const { isActiveTurnPhase } = require("./turn-active-phase");

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

function createTurnQueueLifecycleMethods({ log }) {
  return {
    interrupt(sessionId, opts = {}) {
      const state = this._state(sessionId);
      if (
        (opts.expectedTurnId && state.turnId !== opts.expectedTurnId)
        || (
          opts.expectedDispatchAttemptId
          && state.dispatchAttemptId !== opts.expectedDispatchAttemptId
        )
        || (
          opts.expectedOwnerScope
          && state.admittedTurnInput?.ownerScope !== opts.expectedOwnerScope
        )
      ) {
        return { ok: false, error: "TURN_CLAIM_MISMATCH" };
      }
      let queueResult = null;
      if (opts.clearQueue !== false) {
        queueResult = this._removeQueuedItemsDurably(
          sessionId,
          () => true,
          "USER_STOPPED",
        );
      }
      if (state.admittedSeq) {
        try {
          this.runCoordinator.interrupt(sessionId, state.admittedSeq);
        } catch {
          // The runner interrupt below remains authoritative.
        }
      }
      const runner = this.ctx.runnerPool.get(sessionId);
      runner?.interrupt();
      if (
        state.phase !== "idle"
        && state.turnId
        && !state.terminalEmitted
      ) {
        this._finalize(sessionId, "turn.interrupted", {
          interrupted: true,
          assistant: state.assistantText,
        });
      }
      if (queueResult?.rejected?.length) {
        const outcomeUnknown = queueResult.rejected.some(
          ({ result }) => result?.outcomeUnknown,
        );
        return {
          ok: false,
          error: outcomeUnknown
            ? "DISPATCH_OUTCOME_UNKNOWN"
            : "QUEUE_CANCEL_FAILED",
          queueOutcomeUnknown: outcomeUnknown,
          queueLength: queueResult.queueLength,
        };
      }
      return { ok: true };
    },

    cancelQueuedMessage(sessionId, itemId) {
      const state = this._state(sessionId);
      if (!state.queue.some((item) => item.id === itemId)) {
        return { ok: false, error: "NOT_FOUND" };
      }
      const result = this._removeQueuedItemsDurably(
        sessionId,
        (item) => item.id === itemId,
        "QUEUE_CANCELLED",
      );
      if (result.rejected.length) {
        return {
          ok: false,
          error: result.rejected[0].result?.outcomeUnknown
            ? "DISPATCH_OUTCOME_UNKNOWN"
            : "QUEUE_CANCEL_FAILED",
          queueLength: result.queueLength,
        };
      }
      return { ok: true, sessionId, queueLength: result.queueLength };
    },

    _terminalizeQueuedItem(sessionId, item, errorCode) {
      const markTerminal = this.ctx.sessionManager?.markTurnInputTerminal;
      if (typeof markTerminal !== "function") {
        return { ok: true, legacy: true, turn: item?.admittedTurnInput || null };
      }
      const admitted = item?.admittedTurnInput;
      if (!admitted?.turnId || !admitted.ownerScope) {
        return {
          ok: false,
          reason: "MISSING_DURABLE_QUEUE_CLAIM",
          outcomeUnknown: false,
          turn: admitted || null,
        };
      }
      // A dispatch failure path (e.g. turn-start recovery) may already have
      // terminalized this row durably. Never issue a second terminal CAS
      // against a proven terminal row — just adopt it.
      const getTurn = this.ctx.sessionManager?.getTurnInputByTurnId;
      if (typeof getTurn === "function") {
        let durable = null;
        try {
          durable = getTurn.call(
            this.ctx.sessionManager,
            sessionId,
            admitted.turnId,
          ) || null;
        } catch (err) {
          log.warn(
            "queued turn terminal precheck failed open: session=%s turn=%s error=%s",
            sessionId,
            admitted.turnId,
            err?.message || err,
          );
          durable = null;
        }
        if (TERMINAL_STATUSES.has(durable?.status)) {
          item.admittedTurnInput = durable;
          return { ok: true, alreadyTerminal: true, turn: durable };
        }
      }
      let result;
      try {
        result = markTerminal.call(
          this.ctx.sessionManager,
          {
            ownerScope: admitted.ownerScope,
            sessionId,
            turnId: admitted.turnId,
            dispatchAttemptId: item.dispatchAttemptId
              || admitted.dispatchAttemptId
              || null,
            fromStatuses: ["admitted"],
          },
          "turn.interrupted",
          { errorCode },
        );
      } catch (err) {
        log.warn(
          "queued turn terminal CAS failed: session=%s turn=%s error=%s",
          sessionId,
          admitted.turnId,
          err?.message || err,
        );
        return {
          ok: false,
          reason: "TERMINAL_CAS_ERROR",
          // The store may have committed the CAS before reporting an error.
          // Never retry automatically when terminal truth is unknown: pause
          // this in-memory item and let durable recovery reconcile it later.
          outcomeUnknown: true,
          turn: admitted,
        };
      }
      if (result?.ok) {
        item.admittedTurnInput = result.turn || admitted;
        this._completeQueuedScheduledRun(item, "turn.interrupted", {
          errorCode,
        });
        return result;
      }
      if (
        result?.reason === "TERMINAL_IMMUTABLE"
        && TERMINAL_STATUSES.has(result.turn?.status)
      ) {
        item.admittedTurnInput = result.turn;
        return { ...result, ok: true, alreadyTerminal: true };
      }
      return result || {
        ok: false,
        reason: "TERMINAL_CAS_REJECTED",
        outcomeUnknown: false,
        turn: admitted,
      };
    },

    _removeQueuedItemsDurably(sessionId, predicate, errorCode) {
      const state = this._state(sessionId);
      const retained = [];
      const removed = [];
      const rejected = [];
      for (const item of state.queue) {
        if (!predicate(item)) {
          retained.push(item);
          continue;
        }
        const result = this._terminalizeQueuedItem(sessionId, item, errorCode);
        if (result.ok) removed.push(item);
        else {
          retained.push(item);
          rejected.push({ item, result });
        }
      }
      if (removed.length) {
        state.queue = retained;
        this._emitQueue(sessionId);
      }
      return { removed, rejected, queueLength: state.queue.length };
    },

    /**
     * Remove exactly the dispatched item from the in-memory queue. A principal
     * change may have re-filtered the queue while the dispatch awaited
     * preflight, so removal is by item identity — never by head position.
     */
    _removeDispatchedQueueItem(state, item) {
      const index = state.queue.indexOf(item);
      if (index < 0) return false;
      state.queue.splice(index, 1);
      return true;
    },

    _pauseQueuedItemInMemory(sessionId, item, reason) {
      const state = this._state(sessionId);
      const index = state.queue.indexOf(item);
      if (index < 0) return false;
      state.queue.splice(index, 1);
      log.warn(
        "queued turn paused in memory: session=%s turn=%s reason=%s",
        sessionId,
        item?.admittedTurnInput?.turnId || "",
        reason,
      );
      this._emitQueue(sessionId);
      return true;
    },

    handlePrincipalChange() {
      // The epoch bump and the queue re-filter must linearize with any
      // in-flight dispatch claim/engine send: a dispatch that already entered
      // its critical section completes under the old epoch, everything after
      // observes the new one. The gate serializes the two synchronous
      // sections; async preflight waits outside it.
      // Dispatching is deferred until AFTER the gate releases: a gate action
      // must never re-enter the linearization gate (see the busy-path contract
      // in _withDispatchLinearization).
      const dispatchable = [];
      this._withDispatchLinearization(() => {
        this.principalEpoch = (this.principalEpoch || 0) + 1;
        const sessionIds = new Set([
          ...this.states.keys(),
          ...(
            this.ctx.sessionManager?.iterateSessions?.() || []
          ).map((session) => session.id),
        ]);
        for (const sessionId of sessionIds) {
          const state = this._state(sessionId);
          const resolved = this.ctx.sessionManager?.resolveTurnOwnerScope?.(
            sessionId,
          ) || { ok: false, error: "OWNER_SCOPE_UNAVAILABLE" };
          const ownerScope = resolved.ok ? resolved.ownerScope : null;
          const retained = state.queue.filter(
            (item) => ownerScope
              && item?.admittedTurnInput?.ownerScope === ownerScope,
          );
          if (retained.length !== state.queue.length) {
            state.queue = retained;
            this._emitQueue(sessionId);
          }
          if (ownerScope) {
            this.restorePendingTurns(sessionId);
            dispatchable.push(sessionId);
          }
        }
      });
      for (const sessionId of dispatchable) {
        void this._dispatchNext(sessionId);
      }
      return { ok: true };
    },

    interruptScheduledRun(run = {}) {
      const sessionId = String(run.sessionId || "");
      const state = this.states.get(sessionId);
      const expectedOwnerScope = ownerScopeFromPrincipal(run.ownerPrincipal);
      if (
        !state
        || !isActiveTurnPhase(state.phase)
        || state.finalizing
        || state.turnId !== run.turnId
        || state.scheduledTask?.runId !== run.id
        || !run.dispatchAttemptId
        || state.dispatchAttemptId !== run.dispatchAttemptId
        || !expectedOwnerScope
        || state.admittedTurnInput?.ownerScope !== expectedOwnerScope
      ) {
        return { ok: false, error: "TURN_CLAIM_MISMATCH" };
      }
      return this.interrupt(sessionId, {
        clearQueue: false,
        expectedTurnId: run.turnId,
        expectedDispatchAttemptId: run.dispatchAttemptId,
        expectedOwnerScope,
      });
    },
  };
}

module.exports = { createTurnQueueLifecycleMethods };
