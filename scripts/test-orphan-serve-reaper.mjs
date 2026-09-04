#!/usr/bin/env node
/**
 * Reap engine serves a previous ungraceful exit left behind — and never touch
 * a live one.
 *
 * before-quit already reaps the shared serve, but it only runs on a graceful
 * quit. Ctrl-C on the dev launcher, a crash, or a force quit skips it and the
 * serve survives, reparented to init, holding userData files and a port.
 * Nothing ever looked for what the previous run left. Measured on a real dev
 * machine 2026-09-04: 7 orphaned serves, oldest 40 days, dragging 24 stale
 * Electron children, 587 MB resident, 19 processes holding userData at once.
 *
 * This kills processes, so the whole value is in what it REFUSES to match. All
 * three conditions must hold: the command starts with exactly this install's
 * bundled binary, the parent is gone (ppid 1), and it is not us. A live
 * instance's serve is parented to that instance, so it can never match — that
 * is what makes this safe rather than a heuristic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reaper = require("../src/main/runtime/opencode-orphan-reaper.js");

const BIN = "/Users/x/app/bundles/darwin-arm64/opencode/bin/opencode";
const OTHER = "/Users/x/other-checkout/bundles/darwin-arm64/opencode/bin/opencode";

const rows = [
  { pid: 111, ppid: 1, command: `${BIN} serve --hostname 127.0.0.1 --port 0` },
  { pid: 112, ppid: 1, command: `${BIN} serve` },
  // live: parented to a running app
  { pid: 200, ppid: 199, command: `${BIN} serve --hostname 127.0.0.1` },
  // another checkout, orphaned but not ours
  { pid: 300, ppid: 1, command: `${OTHER} serve` },
  // system-wide install
  { pid: 301, ppid: 1, command: "/opt/homebrew/bin/opencode serve" },
  // our binary, orphaned, but not a serve
  { pid: 302, ppid: 1, command: `${BIN} run "hello"` },
  // a path that merely starts with the same prefix
  { pid: 303, ppid: 1, command: `${BIN}-old serve` },
  { pid: 400, ppid: 1, command: "node /Users/x/app/scripts/thing.mjs serve" },
  // A PATH-launched opencode belonging to nobody in particular. This exists so
  // the relative-path assertion below is not vacuous: with binaryPath
  // "opencode" this row matches, which is exactly the hazard.
  { pid: 401, ppid: 1, command: "opencode serve --hostname 127.0.0.1" },
];

// --- what it selects -----------------------------------------------------

const picked = reaper.selectOrphanServes(rows, { binaryPath: BIN, selfPid: 999, parentPid: 998 });
assert.deepEqual(picked.map((r) => r.pid).sort(), [111, 112], "only orphaned serves of THIS install may be selected");

// --- what it refuses ------------------------------------------------------

for (const [pid, why] of [
  [200, "a live instance's serve is parented to that instance and must never be reaped"],
  [300, "another checkout's serve belongs to another install"],
  [301, "a system-wide opencode is not ours to kill"],
  [302, "the engine binary also runs as a client; only serves are reaped"],
  [303, "a path that merely shares a prefix is a different binary"],
  [400, "an unrelated process whose arguments contain the word serve"],
]) {
  assert.ok(!picked.some((r) => r.pid === pid), `${pid}: ${why}`);
}

// Never ourselves or our parent, even if they somehow matched.
const selfRows = [
  { pid: 500, ppid: 1, command: `${BIN} serve` },
  { pid: 501, ppid: 1, command: `${BIN} serve` },
];
assert.deepEqual(
  reaper.selectOrphanServes(selfRows, { binaryPath: BIN, selfPid: 500, parentPid: 501 }).map((r) => r.pid),
  [],
  "our own pid and our parent's must be excluded",
);

// A missing or relative binary path must match NOTHING rather than guess.
// pid 401 ("opencode serve") is in the fixture precisely so this bites: a
// relative path would match a PATH-launched engine that is not ours to kill.
assert.ok(
  reaper.selectOrphanServes(rows, { binaryPath: "opencode", selfPid: 999, parentPid: 998 }).length === 0,
  'a relative binaryPath must select nothing, even though "opencode serve" is present and would match it',
);
for (const binaryPath of ["", null, undefined, "bundles/x/opencode", "./opencode"]) {
  assert.deepEqual(
    reaper.selectOrphanServes(rows, { binaryPath }).map((r) => r.pid),
    [],
    `binaryPath ${JSON.stringify(binaryPath)} must select nothing — an unanchored path would match far too much`,
  );
}
// And it must not be selected by the real absolute path either.
assert.ok(!picked.some((r) => r.pid === 401), "401: a PATH-launched engine is not this install's");

// --- the reap itself ------------------------------------------------------

function run(extra = {}) {
  const killed = [];
  const count = reaper.reapOrphanEngineServes({
    platform: "darwin",
    binaryPath: BIN,
    selfPid: 999,
    parentPid: 998,
    readProcessTable: () => rows,
    killPidTreeBestEffort: (pid) => killed.push(pid),
    ...extra,
  });
  return { count, killed };
}

const reaped = run();
assert.equal(reaped.count, 2, "both orphans must be reaped");
assert.deepEqual(reaped.killed.sort(), [111, 112], "and exactly those two pids signalled");

// Kill switch.
process.env.LILY_REAP_ORPHAN_SERVES = "0";
assert.deepEqual(run(), { count: 0, killed: [] }, "the kill switch must reap nothing");
delete process.env.LILY_REAP_ORPHAN_SERVES;

// Windows: ppid is not rewritten to 1, so the safety condition cannot be
// evaluated and the reaper must decline rather than guess.
assert.deepEqual(run({ platform: "win32" }), { count: 0, killed: [] }, "win32 must be a no-op, not a guess");

// Fail open: a broken process table must not throw into startup.
assert.equal(
  run({ readProcessTable: () => { throw new Error("ps exploded"); } }).count,
  0,
  "a failure must return 0, never throw — this runs on the startup path",
);
// One stubborn pid must not stop the others.
{
  const killed = [];
  const count = reaper.reapOrphanEngineServes({
    platform: "darwin", binaryPath: BIN, selfPid: 999, parentPid: 998,
    readProcessTable: () => rows,
    killPidTreeBestEffort: (pid) => { if (pid === 111) throw new Error("EPERM"); killed.push(pid); },
  });
  assert.equal(count, 2, "the count reports what was attempted");
  assert.deepEqual(killed, [112], "a pid that refuses to die must not abort the rest");
}

// --- wired into startup, fail-open ---------------------------------------

const main = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
assert.match(main, /reapOrphanEngineServes\(\)/, "the reaper must actually run at startup");
const wiring = main.slice(main.indexOf("opencode-orphan-reaper"));
assert.match(wiring.slice(0, 300), /catch\s*\{/, "the startup call must be fail-open");
// It must sit AFTER the single-instance guard: that guard is what proves a
// parentless serve is an orphan rather than a concurrently starting instance.
const lockIndex = main.indexOf("hasSingleInstanceLock");
const reapIndex = main.indexOf("reapOrphanEngineServes");
assert.ok(lockIndex > 0 && reapIndex > lockIndex, "the reaper must run after the single-instance lock is held");

console.log("orphan serve reaper: ok");
console.log(`  selects orphaned serves of this install only (${picked.length}), refuses 6 look-alike shapes`);
console.log("  kill switch, win32 no-op, and fail-open all hold");
