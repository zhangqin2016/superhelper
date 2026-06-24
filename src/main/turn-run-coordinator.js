"use strict";

/**
 * Small Lily equivalent of OpenCode's run coordinator.
 *
 * Guarantees one active drain per session key while letting different sessions
 * run independently. Wakes are coalesced: if a session is already draining, the
 * newest wake is remembered and drained once the active run exits. Interrupts
 * advance a boundary so stale queued wakes cannot resurrect an old turn.
 */
class TurnRunCoordinator {
  constructor() {
    this._entries = new Map();
  }

  wake(key, admittedSeq, drain) {
    const sessionKey = String(key || "");
    if (!sessionKey) return Promise.resolve({ ok: false, error: "NO_KEY" });
    if (!Number.isInteger(admittedSeq) || admittedSeq <= 0) {
      return Promise.resolve({ ok: false, error: "INVALID_SEQ" });
    }
    if (typeof drain !== "function") {
      return Promise.resolve({ ok: false, error: "INVALID_DRAIN" });
    }
    const entry = this._entry(sessionKey);
    if (admittedSeq <= entry.interruptBoundary) {
      return Promise.resolve({ ok: false, stale: true, error: "STALE_WAKE" });
    }
    entry.pending = { admittedSeq, drain };
    if (entry.active) {
      return entry.active.then(() => ({ ok: true, joined: true }));
    }
    entry.active = this._drainLoop(sessionKey, entry);
    return entry.active;
  }

  interrupt(key, boundarySeq = null) {
    const sessionKey = String(key || "");
    if (!sessionKey) return { ok: false, error: "NO_KEY" };
    const entry = this._entry(sessionKey);
    const pendingSeq = entry.pending?.admittedSeq || 0;
    const nextBoundary = Number.isInteger(boundarySeq)
      ? boundarySeq
      : Math.max(entry.interruptBoundary, pendingSeq);
    entry.interruptBoundary = Math.max(entry.interruptBoundary, nextBoundary);
    if (entry.pending && entry.pending.admittedSeq <= entry.interruptBoundary) {
      entry.pending = null;
    }
    return { ok: true, boundarySeq: entry.interruptBoundary };
  }

  isActive(key) {
    const entry = this._entries.get(String(key || ""));
    return Boolean(entry?.active);
  }

  _entry(key) {
    let entry = this._entries.get(key);
    if (!entry) {
      entry = {
        active: null,
        pending: null,
        interruptBoundary: 0,
      };
      this._entries.set(key, entry);
    }
    return entry;
  }

  async _drainLoop(key, entry) {
    try {
      let ran = 0;
      while (entry.pending) {
        const wake = entry.pending;
        entry.pending = null;
        if (wake.admittedSeq <= entry.interruptBoundary) continue;
        ran += 1;
        await wake.drain({ key, admittedSeq: wake.admittedSeq });
      }
      return { ok: true, ran };
    } finally {
      entry.active = null;
      if (entry.pending) {
        entry.active = this._drainLoop(key, entry);
      }
    }
  }
}

module.exports = { TurnRunCoordinator };
