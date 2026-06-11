"use strict";

/**
 * Deferred-result gate: when the CLI's `result` arrives while blocking work
 * (foreground tools, permissions, hooks) is still outstanding, the result is
 * held and re-polled, releasing as soon as the blockers clear — or
 * force-released once the grace window expires so a stuck blocker can never
 * hang the turn forever.
 *
 * Timing config is read at use time (tests shrink the AgentSession statics
 * after instances exist).
 */
class DeferredResultGate {
  /**
   * @param {object} deps
   * @param {import("./turn-timers").TimerBank} deps.timers uses "deferredResult"
   * @param {() => number} deps.graceMs
   * @param {() => boolean} deps.isTurnLive busy && not settled
   * @param {() => boolean} deps.hasBlockers pending tools/permissions/hooks
   * @param {(payload: object) => void} deps.release completes the turn
   * @param {() => void} [deps.onStaleRelease] grace expired with blockers left
   * @param {() => void} [deps.onCleanRelease] blockers clear (bg housekeeping)
   */
  constructor({ timers, graceMs, isTurnLive, hasBlockers, release, onStaleRelease, onCleanRelease }) {
    this._timers = timers;
    this._graceMs = graceMs;
    this._isTurnLive = isTurnLive;
    this._hasBlockers = hasBlockers;
    this._release = release;
    this._onStaleRelease = onStaleRelease;
    this._onCleanRelease = onCleanRelease;
    this._payload = null;
    this._deferredAt = 0;
  }

  get pending() {
    return this._payload != null;
  }

  defer(payload) {
    this._payload = payload;
    this._deferredAt = Date.now();
    this.armPoll();
  }

  armPoll() {
    this._timers.clear("deferredResult");
    if (!this._isTurnLive() || !this._payload) return;
    const elapsedMs = Math.max(0, Date.now() - Number(this._deferredAt || Date.now()));
    const remainingGraceMs = Math.max(0, this._graceMs() - elapsedMs);
    const delay = this._hasBlockers() ? Math.max(25, remainingGraceMs || 25) : 25;
    this._timers.arm("deferredResult", delay, () => {
      this.poll();
    });
  }

  poll() {
    if (!this._isTurnLive() || !this._payload) return false;
    if (this._hasBlockers()) {
      const elapsedMs = Math.max(0, Date.now() - Number(this._deferredAt || Date.now()));
      if (elapsedMs < this._graceMs()) {
        this.armPoll();
        return false;
      }
      this._onStaleRelease?.();
    } else {
      this._onCleanRelease?.();
    }
    const payload = this._payload;
    this._payload = null;
    this._deferredAt = 0;
    this._timers.clear("deferredResult");
    this._release(payload);
    return true;
  }

  clear() {
    this._payload = null;
    this._deferredAt = 0;
    this._timers.clear("deferredResult");
  }
}

module.exports = { DeferredResultGate };
