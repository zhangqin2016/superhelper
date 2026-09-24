#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      ipcMain: {
        on() {},
        handle() {},
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { createWatchdog } = await import("../src/main/app-watchdog.js");
Module._load = originalLoad;

let now = 1_000;
const records = [];
const watchdog = createWatchdog({
  now: () => now,
  tickMs: 1_000,
  rendererStaleMs: 5_000,
  mainLagMs: 2_000,
  appendRecord: (record) => records.push(record),
  log: { info() {}, warn() {}, error() {} },
});

assert.equal(watchdog.checkMainLoop(), null, "initial main tick must not warn");
watchdog.receiveRendererHeartbeat({ seq: 1, rendererLagMs: 100, visibilityState: "visible" });
now += 4_000;
assert.equal(watchdog.checkRendererHeartbeat(), null, "fresh renderer heartbeat must not warn");

now += 1_500;
const stale = watchdog.checkRendererHeartbeat();
assert.equal(stale.kind, "renderer_heartbeat_stale");
assert.equal(stale.rendererSeq, 1);
assert(stale.staleMs >= 5_500, "stale record carries elapsed time");

watchdog.receiveRendererHeartbeat({ seq: 2, rendererLagMs: 6_000, visibilityState: "visible" });
assert.equal(records.at(-1).kind, "renderer_event_loop_lag", "renderer-reported lag is recorded");

const mainOnly = createWatchdog({
  now: () => now,
  tickMs: 1_000,
  rendererStaleMs: 5_000,
  mainLagMs: 2_000,
  appendRecord: (record) => records.push(record),
  log: { info() {}, warn() {}, error() {} },
});
assert.equal(mainOnly.checkMainLoop(), null, "initial main-only tick must not warn");
now += 1_000;
assert.equal(mainOnly.checkMainLoop(), null, "normal main tick must not warn");
now += 4_000;
const mainLag = mainOnly.checkMainLoop();
assert.equal(mainLag.kind, "main_event_loop_lag");
assert(mainLag.lagMs >= 3_000, "main lag subtracts the expected tick interval");

const snapshot = watchdog.snapshot({ activeSessionId: "s1" });
assert.equal(snapshot.ok, true);
assert.equal(snapshot.activeSessionId, "s1");
assert(snapshot.recent.some((item) => item.kind === "renderer_heartbeat_stale"), "snapshot keeps renderer stale records");
assert(snapshot.recent.some((item) => item.kind === "renderer_event_loop_lag"), "snapshot keeps renderer lag records");

// ------------------------------------------------ a sleeping machine is not a frozen app
// 2026-09-23: both "main event loop lag" warnings of the day (136,715 and
// 2,841,042 ms) were clamshell sleeps, matched to the second by the power log.
for (const sleptMs of [139_000, 2_843_000]) {
  let wall = 10_000;
  let mono = 10_000;
  const logged = [];
  const dog = createWatchdog({
    now: () => wall,
    monotonic: () => mono,
    tickMs: 1_000,
    rendererStaleMs: 10_000,
    mainLagMs: 2_000,
    appendRecord: (record) => logged.push(record),
    log: { info() {}, warn() {}, error() {} },
  });
  dog.receiveRendererHeartbeat({ seq: 1 });
  wall += 1_000; mono += 1_000;
  assert.equal(dog.checkMainLoop(), null);
  // Asleep: the wall clock runs, the monotonic clock stands still.
  wall += sleptMs + 1_000; mono += 1_000;
  assert.equal(dog.checkMainLoop(), null, `a ${sleptMs}ms sleep is not main-loop lag`);
  assert.equal(dog.checkRendererHeartbeat(), null, "nor a stale renderer");
  const sleep = logged.find((record) => record.kind === "system_sleep");
  assert.equal(sleep?.sleptMs, sleptMs, "the sleep is reported as a sleep, with its length");
  assert.equal(logged.filter((record) => record.kind === "main_event_loop_lag").length, 0);

  // A real freeze still advances both clocks, and is still caught.
  wall += 6_000; mono += 6_000;
  const freeze = dog.checkMainLoop();
  assert.equal(freeze?.kind, "main_event_loop_lag", "a real freeze is still reported");
  assert.equal(freeze.lagMs, 5_000);
}

{
  // powerMonitor: a platform whose monotonic clock counts sleep still gets it right.
  let wall = 10_000;
  const logged = [];
  const dog = createWatchdog({
    now: () => wall,
    monotonic: () => wall, // counts sleep, like a clock that never stops
    tickMs: 1_000, rendererStaleMs: 10_000, mainLagMs: 2_000,
    appendRecord: (record) => logged.push(record),
    log: { info() {}, warn() {}, error() {} },
  });
  dog.receiveRendererHeartbeat({ seq: 1 });
  dog.systemSuspended();
  wall += 600_000;
  const resumed = dog.systemResumed();
  assert.equal(resumed?.kind, "system_sleep");
  assert.equal(resumed.source, "power_monitor");
  wall += 1_000;
  assert.equal(dog.checkMainLoop(), null, "the first tick after waking measures from the wake, not from before the sleep");
  assert.equal(dog.checkRendererHeartbeat(), null);
  assert.equal(logged.filter((record) => record.kind === "system_sleep").length, 1);
}

{
  // Both signals seeing one sleep report it once.
  let wall = 10_000;
  let mono = 10_000;
  const logged = [];
  const dog = createWatchdog({
    now: () => wall, monotonic: () => mono, tickMs: 1_000, mainLagMs: 2_000,
    appendRecord: (record) => logged.push(record),
    log: { info() {}, warn() {}, error() {} },
  });
  dog.systemSuspended();
  wall += 300_000; mono += 1_000;
  dog.checkMainLoop();
  dog.systemResumed();
  assert.equal(logged.filter((record) => record.kind === "system_sleep").length, 1, "one sleep, one record");
}

const watchdogSource = fs.readFileSync(new URL("../src/main/app-watchdog.js", import.meta.url), "utf8");
assert.match(watchdogSource, /powerMonitor\?\.on\?\.\("resume"/, "the running watchdog listens for the system waking");

const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
assert.match(
  mainSource,
  /webPreferences:\s*\{[\s\S]*?backgroundThrottling:\s*false/,
  "main window must not throttle renderer heartbeats or task-progress projection while hidden",
);

console.log("app-watchdog: ok");
