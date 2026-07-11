#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { prepareTurnCapabilityReadiness } = require("../src/main/turn-orchestrator.js");

const order = [];
const ready = await prepareTurnCapabilityReadiness({
  ctx: {},
  sessionId: "s1",
  turnId: "t1",
  text: "打开浏览器截图",
  files: [],
  deps: {
    plan: () => ({
      requiredPackIds: ["web-automation"],
      enhancementPackIds: [],
      fallbackCapabilityIds: ["code-static-review"],
    }),
    installed: () => new Set(),
    installing: () => new Set(),
    prepare: async () => {
      order.push("prepare");
      return {
        ok: true,
        readyPackIds: ["web-automation"],
        failedPackIds: [],
        unavailablePackIds: [],
        refreshRequired: true,
      };
    },
    refresh: () => order.push("refresh"),
  },
});
assert.deepEqual(order, ["prepare", "refresh"]);
assert.equal(ready.status, "ready");
assert.deepEqual(ready.readyPackIds, ["web-automation"]);

const degraded = await prepareTurnCapabilityReadiness({
  ctx: {},
  sessionId: "s1",
  turnId: "t2",
  text: "打开浏览器截图",
  deps: {
    plan: () => ({
      requiredPackIds: ["web-automation"],
      enhancementPackIds: [],
      fallbackCapabilityIds: ["code-static-review"],
    }),
    installed: () => new Set(),
    installing: () => new Set(),
    prepare: async () => ({
      ok: false,
      readyPackIds: [],
      failedPackIds: [],
      unavailablePackIds: ["web-automation"],
      refreshRequired: false,
    }),
    refresh: () => {
      throw new Error("degraded preparation must not restart the runner");
    },
  },
});
assert.equal(degraded.status, "degraded");
assert.deepEqual(degraded.unavailablePackIds, ["web-automation"]);

const baseline = await prepareTurnCapabilityReadiness({
  ctx: {},
  sessionId: "s1",
  turnId: "t3",
  text: "hello",
  deps: { plan: () => { throw new Error("planner exploded"); } },
});
assert.equal(baseline.status, "baseline");
assert.match(baseline.error, /planner exploded/);

console.log("turn-dependency-readiness: ok");
