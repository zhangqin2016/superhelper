"use strict";

/**
 * Stage timings for a hot path, printed only when the named env flag is "1".
 *
 * A customer's "switching sessions is slow" cannot be reproduced on a
 * developer's Mac when its cause is a Windows file scan per open, so the
 * breakdown has to be obtainable from the field: set the flag, switch once,
 * read one line. Off, every call is a no-op on a shared frozen object.
 */
const OFF = Object.freeze({ mark() {}, report() {} });

function stageProfile(flagEnv, log = console) {
  if (process.env[flagEnv] !== "1") return OFF;
  const stages = [];
  let tick = performance.now();
  return {
    mark(name) {
      const now = performance.now();
      stages.push(`${name}=${(now - tick).toFixed(0)}ms`);
      tick = now;
    },
    report(prefix) {
      log.info(`${prefix}: ${stages.join(" ")}`);
    },
  };
}

module.exports = { stageProfile };
