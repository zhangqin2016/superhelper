#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { applyLiveEnvToPool, terminateIdleRunners } = require("../src/main/runner-live-config.js");

{
  const calls = [];
  const runners = new Map([
    ["s1", { isAlive: () => true, updateEnvironmentVariables: (patch) => { calls.push(["s1", patch]); return true; } }],
    ["s2", { isAlive: () => true, updateEnvironmentVariables: (patch) => { calls.push(["s2", patch]); return false; } }],
    ["dead", { isAlive: () => false, updateEnvironmentVariables: () => { throw new Error("dead runner should be skipped"); } }],
  ]);
  const pool = {
    getSessionIds: () => [...runners.keys()],
    get: (id) => runners.get(id),
  };
  const result = applyLiveEnvToPool(pool, { LILY_MODEL: "deepseek-v4-pro[1m]" });
  assert.deepEqual(result, { applied: ["s1"], failed: ["s2"] }, "failed hot updates are surfaced for restart");
  assert.deepEqual(calls.map((entry) => entry[0]), ["s1", "s2"], "only live runners are patched");
}

{
  const terminated = [];
  const runners = new Map([
    ["idle", { isAlive: () => true, isBusy: () => false }],
    ["busy", { isAlive: () => true, isBusy: () => true }],
    ["dead", { isAlive: () => false, isBusy: () => false }],
  ]);
  const pool = {
    getSessionIds: () => [...runners.keys()],
    get: (id) => runners.get(id),
    terminateSession: (id) => terminated.push(id),
  };
  terminateIdleRunners(pool);
  assert.deepEqual(terminated, ["idle"], "config rebuild only terminates idle live runners");
}

console.log("runner-live-config: ok");
