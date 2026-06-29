#!/usr/bin/env node

import assert from "node:assert/strict";
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

console.log("app-watchdog: ok");
