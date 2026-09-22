"use strict";

/**
 * Stage timings for a hot path.
 *
 * A customer's "switching sessions is slow" cannot be reproduced on a
 * developer's Mac when its cause is a Windows file scan per open, so the
 * breakdown has to be obtainable from the field.
 *
 * Until 2026-09-22 it was obtainable only by setting a flag BEFORE the slow
 * switch happened — which is backwards: the flag is set after someone notices,
 * and by then the slow switch is over. A 6-second warm-up was reported with
 * nothing to say which stage spent the six seconds. So the stages are always
 * measured (a handful of clock reads against work measured in milliseconds) and
 * the line is printed when the path was actually slow, or when the flag forces
 * it. A fast path still says nothing.
 */

const DEFAULT_SLOW_MS = 250;

function slowThreshold() {
  const raw = Number(process.env.LILY_STAGE_PROFILE_SLOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SLOW_MS;
}

function stageProfile(flagEnv, log = console, options = {}) {
  const forced = process.env[flagEnv] === "1";
  const slowMs = Number.isFinite(options.slowMs) ? options.slowMs : slowThreshold();
  // Not every host that loads main-process modules provides a global
  // `performance` (test fixtures and older embedders do not); a profiler that
  // throws where it used to be a no-op would be a worse bug than the one it
  // measures. Millisecond resolution is ample for a threshold in the hundreds.
  const clock = typeof globalThis.performance?.now === "function"
    ? () => globalThis.performance.now()
    : () => Date.now();
  const now = typeof options.now === "function" ? options.now : clock;
  const stages = [];
  const startedAt = now();
  let tick = startedAt;
  return {
    mark(name) {
      const at = now();
      stages.push(`${name}=${(at - tick).toFixed(0)}ms`);
      tick = at;
    },
    report(prefix) {
      const total = now() - startedAt;
      // Silence is the normal case; it must stay free of any formatting work.
      if (!forced && total < slowMs) return null;
      const line = `${prefix}: total=${total.toFixed(0)}ms ${stages.join(" ")}`;
      (forced ? log.info : (log.warn || log.info)).call(log, line);
      return line;
    },
  };
}

module.exports = { stageProfile, DEFAULT_SLOW_MS };
