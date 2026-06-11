"use strict";

/**
 * Named-timer bank for AgentSession's watchdog timers. Replaces ten
 * hand-rolled `_armX/_clearX` field pairs with one uniform mechanism:
 * arming a name replaces any previous timer under it, and a fired timer
 * removes itself before running its callback (so `has()` is accurate
 * inside callbacks that re-arm, e.g. heartbeats).
 */
class TimerBank {
  constructor() {
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this._timers = new Map();
  }

  arm(name, delayMs, fn) {
    this.clear(name);
    this._timers.set(name, setTimeout(() => {
      this._timers.delete(name);
      fn();
    }, delayMs));
  }

  clear(name) {
    const timer = this._timers.get(name);
    if (timer === undefined) return;
    clearTimeout(timer);
    this._timers.delete(name);
  }

  has(name) {
    return this._timers.has(name);
  }

  /** Clear every timer whose name starts with `prefix` (e.g. "lease:"). */
  clearPrefix(prefix) {
    for (const name of [...this._timers.keys()]) {
      if (name.startsWith(prefix)) this.clear(name);
    }
  }

  clearAll() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
  }
}

module.exports = { TimerBank };
