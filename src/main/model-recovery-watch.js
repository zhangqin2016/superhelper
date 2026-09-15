"use strict";

/**
 * Model recovery watch — "resume when the provider comes back".
 *
 * Started after a turn died because the model returned nothing (first-response
 * watchdog + rescue retries exhausted). Probes the model route on a fixed
 * cadence, bounded in attempts and wall clock, and fires `onReady` exactly
 * once when a probe succeeds. One watch per key (session); a newer start
 * replaces an older one; `cancel` (user sent a new message, session deleted,
 * app quitting) stops it silently. Timers are injectable for tests.
 *
 * Kill switch: LILY_MODEL_RECOVERY_WATCH=0.
 */

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 15; // ~15 minutes at the default cadence
const watches = new Map();

function enabled() {
  return process.env.LILY_MODEL_RECOVERY_WATCH !== "0";
}

function startModelRecoveryWatch({
  key,
  probe,
  onReady,
  onGiveUp = null,
  onAttempt = null,
  intervalMs = Number(process.env.LILY_MODEL_RECOVERY_WATCH_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
  maxAttempts = Number(process.env.LILY_MODEL_RECOVERY_WATCH_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const watchKey = String(key || "").trim();
  if (!watchKey || typeof probe !== "function" || typeof onReady !== "function") return null;
  if (!enabled()) return null;
  cancelModelRecoveryWatch(watchKey, clearTimeoutImpl);
  const watch = {
    key: watchKey,
    attempts: 0,
    maxAttempts: Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS),
    intervalMs: Math.max(1_000, Number(intervalMs) || DEFAULT_INTERVAL_MS),
    startedAt: Date.now(),
    timer: null,
    done: false,
    probing: false,
  };
  const finish = () => {
    watch.done = true;
    if (watch.timer) clearTimeoutImpl(watch.timer);
    watch.timer = null;
    if (watches.get(watchKey) === watch) watches.delete(watchKey);
  };
  const tick = async () => {
    watch.timer = null;
    if (watch.done || watch.probing) return;
    watch.probing = true;
    watch.attempts += 1;
    let result;
    try { result = await probe({ attempt: watch.attempts }); } catch (error) { result = { ok: false, reason: error?.message || "PROBE_ERROR" }; }
    watch.probing = false;
    if (watch.done) return;
    try { onAttempt?.({ attempt: watch.attempts, result }); } catch { /* observer */ }
    if (result?.ok) {
      finish();
      try { await onReady({ attempts: watch.attempts, result }); } catch { /* the continuation lane logs its own failures */ }
      return;
    }
    if (watch.attempts >= watch.maxAttempts) {
      finish();
      try { onGiveUp?.({ attempts: watch.attempts, lastResult: result }); } catch { /* observer */ }
      return;
    }
    watch.timer = setTimeoutImpl(tick, watch.intervalMs);
    watch.timer?.unref?.();
  };
  watches.set(watchKey, watch);
  watch.timer = setTimeoutImpl(tick, watch.intervalMs);
  watch.timer?.unref?.();
  return {
    key: watchKey,
    cancel: () => finish(),
    /** Test hook: run the next probe now instead of waiting for the timer. */
    probeNow: () => tick(),
    get attempts() { return watch.attempts; },
    get done() { return watch.done; },
  };
}

function cancelModelRecoveryWatch(key, clearTimeoutImpl = clearTimeout) {
  const watch = watches.get(String(key || "").trim());
  if (!watch) return false;
  watch.done = true;
  if (watch.timer) clearTimeoutImpl(watch.timer);
  watch.timer = null;
  watches.delete(watch.key);
  return true;
}

function hasModelRecoveryWatch(key) {
  return watches.has(String(key || "").trim());
}

function resetModelRecoveryWatchesForTests() {
  for (const watch of watches.values()) { if (watch.timer) clearTimeout(watch.timer); watch.done = true; }
  watches.clear();
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_ATTEMPTS,
  startModelRecoveryWatch,
  cancelModelRecoveryWatch,
  hasModelRecoveryWatch,
  resetModelRecoveryWatchesForTests,
};
