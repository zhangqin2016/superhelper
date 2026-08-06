"use strict";

function createTurnQueueDispatchMethods({
  documentDeliveryDispatchOptions,
  log,
  scheduledQueueCapacityBlock,
  scheduledTaskTurnOptions,
}) {
  return {
    async _dispatchNext(sessionId) {
      // A trigger that arrives while a dispatch pass is in flight must not be
      // dropped: await the current pass, then run a fresh one. Otherwise a
      // busy-retry timer (or nothing at all) would strand a queued turn whose
      // preconditions changed right after the in-flight pass checked them.
      for (;;) {
        const inFlight = this.dispatchInFlight.get(sessionId);
        if (!inFlight) break;
        try {
          await inFlight;
        } catch {
          // The owning pass already logged its failure.
        }
      }
      let pass;
      pass = (async () => {
        try {
          await this._dispatchNextUnlocked(sessionId);
        } finally {
          this.dispatchInFlight.delete(sessionId);
          const state = this.states.get(sessionId);
          if (
            state?.phase === "idle"
            && state.queue.length > 0
            && !this.dispatchRetryTimers.has(sessionId)
          ) {
            queueMicrotask(() => void this._dispatchNext(sessionId));
          }
        }
      })();
      this.dispatchInFlight.set(sessionId, pass);
      return pass;
    },

    async _dispatchNextUnlocked(sessionId) {
      const state = this._state(sessionId);
      if (state.phase !== "idle" || state.startInFlight || state.queue.length === 0) return;
      this._clearDispatchRetry(sessionId);
      const next = state.queue[0];
      // Pin this dispatch attempt to the exact queue item, its durable turn
      // and the current principal epoch. Anything asynchronous below
      // (preflight, compaction) must revalidate this selection before claiming
      // dispatch or touching the engine, and completion must remove THIS item
      // by identity — never whatever happens to be the head after an account
      // switch.
      const queueSelection = next?.admittedTurnInput?.turnId
        && next?.admittedTurnInput?.ownerScope
        ? this._captureQueueDispatchSelection(sessionId, next)
        : null;
      let result;
      try {
        result = await this._tryStartQueuedItem(sessionId, next, queueSelection);
        if (result?.retry) {
          // RUNNER_BUSY retry: the orchestrator turn already finalized (we
          // only reach here with phase === "idle"), so a runner that STILL
          // reports busy is wedged — its abort never settled, or the engine
          // never sent idle. Retrying against it forever is exactly the
          // "shows idle but the message stays queued" bug. Give a short grace
          // for a normal abort-settle, then recycle the runner and dispatch
          // fresh.
          if (result.error === "RUNNER_BUSY") {
            state.dispatchBusyRetries = (state.dispatchBusyRetries || 0) + 1;
            if (state.dispatchBusyRetries >= this.constructor.STALE_RUNNER_BUSY_DISPATCHES) {
              log.warn(
                "queued dispatch: runner wedged busy while session idle (%d retries) — recycling: session=%s",
                state.dispatchBusyRetries,
                sessionId,
              );
              state.dispatchBusyRetries = 0;
              try {
                this.ctx.runnerPool?.terminateSession?.(sessionId);
              } catch (err) {
                log.warn("wedged-runner recycle failed: %s", err?.message || err);
              }
              void this._dispatchNext(sessionId);
              return;
            }
          }
          this._scheduleDispatchRetry(sessionId);
          return;
        }
        state.dispatchBusyRetries = 0;
        if (!result?.ok) {
          if (result?.ownerPause) {
            this._pauseQueuedItemInMemory(
              sessionId,
              next,
              result.error || "OWNER_SCOPE_MISMATCH",
            );
            return;
          }
          if (result?.outcomeUnknown || result?.staleAdmission) {
            this._pauseQueuedItemInMemory(
              sessionId,
              next,
              result?.outcomeUnknown
                ? "DISPATCH_OUTCOME_UNKNOWN"
                : "STALE_DURABLE_ADMISSION",
            );
            return;
          }
          const terminalized = this._terminalizeQueuedItem(
            sessionId,
            next,
            result?.error || "QUEUE_DISPATCH_FAILED",
          );
          if (!terminalized.ok) {
            if (terminalized.outcomeUnknown) {
              this._pauseQueuedItemInMemory(
                sessionId,
                next,
                "DISPATCH_OUTCOME_UNKNOWN",
              );
            } else {
              this._scheduleDispatchRetry(sessionId);
            }
            return;
          }
          this._removeDispatchedQueueItem(state, next);
          this._emitQueue(sessionId);
          if (state.phase === "idle" && state.queue.length > 0) {
            void this._dispatchNext(sessionId);
          }
          return;
        }
        this._removeDispatchedQueueItem(state, next);
        this._emitQueue(sessionId);
        if (state.phase === "idle" && state.queue.length > 0) {
          void this._dispatchNext(sessionId);
        }
      } catch (err) {
        log.warn("_dispatchNext error: %s", err?.message || err);
        const activeDispatchAttemptId = state.dispatchAttemptId
          || state.admittedTurnInput?.dispatchAttemptId
          || next.dispatchAttemptId
          || null;
        if (activeDispatchAttemptId || err?.code === "TURN_DISPATCH_CRASH_INJECTION") {
          const admitted = next.admittedTurnInput?.turnId
            ? this.ctx.sessionManager?.getTurnInputByTurnId?.(
                sessionId,
                next.admittedTurnInput.turnId,
              )
            : null;
          if (admitted) {
            this._recordDispatchOutcomeUnknown?.(
              sessionId,
              admitted,
              "fault_injection",
            );
          }
          if (state.turnId && state.turnId === next.admittedTurnInput?.turnId) {
            // The durable row is intentionally left outcome-unknown, but the
            // in-memory turn must close as well. Otherwise the renderer may
            // show recovery while the main session remains stuck in `starting`
            // until the multi-minute sweeper runs.
            require("./turn-terminal-finalizer").clearTurnState(state);
          }
          this._pauseQueuedItemInMemory(
            sessionId,
            next,
            "DISPATCH_OUTCOME_UNKNOWN",
          );
          return;
        }
        const terminalized = this._terminalizeQueuedItem(
          sessionId,
          next,
          err?.name || "QUEUE_DISPATCH_EXCEPTION",
        );
        if (!terminalized.ok) {
          if (terminalized.outcomeUnknown) {
            this._pauseQueuedItemInMemory(
              sessionId,
              next,
              "DISPATCH_OUTCOME_UNKNOWN",
            );
          } else {
            this._scheduleDispatchRetry(sessionId);
          }
          return;
        }
        this._removeDispatchedQueueItem(state, next);
        this._emitQueue(sessionId);
        if (state.phase === "idle" && state.queue.length > 0) {
          void this._dispatchNext(sessionId);
        }
      }
    },

    _scheduleDispatchRetry(sessionId) {
      if (!sessionId || this.dispatchRetryTimers.has(sessionId)) return;
      const timer = setTimeout(() => {
        this.dispatchRetryTimers.delete(sessionId);
        void this._dispatchNext(sessionId);
      }, this.constructor.QUEUE_RETRY_DELAY_MS);
      timer.unref?.();
      this.dispatchRetryTimers.set(sessionId, timer);
    },

    _clearDispatchRetry(sessionId) {
      const timer = this.dispatchRetryTimers.get(sessionId);
      if (!timer) return;
      clearTimeout(timer);
      this.dispatchRetryTimers.delete(sessionId);
    },

    async _tryStartQueuedItem(sessionId, item, queueSelection = null) {
      const session = this.ctx.sessionManager.findById(sessionId);
      if (!session) return { ok: false, error: "NO_SESSION" };
      if (queueSelection) {
        const current = this._revalidateQueueDispatchSelection(queueSelection);
        if (!current.ok) return current;
      } else if (typeof this.ctx.sessionManager?.resolveTurnOwnerScope === "function") {
        const currentOwner = this.ctx.sessionManager.resolveTurnOwnerScope(
          sessionId,
        );
        const admittedOwner = item.admittedTurnInput?.ownerScope || null;
        if (
          !currentOwner?.ok
          || !admittedOwner
          || currentOwner.ownerScope !== admittedOwner
        ) {
          return {
            ok: false,
            ownerPause: true,
            error: currentOwner?.error || "OWNER_SCOPE_MISMATCH",
          };
        }
      }
      if (!item.options?.localAssistant) {
        const capacityBlock = scheduledQueueCapacityBlock(this.ctx, item);
        if (capacityBlock) return capacityBlock;
        const runner = this.ctx.runnerPool.get(sessionId);
        if (runner?.isBusy?.()) return { ok: false, retry: true, error: "RUNNER_BUSY" };
        if (item.options?.reloadSkillsBeforeStart && runner?.isAlive?.() && !runner.reloadSkills()) {
          this.ctx.runnerPool.terminateSession(sessionId);
        }
      }
      if (item.options?.localAssistant) {
        const dispatchClaim = this._withDispatchLinearization(() => {
          if (queueSelection) {
            const current = this._revalidateQueueDispatchSelection(
              queueSelection,
            );
            if (!current.ok) return current;
          }
          return this._claimTurnDispatch(session, item.admittedTurnInput);
        });
        if (!dispatchClaim.ok) {
          if (dispatchClaim.outcomeUnknown) {
            this._recordDispatchOutcomeUnknown?.(
              sessionId,
              dispatchClaim.turn,
              dispatchClaim.reason,
            );
          }
          return {
            ...dispatchClaim,
            ok: false,
            error: dispatchClaim.error
              || dispatchClaim.reason
              || "DISPATCH_CAS_FAILED",
            outcomeUnknown: Boolean(dispatchClaim.outcomeUnknown),
            staleAdmission: !dispatchClaim.outcomeUnknown
              && !dispatchClaim.ownerPause,
          };
        }
        if (dispatchClaim.turn) item.admittedTurnInput = dispatchClaim.turn;
        item.dispatchAttemptId = dispatchClaim.attemptId || null;
        this._injectTurnDispatchFault("after_dispatch_claim", {
          sessionId,
          turnId: item.admittedTurnInput?.turnId || null,
          dispatchAttemptId: item.dispatchAttemptId,
        });
        return await require("./turn-start-guard").guardLocalAssistantTurn(this, session, item.text, item.files, {
          fromQueue: true,
          displayFiles: item.displayFiles,
          assistant: item.options.localAssistant.assistant,
          scheduledDraft: item.options.localAssistant.scheduledDraft || null,
          turnId: item.options.localAssistant.turnId || null,
          admittedTurnInput: item.admittedTurnInput || null,
          dispatchAttemptId: item.dispatchAttemptId,
          queueSelection,
        });
      }
      return await require("./turn-start-guard").guardTurnStart(
        this,
        session,
        item.text,
        item.files,
        {
          fromQueue: true,
          displayFiles: item.displayFiles,
          recordUser: item.options?.recordUser !== false,
          spawnEngine: item.options?.spawnEngine !== false,
          skipPreflight: Boolean(item.options?.skipPreflight),
          skipVision: Boolean(item.options?.skipVision),
          skipDocument: Boolean(item.options?.skipDocument),
          ...scheduledTaskTurnOptions(item.options),
          engineText: item.options?.engineText || null,
          recovery: item.options?.recovery || null,
          sourceTaskCore: item.options?.sourceTaskCore || null,
          admittedTurnInput: item.admittedTurnInput || null,
          queueSelection,
          ...documentDeliveryDispatchOptions(item.options),
        },
      );
    },
  };
}

module.exports = { createTurnQueueDispatchMethods };
