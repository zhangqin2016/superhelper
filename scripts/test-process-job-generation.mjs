#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { assert, finish } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const sourcePath = require.resolve("../src/main/mcp/process-jobs-core.js");
const coreRequire = createRequire(sourcePath);

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-job-generation-"));
  const children = [], requests = [], alive = new Set();
  let nextPid = 10001;
  const module = { exports: {} };
  const load = (id) => {
    if (id === "node:child_process") return { spawn() {
      const child = new EventEmitter();
      child.pid = nextPid++;
      child.unref = () => {};
      alive.add(child.pid);
      children.push(child);
      return child;
    } };
    if (id === "node:http") return { request(url, options, callback) {
      const req = new EventEmitter();
      req.end = req.destroy = () => {};
      requests.push((statusCode = 200) => callback({ statusCode, resume() {} }));
      return req;
    } };
    if (id === "../process-tree-kill") return { stopPid: () => null };
    return coreRequire(id);
  };
  // Real production code and registry IO; only OS child/health boundaries are controlled.
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(sourcePath, "utf8")}\n})`, {
    Buffer, URL, setTimeout, clearTimeout,
    process: { ...process, kill(pid) { if (!alive.has(pid)) throw new Error("ESRCH"); } },
  }, { filename: sourcePath })(load, module, module.exports);
  const api = module.exports;
  const options = { registryDir: tmp };
  return {
    api, options, children, requests, alive,
    start: (jobId, input = {}) => api.startJob({ jobId, command: "fixture-process", args: [], cwd: tmp, healthcheck: { type: "none" }, ...input }, options),
    record: (jobId) => api.readRegistry(options).jobs[jobId],
    close: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

const cases = [
  ["late exit", async (f) => {
    await f.start("reused");
    const oldChild = f.children[0];
    const replacement = await f.start("reused");
    await f.start("unrelated");
    oldChild.emit("exit", 1, null);
    const current = f.record("reused");
    assert(current.pid === replacement.pid && current.status === "running" && current.exitCode === null,
      "old exit must not fail the replacement process");
    assert(f.record("unrelated")?.status === "running", "old exit preserves unrelated job");
    f.children[1].emit("exit", 0, null);
    assert(f.record("reused").status === "exited", "current generation exit is still recorded");
  }],
  ["late error", async (f) => {
    await f.start("reused");
    const replacement = await f.start("reused");
    f.children[0].emit("error", new Error("old spawn failed"));
    assert(f.record("reused").pid === replacement.pid && f.record("reused").status === "running",
      "old error must not fail the replacement process");
    f.children[1].emit("error", new Error("current spawn failed"));
    assert(f.record("reused").error === "current spawn failed", "current generation error is still recorded");
  }],
  ["late start health", async (f) => {
    const pending = f.start("reused", { healthcheck: { type: "http", url: "http://fixture.invalid" } });
    const oldPid = f.children[0].pid;
    const replacement = await f.start("reused");
    await f.start("unrelated");
    f.requests.shift()(503);
    const receipt = await pending;
    const current = f.record("reused");
    assert(current.pid === replacement.pid && current.health.type === "none", "old start health cannot overwrite replacement health");
    assert(receipt.pid === oldPid, "start receipt remains associated with the process it started");
    assert(f.record("unrelated")?.status === "running", "late start health preserves unrelated job");
  }],
  ["late status health", async (f) => {
    await f.start("reused");
    const pending = f.api.statusJob({ jobId: "reused", healthcheck: { type: "http", url: "http://fixture.invalid" } }, f.options);
    const replacement = await f.start("reused");
    await f.start("unrelated");
    f.requests.shift()(503);
    const receipt = await pending;
    const current = f.record("reused");
    assert(current.pid === replacement.pid && current.health.type === "none", "old status snapshot cannot replace a new generation");
    assert(f.record("unrelated")?.status === "running", "old status snapshot cannot delete jobs added during health await");
    assert(receipt.ok === false && receipt.error === "JOB_REPLACED", "stale status reports replacement explicitly");
  }],
  ["status versus terminal event", async (f) => {
    await f.start("job");
    const pending = f.api.statusJob({ jobId: "job", healthcheck: { type: "http", url: "http://fixture.invalid" } }, f.options);
    await f.start("unrelated");
    f.children[0].emit("exit", 1, null);
    f.requests.shift()();
    const receipt = await pending;
    assert(f.record("job").status === "failed" && receipt.status === "failed", "late status health must preserve same-generation terminal event");
    assert(f.record("unrelated")?.status === "running", "status refresh merges the latest registry");
  }],
  ["late stop", async (f) => {
    const original = await f.start("reused");
    const pending = f.api.stopJob({ jobId: "reused", timeoutMs: 1000, force: false }, f.options);
    const replacement = await f.start("reused");
    await f.start("unrelated");
    f.alive.delete(original.pid);
    const receipt = await pending;
    assert(f.record("reused").pid === replacement.pid && f.record("reused").status === "running", "old stop cannot replace new process with stopped record");
    assert(f.record("unrelated")?.status === "running", "old stop preserves jobs created while waiting");
    assert(receipt.ok === false && receipt.error === "JOB_REPLACED", "stale stop reports replacement explicitly");
  }],
];

const failures = [];
for (const [name, run] of cases) {
  const f = fixture();
  try { await run(f); } catch (error) { failures.push(`${name}: ${error.message}`); }
  finally { f.close(); }
}
assert(failures.length === 0, failures.join("\n"));
finish("test-process-job-generation", cases.length);
