#!/usr/bin/env node
// The launch gate blocks on the message database's page scan only when there is
// reason to doubt the file. The scan is not dropped — it runs in the background
// right after admission, so coverage per launch is unchanged; what changes is
// whether the user waits for it. Measured on a real 918 MB database, cold:
// 3973 ms for the full gate against 33 ms for the same admission decision
// without the scan, with identical results. [gate: startup-admission]
// Run: node scripts/test-startup-admission.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  decideStartupVerification,
  markCleanExit,
  markLaunchInProgress,
  markerPath,
  readMarker,
  recordVerification,
} = require("../src/main/startup-integrity.js");
const { MessageStore } = require("../src/main/store/message-store.js");
const { DatabaseRecoveryFlow } = require("../src/main/database-recovery-flow.js");
const { inspectDatabase } = require("../src/main/store/database-recovery.js");

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "startup-admission-"));

/** One clean launch: decide, mark dirty, verify, exit cleanly. */
function cleanLaunch(dir, { verifyOk = true } = {}) {
  const decision = decideStartupVerification(dir);
  markLaunchInProgress(dir);
  recordVerification(dir, { ok: verifyOk, reason: verifyOk ? "healthy" : "corrupt" });
  markCleanExit(dir);
  return decision;
}

try {
  await check("a first launch blocks, and only a clean exit whose verification passed earns a fast one", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "a-"));
    assert.deepEqual(cleanLaunch(dir), { verify: true, reason: "no_marker" }, "nothing known yet");
    assert.deepEqual(decideStartupVerification(dir), { verify: false, reason: "clean_and_verified" });
    assert.equal(readMarker(dir).cleanExit, true);
  });

  await check("a crash leaves the marker dirty without anyone catching the crash", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "b-"));
    cleanLaunch(dir);
    // A launch that never reaches before-quit: decide, mark, then vanish.
    decideStartupVerification(dir);
    markLaunchInProgress(dir);
    assert.deepEqual(decideStartupVerification(dir), { verify: true, reason: "unclean_exit" },
      "the next launch verifies, because the marker was made dirty at launch rather than at the crash");
  });

  await check("a failed background verification makes the next launch block until it is clean again", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "c-"));
    cleanLaunch(dir, { verifyOk: false });
    assert.deepEqual(decideStartupVerification(dir), { verify: true, reason: "last_verify_not_ok" });
    cleanLaunch(dir, { verifyOk: true });
    assert.deepEqual(decideStartupVerification(dir), { verify: false, reason: "clean_and_verified" });
  });

  await check("every uncertainty answers verify — corrupt, truncated, wrong-version and unwritable markers all block", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "d-"));
    cleanLaunch(dir);
    assert.equal(decideStartupVerification(dir).verify, false);
    for (const content of ["", "{", "null", "[]", JSON.stringify({ version: 99, cleanExit: true, lastVerify: { ok: true } })]) {
      fs.writeFileSync(markerPath(dir), content);
      assert.equal(decideStartupVerification(dir).verify, true, `marker ${JSON.stringify(content).slice(0, 24)} must block`);
    }
    fs.rmSync(markerPath(dir));
    assert.equal(decideStartupVerification(dir).verify, true, "a deleted marker blocks");
    assert.equal(markLaunchInProgress(path.join(dir, "does-not-exist")), null, "an unwritable marker fails quietly");
    assert.equal(decideStartupVerification(path.join(dir, "does-not-exist")).verify, true, "and that launch blocks");
  });

  await check("the kill switch restores the old always-blocking gate", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "e-"));
    cleanLaunch(dir);
    assert.equal(decideStartupVerification(dir).verify, false);
    assert.deepEqual(decideStartupVerification(dir, { LILY_STARTUP_FAST_ADMIT: "0" }), { verify: true, reason: "disabled" });
  });

  await check("probe and the full inspect reach the SAME admission decision on a healthy database", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "f-"));
    const dbPath = path.join(dir, "messages.db");
    const store = new MessageStore(dbPath, path.join(dir, "blobs"));
    for (let i = 0; i < 40; i += 1) store.append(`s${i % 3}`, { id: `m${i}`, role: "user", content: "x", record: { kind: "turn" } });
    store.close();
    const full = inspectDatabase(dbPath);
    const fast = inspectDatabase(dbPath, { verify: false });
    assert.equal(full.ok, true);
    assert.deepEqual(
      { ok: fast.ok, reason: fast.reason, messageCount: fast.messageCount, sessionCount: fast.sessionCount },
      { ok: full.ok, reason: full.reason, messageCount: full.messageCount, sessionCount: full.sessionCount },
      "skipping the page scan must not change what the gate concludes",
    );
    assert.equal(full.messageCount, 40);
    assert.equal(full.sessionCount, 3);
  });

  await check("the fast path still refuses a file that is not a database at all", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "g-"));
    const dbPath = path.join(dir, "messages.db");
    fs.writeFileSync(dbPath, Buffer.alloc(8192, 0x41)); // not an SQLite header
    const fast = inspectDatabase(dbPath, { verify: false });
    assert.equal(fast.ok, false, "the header check is not part of what was deferred");
    assert.equal(fast.reason, "corrupt");
    assert.equal(inspectDatabase(dbPath).reason, "corrupt", "and the full gate agrees");
  });

  await check("page-level corruption is what the deferred scan is for — the fast path admits it, the scan does not", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "h-"));
    const dbPath = path.join(dir, "messages.db");
    const store = new MessageStore(dbPath, path.join(dir, "blobs"));
    for (let i = 0; i < 400; i += 1) store.append("s", { id: `m${i}`, role: "user", content: "x".repeat(400), record: { kind: "turn" } });
    store.close();
    // Corrupt a page well past the header, the way a torn write would.
    const fd = fs.openSync(dbPath, "r+");
    try { fs.writeSync(fd, Buffer.alloc(2048, 0x5a), 0, 2048, 24576); } finally { fs.closeSync(fd); }
    const full = inspectDatabase(dbPath);
    assert.equal(full.ok, false, "the page scan catches it");
    // The fast admission may or may not notice depending on which page was hit —
    // what must hold is that a scan failure is recorded so the NEXT launch blocks.
    const dirMarker = fs.mkdtempSync(path.join(tmp, "h2-"));
    cleanLaunch(dirMarker);
    assert.equal(decideStartupVerification(dirMarker).verify, false);
    recordVerification(dirMarker, { ok: false, reason: full.reason });
    assert.deepEqual(decideStartupVerification(dirMarker), { verify: true, reason: "last_verify_not_ok" },
      "a background scan failure is what turns the next gate back into a blocking one");
  });

  await check("the flow admits on whichever action it was given, and rejects anything else", async () => {
    const calls = [];
    const service = { run: async (action) => { calls.push(action); return { ok: true, reason: "healthy", messageCount: 1, sessionCount: 1 }; } };
    let admitted = null;
    const flow = new DatabaseRecoveryFlow({ service, admitAction: "probe", onHealthy: (state) => { admitted = state; } });
    await flow.act("probe");
    assert.deepEqual(calls, ["probe"], "the cheap action is what runs");
    assert.ok(admitted, "and it admits");
    const other = new DatabaseRecoveryFlow({ service, onHealthy: () => {} });
    assert.deepEqual(await other.act("nonsense"), { ok: false, reason: "invalid_action" });
    assert.equal((await new DatabaseRecoveryFlow({ service, onHealthy: () => {} }).act("inspect")) && calls[1], "inspect",
      "and the default is still the full check");
  });

  await check("main.js actually uses the decision, marks the launch, and re-verifies behind the window", () => {
    const src = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    assert.match(src, /decideStartupVerification\(userDataDir\)/);
    assert.match(src, /markLaunchInProgress\(userDataDir\)/);
    assert.match(src, /admitAction: admission\.verify \? "inspect" : "probe"/);
    assert.match(src, /if \(!admission\.verify\) \{[\s\S]*run\("inspect"\)[\s\S]*recordVerification/, "a fast admission must schedule the real scan");
    assert.match(src, /before-quit[\s\S]{0,400}markCleanExit/, "and only a real quit may mark the exit clean");
    // Bookkeeping must never be able to stop the app from starting.
    assert.match(src, /verify: true, reason: "integrity_marker_unavailable"/, "the default before anything is read is to verify");
    assert.match(src, /startupIntegrity = require\("\.\/main\/startup-integrity"\);[\s\S]{0,400}\} catch/, "and reading it is guarded");
  });

  console.log(`\n${checks} checks passed (startup admission)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
