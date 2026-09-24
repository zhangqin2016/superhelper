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
// Replayed from the power log of 2026-09-24 (local time): clamshell sleep at
// 08:49:55, a DarkWake at 08:51:29 where the timer fired with no resume event
// (reported as lag 91,467 ms), sleep again, full wake at 09:18:38 where the
// first tick beat the resume event (reported as lag 1,581,298 ms).
{
  let wall = Date.parse("2026-09-24T04:49:50Z");
  const logged = [];
  const dog = createWatchdog({
    now: () => wall,
    tickMs: 1_000, rendererStaleMs: 10_000, mainLagMs: 2_000,
    appendRecord: (record) => logged.push(record),
    log: { info() {}, warn() {}, error() {} },
  });
  dog.receiveRendererHeartbeat({ seq: 1 });
  wall += 1_000; assert.equal(dog.checkMainLoop(), null);
  wall = Date.parse("2026-09-24T04:49:55Z"); dog.systemSuspended();
  wall = Date.parse("2026-09-24T04:51:29Z");
  assert.equal(dog.checkMainLoop(), null, "a DarkWake tick is the sleep, not lag");
  assert.equal(dog.checkRendererHeartbeat(), null, "nor a stale renderer");
  wall = Date.parse("2026-09-24T05:18:38Z");
  assert.equal(dog.checkMainLoop(), null, "the first tick after waking may beat the resume event, and is still the sleep");
  assert.equal(dog.checkRendererHeartbeat(), null);
  const resumed = dog.systemResumed();
  assert.equal(resumed?.kind, "system_sleep");
  assert.equal(resumed.sleptMs, Date.parse("2026-09-24T05:18:38Z") - Date.parse("2026-09-24T04:49:55Z"), "the whole sleep, measured from suspend");
  wall += 1_000;
  assert.equal(dog.checkMainLoop(), null, "after waking, time is measured from the wake");
  assert.equal(logged.filter((record) => record.kind === "main_event_loop_lag" || record.kind === "renderer_heartbeat_stale").length, 0,
    "neither warning of that morning is raised");
  assert.equal(logged.filter((record) => record.kind === "system_sleep").length, 1, "one sleep, one record");

  // A real freeze afterwards is still caught.
  wall += 6_000;
  const freeze = dog.checkMainLoop();
  assert.equal(freeze?.kind, "main_event_loop_lag", "a real freeze is still reported");
  assert.equal(freeze.lagMs, 5_000);
}

{
  // A resume with no suspend seen records nothing and still resets baselines.
  let wall = 10_000;
  const logged = [];
  const dog = createWatchdog({ now: () => wall, tickMs: 1_000, mainLagMs: 2_000, appendRecord: (r) => logged.push(r), log: { info() {}, warn() {}, error() {} } });
  wall += 60_000;
  assert.equal(dog.systemResumed(), null);
  wall += 1_000;
  assert.equal(dog.checkMainLoop(), null);
  assert.equal(logged.length, 0);
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
