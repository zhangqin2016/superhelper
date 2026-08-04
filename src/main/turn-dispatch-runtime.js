"use strict";

const crypto = require("node:crypto");
const { DISPATCH_BLOCKED_ASSISTANT } = require("./turn-recovery-projection");

const OUTCOME_UNKNOWN_STATUSES = new Set([
  "dispatching",
  "outcome_unknown",
  "promoted",
  "accepted",
]);

function newDispatchAttemptId() {
  return `dispatch_${crypto.randomUUID()}`;
}

function queueTurnId(item) {
  return item?.admittedTurnInput?.turnId || null;
}

function createTurnDispatchMethods({ log }) {
  return {
    _withDispatchLinearization(action) {
      const gate = this.dispatchLinearizationGate || (
        this.dispatchLinearizationGate = {
          active: false,
          pending: [],
        }
      );
      if (gate.active) {
        // Re-entrant entry: only reachable when a gate action itself triggers
        // dispatch/claim work — a programming error (gate actions must be
        // self-contained synchronous sections; handlePrincipalChange defers
        // its dispatch until after release). The action is queued and runs
        // once on drain; the caller gets a sentinel and must NOT duplicate
        // the side effect itself. Logged per fail-loud.
        log.warn(
          "dispatch linearization re-entry queued (gate actions must not dispatch re-entrantly)",
        );
        gate.pending.push(action);
        return {
          ok: false,
          retry: true,
          queued: true,
          error: "DISPATCH_LINEARIZATION_BUSY",
        };
      }
      gate.active = true;
      let result;
      try {
        result = action();
        while (gate.pending.length > 0) {
          const pending = gate.pending.shift();
          try {
            pending();
          } catch (err) {
            log.warn(
              "dispatch linearization callback failed: %s",
              err?.message || err,
            );
          }
        }
      } finally {
        gate.active = false;
      }
      return result;
    },

    _captureQueueDispatchSelection(sessionId, item) {
      return Object.freeze({
        sessionId,
        turnId: queueTurnId(item),
        itemId: item?.id || null,
        ownerScope: item?.admittedTurnInput?.ownerScope || null,
        epoch: this.principalEpoch,
      });
    },

    _revalidateQueueDispatchSelection(selection) {
      if (
        !selection
        || !selection.sessionId
        || !selection.turnId
        || !selection.itemId
        || !selection.ownerScope
        || selection.epoch !== this.principalEpoch
      ) {
        return {
          ok: false,
          ownerPause: true,
          error: "PRINCIPAL_EPOCH_CHANGED",
        };
      }
      const state = this._state(selection.sessionId);
      const item = state.queue.find((candidate) => (
        candidate?.id === selection.itemId
        && queueTurnId(candidate) === selection.turnId
        && candidate?.admittedTurnInput?.ownerScope === selection.ownerScope
      ));
      if (!item) {
        return {
          ok: false,
          ownerPause: true,
          error: "QUEUE_ITEM_STALE",
        };
      }
      const currentOwner = this.ctx.sessionManager?.resolveTurnOwnerScope?.(
        selection.sessionId,
      );
      if (
        !currentOwner?.ok
        || currentOwner.ownerScope !== selection.ownerScope
      ) {
        return {
          ok: false,
          ownerPause: true,
          error: currentOwner?.error || "OWNER_SCOPE_MISMATCH",
        };
      }
      return { ok: true, item };
    },

    _claimTurnDispatch(session, admitted) {
      const manager = this.ctx.sessionManager;
      if (typeof manager?.claimTurnInputDispatch !== "function") {
        return {
          ok: true,
          legacy: true,
          attemptId: null,
          turn: admitted || null,
        };
      }
      if (!session?.id || !admitted?.turnId) {
        return { ok: false, reason: "MISSING_ADMISSION", turn: admitted || null };
      }
      const attemptId = newDispatchAttemptId();
      try {
        const claimed = manager.claimTurnInputDispatch(session.id, admitted.turnId, {
          attemptId,
          startedAt: Date.now(),
          ownerScope: admitted.ownerScope,
        });
        if (!claimed?.ok) {
          return {
            ok: false,
            reason: claimed?.reason || "DISPATCH_CAS_FAILED",
            outcomeUnknown: OUTCOME_UNKNOWN_STATUSES.has(claimed?.turn?.status),
            turn: claimed?.turn || admitted,
          };
        }
        return {
          ok: true,
          attemptId,
          turn: claimed.turn || admitted,
        };
      } catch (err) {
        log.warn("turn dispatch claim failed: %s", err?.message || err);
        return { ok: false, reason: "DISPATCH_CAS_ERROR", turn: admitted };
      }
    },

    _markTurnDispatchAccepted(turnId, attemptId, metadata = {}) {
      if (!turnId || !attemptId) return null;
      try {
        return this.ctx.sessionManager?.markTurnInputPromoted?.(turnId, {
          status: "promoted",
          dispatchAttemptId: attemptId,
          acceptedAt: Date.now(),
          metadata,
        }) || null;
      } catch (err) {
        log.warn("turn input promotion failed: %s", err?.message || err);
        return null;
      }
    },

    _prepareTurnDispatch(session, state, options = {}) {
      let attemptId = options.dispatchAttemptId
        || state.admittedTurnInput?.dispatchAttemptId
        || null;
      if (attemptId) {
        state.dispatchAttemptId = attemptId;
        return {
          ok: true,
          attemptId,
          startedAt: state.admittedTurnInput?.dispatchStartedAt || null,
        };
      }
      const claim = this._claimTurnDispatch(session, state.admittedTurnInput);
      if (!claim.ok) {
        const turnId = state.turnId;
        if (claim.outcomeUnknown) {
          this._recordDispatchOutcomeUnknown?.(
            session.id,
            claim.turn,
            claim.reason,
          );
        }
        require("./turn-terminal-finalizer").clearTurnState(state);
        if (!claim.outcomeUnknown) {
          this._emit(session.id, "turn.dispatch_blocked", {
            status: claim.turn?.status || "unknown",
            reason: claim.reason || "DISPATCH_CAS_FAILED",
            assistant: DISPATCH_BLOCKED_ASSISTANT,
            automaticReplay: false,
            manualRecoveryRequired: true,
            retryable: true,
          }, { turnId });
        }
        return {
          ok: false,
          result: {
            ok: false,
            error: claim.outcomeUnknown
              ? "DISPATCH_OUTCOME_UNKNOWN"
              : "DISPATCH_CAS_FAILED",
            turnId,
            outcomeUnknown: Boolean(claim.outcomeUnknown),
          },
        };
      }
      attemptId = claim.attemptId || null;
      if (claim.turn) {
        state.admittedTurnInput = claim.turn;
        state.admittedSeq = claim.turn.admittedSeq || state.admittedSeq;
      }
      state.dispatchAttemptId = attemptId;
      return {
        ok: true,
        attemptId,
        startedAt: claim.turn?.dispatchStartedAt || null,
      };
    },

    _markPreSendFailure(session, state, reason, err = null) {
      const admitted = state.admittedTurnInput;
      const attemptId = state.dispatchAttemptId;
      const markTerminal = this.ctx.sessionManager?.markTurnInputTerminal;
      if (
        typeof markTerminal !== "function"
        || !admitted?.turnId
        || !admitted.ownerScope
        || !attemptId
      ) {
        return { ok: true, legacy: true, turn: admitted || null };
      }
      try {
        const result = markTerminal.call(
          this.ctx.sessionManager,
          {
            ownerScope: admitted.ownerScope,
            sessionId: session.id,
            turnId: admitted.turnId,
            dispatchAttemptId: attemptId,
            fromStatuses: ["dispatching"],
          },
          "turn.failed",
          {
            errorCode: reason === "pre_send_throw"
              ? "PRE_SEND_THROW"
              : "PRE_SEND_REJECTED",
            metadata: {
              dispatchFailureReason: reason,
              ...(err?.message
                ? { dispatchFailureDetail: String(err.message).slice(0, 500) }
                : {}),
            },
          },
        ) || null;
        if (result?.turn) state.admittedTurnInput = result.turn;
        return result || {
          ok: false,
          reason: "TERMINAL_CAS_REJECTED",
          outcomeUnknown: true,
          turn: admitted,
        };
      } catch (terminalErr) {
        log.warn(
          "pre-send terminal CAS failed: session=%s turn=%s error=%s",
          session.id,
          admitted.turnId,
          terminalErr?.message || terminalErr,
        );
        return {
          ok: false,
          reason: "TERMINAL_CAS_ERROR",
          outcomeUnknown: true,
          turn: admitted,
        };
      }
    },

    _invokePreparedEngineDispatch(session, state, runner, options = {}) {
      return this._withDispatchLinearization(() => {
        const selection = options.queueSelection || null;
        if (selection) {
          const current = this._revalidateQueueDispatchSelection(selection);
          if (!current.ok) return current;
        } else if (
          state.admittedTurnInput?.ownerScope
          && typeof this.ctx.sessionManager?.resolveTurnOwnerScope === "function"
        ) {
          const currentOwner = this.ctx.sessionManager.resolveTurnOwnerScope(
            session.id,
          );
          if (
            !currentOwner?.ok
            || currentOwner.ownerScope !== state.admittedTurnInput.ownerScope
          ) {
            return {
              ok: false,
              ownerPause: true,
              error: currentOwner?.error || "OWNER_SCOPE_MISMATCH",
            };
          }
        }

        const dispatch = this._prepareTurnDispatch(session, state, options);
        if (!dispatch.ok) return dispatch;
        // Crash-matrix seam: a crash HERE leaves a durable `dispatching` row
        // with no engine side effect — recovered as outcome-unknown, never
        // auto-replayed. Must stay between the claim CAS and the engine call.
        this._injectTurnDispatchFault("after_dispatch_claim", {
          sessionId: session.id,
          turnId: state.turnId,
          dispatchAttemptId: dispatch.attemptId,
        });
        if (state.scheduledTask?.runId) {
          this.ctx.scheduledTaskManager?.markRunStarted?.(
            state.scheduledTask.runId,
            state.turnId,
            dispatch.attemptId,
            dispatch.startedAt,
          );
        }
        try {
          state.enginePayload.attemptId = dispatch.attemptId;
          const sent = runner.sendUserMessage(state.enginePayload);
          if (!sent) {
            const terminal = this._markPreSendFailure(
              session,
              state,
              "pre_send_rejected",
            );
            return {
              ok: false,
              preSendFailure: true,
              error: "RUNNER_REJECTED",
              terminal,
              attemptId: dispatch.attemptId,
            };
          }
        } catch (err) {
          const terminal = this._markPreSendFailure(
            session,
            state,
            "pre_send_throw",
            err,
          );
          return {
            ok: false,
            preSendFailure: true,
            error: "PRE_SEND_THROW",
            detail: err?.message || String(err),
            terminal,
            attemptId: dispatch.attemptId,
          };
        }
        return dispatch;
      });
    },

    _injectTurnDispatchFault(phase, payload = {}) {
      if (typeof this.ctx.turnDispatchFaultInjector === "function") {
        try {
          this.ctx.turnDispatchFaultInjector(phase, payload);
        } catch (err) {
          if (err && typeof err === "object") {
            err.code = "TURN_DISPATCH_CRASH_INJECTION";
          }
          throw err;
        }
      }
    },
  };
}

module.exports = {
  OUTCOME_UNKNOWN_STATUSES,
  createTurnDispatchMethods,
};
