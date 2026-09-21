#!/usr/bin/env node
// A pid written down earlier is a name the OS reuses. Every signal to such a
// pid goes through one guard that refuses this app's own processes and, when
// the record carries a process identity, a process that no longer matches it.
//
// Field report 2026-09-20: after hours of use the customer's main window showed
// "this window could not load · killed · 15". Electron reports the signal as
// the exit code on POSIX, so a renderer had received SIGTERM. Three stop paths
// (session delete, long-task stop, lily_process_jobs stop) signalled recorded
// pids after only a kill(pid, 0) liveness check — true for whatever owns the
// number now, including a renderer helper after a reboot. [gate: process-signal-identity]
// Run: node scripts/test-process-signal-guard.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { stopRecordedProcess, ownProcessIds } = require("../src/main/process-tree-kill.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const sent = [];
const deps = { kill: (target, signal) => { sent.push([target, signal]); }, ownPids: () => [process.pid, process.ppid, 4242, 4243] };
const identityFor = (pid) => ({ pid, fingerprint: "abc" });

check("this app's own processes are never signalled, whatever a registry says", () => {
  assert.deepEqual(stopRecordedProcess({ pid: process.pid }, deps), { ok: false, error: "SELF_PROCESS" });
  assert.deepEqual(stopRecordedProcess({ pid: process.ppid }, deps), { ok: false, error: "SELF_PROCESS" });
  assert.deepEqual(stopRecordedProcess({ pid: 4242, identity: identityFor(4242) }, { ...deps, matchesIdentity: () => true }), { ok: false, error: "OWN_HELPER" }, "a renderer helper is refused even when an identity claims to match");
  assert.deepEqual(stopRecordedProcess({ pid: 0 }, deps), { ok: false, error: "INVALID_PID" });
  assert.deepEqual(stopRecordedProcess({ pid: "x" }, deps), { ok: false, error: "INVALID_PID" });
  assert.equal(sent.length, 0, "nothing was signalled");
  const own = ownProcessIds();
  assert.ok(own.has(process.pid) && own.has(process.ppid), "outside Electron the own set is still self + parent");
});

check("a recorded identity must still describe the live process, or the pid is left alone", () => {
  const mismatch = stopRecordedProcess({ pid: 777, identity: identityFor(777) }, { ...deps, matchesIdentity: () => false });
  assert.deepEqual(mismatch, { ok: false, error: "IDENTITY_MISMATCH" });
  const throwing = stopRecordedProcess({ pid: 777, identity: identityFor(777) }, { ...deps, matchesIdentity: () => { throw new Error("ps failed"); } });
  assert.deepEqual(throwing, { ok: false, error: "IDENTITY_MISMATCH" }, "an inspection failure is a mismatch, not a licence to kill");
  const wrongPid = stopRecordedProcess({ pid: 777, identity: identityFor(778) }, { ...deps, matchesIdentity: () => true });
  assert.deepEqual(wrongPid, { ok: false, error: "IDENTITY_MISMATCH" }, "the identity must be for this pid");
  assert.equal(sent.length, 0);
  // An older record whose identity carries no fingerprint proves nothing either
  // way; it is stopped as before, still behind the own-process guard.
  assert.deepEqual(stopRecordedProcess({ pid: 4242, identity: { pid: 4242 } }, deps), { ok: false, error: "OWN_HELPER" });
  assert.deepEqual(stopRecordedProcess({ pid: 780, identity: {} }, { ...deps, platform: "darwin", matchesIdentity: () => { throw new Error("must not be consulted"); } }), { ok: true });
  assert.deepEqual(sent.at(-1), [-780, "SIGTERM"]);
});

check("a matching identity (or a legacy record without one) is signalled as a tree, SIGTERM by default", () => {
  assert.deepEqual(stopRecordedProcess({ pid: 777, identity: identityFor(777) }, { ...deps, matchesIdentity: () => true, platform: "darwin" }), { ok: true });
  assert.deepEqual(sent.at(-1), [-777, "SIGTERM"], "POSIX jobs are their own process group");
  assert.deepEqual(stopRecordedProcess({ pid: 778, signal: "SIGKILL" }, { ...deps, platform: "darwin" }), { ok: true });
  assert.deepEqual(sent.at(-1), [-778, "SIGKILL"]);
  assert.deepEqual(stopRecordedProcess({ pid: 779, tree: false }, deps), { ok: true }, "a single-process stop is available for records that were never a group");
});

check("every stop path that signals a recorded pid goes through the guard — nothing else may", () => {
  const allowed = new Set(["src/main/process-tree-kill.js", "src/main/runtime/opencode-orphan-reaper.js"]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!file.endsWith(".js")) continue;
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (allowed.has(rel)) continue;
      const src = fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      // A raw signal to a number is the defect; kill(pid, 0) is a liveness probe.
      for (const m of src.matchAll(/\b(stopPid|stopPidTree|killPidTreeBestEffort)\(/g)) offenders.push(`${rel}: ${m[1]}(`);
      // Two shapes are not a recorded pid and stay allowed: this process's own
      // group (a spawned wrapper reaping itself), and a ChildProcess still held
      // in scope — proven by the file spawning it, not by what it is named.
      const spawned = new Set([...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?spawn[A-Za-z]*\(/g)].map((m) => m[1]));
      for (const m of src.matchAll(/process\.kill\(\s*(-?)([^,)]+?)\s*,\s*("SIG[A-Z]+"|signal)\s*\)/g)) {
        const target = m[2].trim();
        if (target === "process.pid") continue;
        if (spawned.has(target.replace(/\.pid$/, ""))) continue;
        offenders.push(`${rel}: process.kill(${m[1]}${target}, ${m[3]})`);
      }
    }
  };
  walk(path.join(ROOT, "src/main"));
  assert.deepEqual(offenders, [], `recorded pids are signalled only via stopRecordedProcess:\n${offenders.join("\n")}`);
  for (const file of ["src/main/long-task/session-cleanup.js", "src/main/long-task/process-job-runtime.js", "src/main/mcp/process-jobs-core.js"]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(src, /stopRecordedProcess\(\{ pid(?:: [^,]+)?, identity: /, `${file} passes the record's identity`);
  }
  const core = fs.readFileSync(path.join(ROOT, "src/main/mcp/process-jobs-core.js"), "utf8");
  assert.match(core, /captureProcessIdentity\(child\.pid, *\{ *processGroupId/, "a new job records who its pid is at spawn time");
});

check("a stopped job whose pid now belongs to someone else is marked exited, and the stranger is untouched", async () => {
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-guard-"));
  try {
    const core = require("../src/main/mcp/process-jobs-core.js");
    const options = { registryDir: dir };
    options.registryPath = core.registryPath(options);
    const registry = { schemaVersion: 1, jobs: { j1: { jobId: "j1", generationId: "g", pid: process.pid, status: "running", command: "sleep", args: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), processIdentity: { pid: process.pid, fingerprint: "stale" } } } };
    fs.writeFileSync(options.registryPath, JSON.stringify(registry));
    const result = await core.stopJob({ jobId: "j1" }, options);
    assert.equal(result.ok, true);
    assert.equal(result.alreadyExited, true, "our own pid on record → the job is over, not a signal to ourselves");
    assert.equal(JSON.parse(fs.readFileSync(options.registryPath, "utf8")).jobs.j1.status, "exited");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${checks} checks passed (process signal guard)`);
