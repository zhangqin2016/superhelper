#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { captureProcessIdentity, matchesProcessIdentity } = require("../src/main/long-task/process-identity.js");
const { enforceLogQuota } = require("../src/main/long-task/log-policy.js");
const { stopPidTree } = require("../src/main/process-tree-kill.js");

const ps = ({ pid, started = "START-A", command = "node worker.js" }) =>
  `${pid}|${started}|${command}`;
const identity = captureProcessIdentity(321, {
  platform: "darwin",
  command: "node",
  launchNonce: "nonce-a",
  inspect: () => ps({ pid: 321 }),
  now: () => 1000,
});
assert.equal(identity.pid, 321);
assert.equal(identity.launchNonce, "nonce-a");
assert.equal(matchesProcessIdentity(identity, { inspect: () => ps({ pid: 321 }) }), true);
assert.equal(matchesProcessIdentity(identity, { inspect: () => ps({ pid: 321, started: "START-B" }) }), false, "PID reuse is rejected");
assert.equal(matchesProcessIdentity(identity, { inspect: () => "" }), false, "missing process is rejected");

const kills = [];
stopPidTree(444, "SIGTERM", {
  platform: "darwin",
  kill: (pid, signal) => kills.push([pid, signal]),
});
assert.deepEqual(kills, [[-444, "SIGTERM"]], "POSIX stop targets detached process group");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-log-quota-"));
try {
  const file = path.join(dir, "job.stdout.log");
  fs.writeFileSync(file, `${"old\n".repeat(200)}KEEP-TAIL\n`, "utf8");
  const result = enforceLogQuota(file, { maxBytes: 256, retainBytes: 96 });
  assert.equal(result.rotated, true);
  assert(fs.statSync(file).size <= 96);
  assert(fs.readFileSync(file, "utf8").includes("KEEP-TAIL"));
  assert.equal(enforceLogQuota(file, { maxBytes: 256, retainBytes: 96 }).rotated, false);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("process-job-hardening: ok");
