"use strict";

/**
 * When may a shared engine be retired while the app keeps running?
 *
 * A collaboration task application needs the workspace to itself: the engine
 * holds a process group that may still write files, so the application asks it
 * to stand down by creating a coordination request, and the engine retires once
 * nothing is left running. Ordinary conversation must never be affected by
 * this, which is what the two conditions below guarantee by construction:
 *
 *   1. a request must exist (a fresh, empty, single-link file written by the
 *      foreground writer). Without one — every ordinary session — the answer is
 *      "no" before any view is consulted.
 *   2. every retained view must positively report itself inactive. A view that
 *      cannot say (no reporter, or a reporter that throws) counts as active, so
 *      an unknown state keeps the engine alive rather than killing a turn.
 *
 * Kept out of the engine host so that file has one subject — starting, serving
 * and stopping the engine — and this policy can be read and tested on its own.
 */
function createEngineIdleDrain({ writerLockPath, retire, log, stateOf = () => ({}), intervalMs = 250 } = {}) {
  const views = new Set();
  const writer = require("../collaboration/foreground-writer").createForegroundWriter({ filePath: writerLockPath });
  let timer = null;

  /** @param {() => boolean} [isActive] a view's own report; absent means "cannot say". */
  function retainView(isActive) {
    const view = { isActive };
    views.add(view);
    return () => views.delete(view);
  }

  /** Pure policy: the engine's own state is read through stateOf, never kept here. */
  function idle() {
    const { terminated = false, activeWork = 0, ready = false } = stateOf() || {};
    if (terminated || !ready || activeWork) return false;
    if (!writer.idleRequested()) return false;
    for (const view of views) {
      try {
        if (typeof view.isActive !== "function" || view.isActive() !== false) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try {
        if (idle()) retire();
      } catch (error) {
        log?.warn?.("idle drain failed: %s", error?.code || "unavailable");
      }
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { retainView, idle, start, stop, get viewCount() { return views.size; } };
}

module.exports = { createEngineIdleDrain };
