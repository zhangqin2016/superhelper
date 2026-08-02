#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
const { createOpencodeTurnLiveness } = require("../src/main/opencode-turn-liveness.js");

assert.equal(
  OpencodeAgentSession.TURN_WATCHDOG_MS,
  0,
  "production default has no absolute wall-clock cap; progress/health/step guards remain authoritative",
);

function fakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = ++sequence;
      timers.set(id, { at: now + Number(delay), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    },
  };
}

const clock = fakeClock();
const state = { busy: true, turnSettled: false, collectedOutput: "" };
const completions = [];
const liveness = createOpencodeTurnLiveness({
  sessionId: "session-48h",
  getState: () => state,
  getConfig: () => ({
    responseTimeoutMs: 10 * 60_000,
    activeToolLeaseMs: 20 * 60_000,
    progressNoticeMs: 45_000,
    turnWatchdogMs: 0,
    healthProbeMs: 30_000,
    healthMaxFails: 3,
  }),
  now: clock.now,
  setTimeout: clock.setTimeout,
  clearTimeout: clock.clearTimeout,
  recoverStalledFinal: async () => null,
  completeTurn: (payload) => completions.push(payload),
});

liveness.armResponseTimer();
for (let interval = 0; interval < 48 * 12; interval += 1) {
  await clock.advance(5 * 60_000);
  liveness.armResponseTimer();
}
assert.equal(completions.length, 0, "48 hours of real progress is never force-ended");

await clock.advance(10 * 60_000 + 1);
await Promise.resolve();
assert.equal(completions.length, 1, "true no-progress still settles after the configured window");
assert.equal(completions[0].stalled, true);

console.log("long-turn-virtual-clock: ok");
