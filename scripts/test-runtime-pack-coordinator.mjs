#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRuntimePackCoordinator } = require("../src/main/runtime-pack-coordinator.js");

const installCalls = [];
let active = 0;
let peak = 0;
const coordinator = createRuntimePackCoordinator({
  maxConcurrent: 2,
  installedPackIds: () => new Set(),
  installer: async (id, options) => {
    installCalls.push({ id, turnId: options.turnId });
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    if (id === "missing") return { ok: false, id, error: "NO_RUNTIME_PACK_ARTIFACT" };
    if (id === "bad") return { ok: false, id, error: "DOWNLOAD_FAILED" };
    return { ok: true, id, version: "1.0.0" };
  },
  health: async (id) => ({ ok: id !== "unhealthy", id }),
});

const [first, joined] = await Promise.all([
  coordinator.prepare({ turnId: "t1", requiredPackIds: ["web-automation", "ffmpeg", "pandoc"] }),
  coordinator.prepare({ turnId: "t2", requiredPackIds: ["web-automation"] }),
]);
assert.equal(peak <= 2, true, `peak concurrency exceeded: ${peak}`);
assert.equal(installCalls.filter((call) => call.id === "web-automation").length, 1);
assert.deepEqual(first.readyPackIds.sort(), ["ffmpeg", "pandoc", "web-automation"]);
assert.deepEqual(joined.readyPackIds, ["web-automation"]);
assert.equal(first.refreshRequired, true);

const failed = await coordinator.prepare({
  turnId: "t3",
  requiredPackIds: ["missing", "bad", "unhealthy"],
});
assert.equal(failed.ok, false);
assert.deepEqual(failed.unavailablePackIds, ["missing"]);
assert.deepEqual(failed.failedPackIds.sort(), ["bad", "unhealthy"]);
assert.equal(failed.failures.find((item) => item.id === "unhealthy")?.error, "RUNTIME_PACK_HEALTH_FAILED");

const alreadyInstalled = createRuntimePackCoordinator({
  installedPackIds: () => new Set(["libreoffice"]),
  installer: async () => {
    throw new Error("installed packs must not reinstall");
  },
  health: async () => ({ ok: true }),
});
const skipped = await alreadyInstalled.prepare({ turnId: "t4", requiredPackIds: ["libreoffice"] });
assert.deepEqual(skipped.readyPackIds, ["libreoffice"]);
assert.equal(skipped.refreshRequired, false);

console.log("runtime-pack-coordinator: ok");
