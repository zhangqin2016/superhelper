import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const {
  scheduleRuntimePackAutoRepair,
  startRuntimePackAutoRepair,
} = require("../src/main/runtime-pack-auto-repair");
const mainSource = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

assert.match(mainSource, /startRuntimePackAutoRepair\(\{/);
assert.doesNotMatch(mainSource, /packs\.repairInstalledRuntimePacks\(\)/);
assert.match(mainSource, /runtimePackAutoRepairRef\?\.cancel\?\.\(\)/);
assert.equal(typeof scheduleRuntimePackAutoRepair, "function");

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4321;
  child.connected = true;
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => child.killCalls.push(signal);
  return child;
}

{
  const child = fakeChild();
  let forkOptions = null;
  const priorityCalls = [];
  const job = startRuntimePackAutoRepair({
    forkImpl: (_workerPath, _args, options) => {
      forkOptions = options;
      return child;
    },
    basePaths: {
      userData: "/tmp/lily-user-data",
      home: "/tmp/lily-home",
      documents: "/tmp/lily-documents",
    },
    isPackaged: true,
    setPriority: (pid, priority) => priorityCalls.push([pid, priority]),
    backgroundPriority: 19,
    timeoutMs: 1_000,
  });

  assert.equal(forkOptions.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(forkOptions.env.LILY_USER_DATA_DIR, "/tmp/lily-user-data");
  assert.equal(forkOptions.env.LILY_HOME, "/tmp/lily-home");
  assert.equal(forkOptions.env.LILY_DOCUMENTS_DIR, "/tmp/lily-documents");
  assert.equal(forkOptions.env.LILY_IS_PACKAGED, "1");
  assert.deepEqual(forkOptions.stdio, ["ignore", "ignore", "pipe", "ipc"]);
  assert.deepEqual(priorityCalls, [[child.pid, 19]], "worker and inherited children must run at background priority");

  child.emit("message", { type: "runtime-pack-auto-repair-result", result: { ok: true, results: [] } });
  assert.deepEqual(await job.promise, { ok: true, results: [] });
}

{
  const scheduled = [];
  let idle = false;
  let starts = 0;
  const controller = scheduleRuntimePackAutoRepair({
    isIdle: () => idle,
    startRepair: () => {
      starts += 1;
      return { promise: Promise.resolve({ ok: true, results: [] }), cancel() {} };
    },
    initialDelayMs: 60_000,
    retryDelayMs: 30_000,
    scheduleTimeout: (fn, delay) => {
      const token = { fn, delay, cancelled: false };
      scheduled.push(token);
      return token;
    },
    cancelTimeout: (token) => { token.cancelled = true; },
  });
  assert.equal(scheduled[0].delay, 60_000);
  scheduled.shift().fn();
  assert.equal(starts, 0, "auto-repair must not compete with an active user");
  assert.equal(scheduled[0].delay, 30_000);
  idle = true;
  scheduled.shift().fn();
  assert.equal(starts, 1, "repair starts once the app is truly idle");
  assert.deepEqual(await controller.promise, { ok: true, results: [] });
}

{
  const child = fakeChild();
  const job = startRuntimePackAutoRepair({ forkImpl: () => child, timeoutMs: 1_000 });
  job.cancel();
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  await assert.rejects(job.promise, /cancelled/i);
}

{
  const child = fakeChild();
  const job = startRuntimePackAutoRepair({ forkImpl: () => child, timeoutMs: 1_000 });
  child.emit("exit", 2, null);
  await assert.rejects(job.promise, /exited before reporting.*2/i);
}

console.log("runtime-pack-auto-repair-worker: ok");
