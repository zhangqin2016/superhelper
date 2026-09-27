#!/usr/bin/env node
/**
 * A continuation round that changed files earns one more look at its job's
 * outcome; one that only relaunched does not; and when the chain does pause,
 * the notice says what the job actually ended with.
 *
 * Field case 2026-09-27 (release 0.1.189): round 1 fixed the build script and
 * relaunched the release; the relaunch failed in 16 s ("Unknown argument:
 * …/.bin/electron-builder"). The wake was refused as "no new progress" — a
 * failed job is not progress, and the round's own fix was not counted — and
 * the pause notice said only that, so the failure was read by no one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lily-round-progress-"));

try {
  const { workspaceProgressKeys } = require("../src/main/long-task/round-progress.js");
  const started = (id, name, input) => ({ type: "tool.started", payload: { id, name, input } });
  const done = (id, extra = {}) => ({ type: "tool.done", payload: { id, status: "done", isError: false, ...extra } });
  const fix = { filePath: "/repo/scripts/build-runtime-bundle.mjs", oldString: "rmrf(python)", newString: "reuseLocalPython()" };

  // ------------------------------------------------ what counts as progress
  {
    const keys = workspaceProgressKeys([
      started("e1", "edit", { ...fix, description: "reuse python" }), done("e1"),
      started("b1", "bash", { command: "npm run release:one" }), done("b1"),
      started("j1", "lily_process_jobs_job_start", { jobId: "release-b3" }), done("j1"),
      started("r1", "read", { filePath: "/repo/a.js" }), done("r1"),
      started("e2", "write", { filePath: "/repo/b.js", content: "x" }), done("e2", { isError: true }),
    ]);
    assert.equal(keys.length, 1, "only the completed file write counts — not the command, the job launch, the read, or a failed write");
    assert.match(keys[0], /^[a-f0-9]{64}$/);
    const again = workspaceProgressKeys([started("e9", "edit", { ...fix, description: "same edit, new label" }), done("e9")]);
    assert.deepEqual(again, keys, "the same edit is the same progress, whatever it is called");
    assert.deepEqual(workspaceProgressKeys([started("j2", "lily_process_jobs_job_start", { jobId: "release-b4" }), done("j2")]), [],
      "relaunching under a new job id is not progress");
    check("a round's progress is its completed file writes, fingerprinted by content");
  }

  // ------------------------------------ the field chain through the real budget
  {
    const { openDatabase } = require("../src/main/store/sqlite-db");
    const { reserveTaskContinuation } = require("../src/main/store/task-continuation-budget");
    const { createLongTaskWakeHandler, wakeTurnId } = require("../src/main/long-task/session-wakeup.js");
    const db = openDatabase(path.join(scratch, "budget.db"));
    db.exec(`CREATE TABLE turn_inputs (
      turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_scope TEXT NOT NULL,
      status TEXT NOT NULL, terminal_type TEXT, migration_status TEXT DEFAULT 'owned',
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1
    )`);
    const owner = "owner-a", sessionId = "session-a", projectId = "project-a";
    const seed = (turnId) => db.run("INSERT INTO turn_inputs (turn_id, session_id, owner_scope, status) VALUES (?, ?, ?, ?)", turnId, sessionId, owner, "completed");
    const toolsByTurn = new Map();
    let clock = 10_000;
    const manager = {
      findById: (id) => (id === sessionId ? { id, projectId } : null),
      resolveTurnOwnerScope: () => ({ ok: true, ownerScope: owner }),
      getTurnInputByTurnId: (sid, turnId) => ({ sessionId: sid, turnId, ownerScope: owner, status: "completed", terminalType: "turn.completed", userText: "发布 0.1.189" }),
      reserveTaskContinuation: (sid, input) => reserveTaskContinuation(db, { sessionId: sid, ownerScope: owner, now: (clock += 1000), ...input }),
      getTurnToolEvents: (sid, turnId) => toolsByTurn.get(turnId) || [],
    };
    const sent = [];
    const handler = createLongTaskWakeHandler({ sessionManager: manager, turnOrchestrator: { sendUserMessage: async (...args) => { sent.push(args); return { ok: true }; } } });
    const failedJob = (id, turnId) => ({ id, turnId, sessionId, projectId, ownerScope: owner, status: "failed", exitCode: 1, replayPolicy: "inspect", command: "npm", args: ["run", "release:one"] });
    const wakeFor = (job) => ({ id: `wake:${job.id}`, jobId: job.id, turnId: job.turnId, sessionId, projectId, ownerScope: owner });
    const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

    // The user's turn launched attempt 2, which failed: the first wake is always admitted.
    seed("turn-user");
    toolsByTurn.set("turn-user", [started("p1", "edit", { filePath: "/repo/scripts/release-preflight.mjs", oldString: "a", newString: "b" }), done("p1")]);
    const b2 = failedJob("release-b2", "turn-user");
    assert.equal((await quiet(() => handler(wakeFor(b2), b2))).ok, true, "the first wake reports the failure");
    const round1 = wakeTurnId(wakeFor(b2).id);
    seed(round1);

    // Round 1 fixed the build script, then relaunched: attempt 3 failed.
    toolsByTurn.set(round1, [started("e1", "edit", fix), done("e1"), started("j1", "lily_process_jobs_job_start", { jobId: "release-b3" }), done("j1")]);
    const b3 = failedJob("release-b3", round1);
    assert.equal((await quiet(() => handler(wakeFor(b3), b3))).ok, true, "a round that changed files earns a look at its job's failure");
    const round2 = wakeTurnId(wakeFor(b3).id);
    seed(round2);

    // Round 2 only relaunched: attempt 4 failed again.
    toolsByTurn.set(round2, [started("j2", "lily_process_jobs_job_start", { jobId: "release-b4" }), done("j2")]);
    const b4 = failedJob("release-b4", round2);
    assert.deepEqual(await quiet(() => handler(wakeFor(b4), b4)), { ok: false, permanent: true, error: "TASK_CONTINUATION_NO_PROGRESS" },
      "a round that changed nothing does not — the loop guard holds");

    // Nor does a round that repeats an edit the chain has already seen.
    const round2b = "turn-repeat";
    seed(round2b);
    db.run("INSERT INTO task_continuation_claims (continuation_turn_id, session_id, owner_scope, source_turn_id, root_turn_id, round, root_started_at, reserved_at, progress_keys_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      round2b, sessionId, owner, round1, "turn-user", 3, 11_000, 20_000, "[]");
    toolsByTurn.set(round2b, [started("e2", "edit", fix), done("e2")]);
    const b5 = failedJob("release-b5", round2b);
    assert.equal((await quiet(() => handler(wakeFor(b5), b5))).error, "TASK_CONTINUATION_NO_PROGRESS", "the same fix made again is not new progress");
    assert.equal(sent.length, 2, "exactly the two earned wakes were dispatched");
    db.close?.();
    check("the field chain: a fixing round earns a wake, a relaunching or repeating round does not");
  }

  // ---------------------------------------------- the pause says what happened
  {
    const { createLongTaskPauseHandler } = require("../src/main/long-task/session-wake-notice.js");
    const dir = path.join(scratch, "process-jobs");
    fs.mkdirSync(dir);
    const secret = "Rel3asePa55word!";
    fs.writeFileSync(path.join(dir, "release-b3.launch.json"), JSON.stringify({ command: "npm run release:one", env: { RELEASE_ADMIN_PASSWORD: secret } }));
    fs.writeFileSync(path.join(dir, "release-b3.stdout.log"), "[runtime-build] done\n[dist-mac] 打包 darwin-arm64\n");
    fs.writeFileSync(path.join(dir, "release-b3.stderr.log"), `Error: admin login failed for release@lily with ${secret}\nUsage: electron-builder\nUnknown argument: /repo/node_modules/.bin/electron-builder\n[release-one] npm run dist:all failed; restored package version files to 0.1.188\n`);
    const job = { id: "release-b3", sessionId: "s", projectId: "p", ownerScope: "o", turnId: "t", status: "failed", exitCode: 1,
      stdoutPath: path.join(dir, "release-b3.stdout.log"), stderrPath: path.join(dir, "release-b3.stderr.log") };
    const wake = { id: "wake:release-b3", jobId: job.id, sessionId: "s", projectId: "p", ownerScope: "o", turnId: "t", status: "abandoned", lastError: "TASK_CONTINUATION_NO_PROGRESS" };
    const messages = new Map();
    const publish = createLongTaskPauseHandler({
      sessionManager: {
        findById: () => ({ id: "s", projectId: "p" }), resolveTurnOwnerScope: () => ({ ok: true, ownerScope: "o" }),
        findMessage: (_, id) => messages.get(id) || null,
        pushMessageTo: (_, role, content, files, extra) => messages.set(extra.id, { role, content, ...extra }),
      },
      eventBus: { emit: () => {} },
    });
    assert.equal((await publish(wake, job)).ok, true);
    const content = [...messages.values()][0].content;
    assert.match(content, /release-b3：失败，退出码 1/, "the notice states the job's terminal state and exit code");
    assert.match(content, /Unknown argument: \/repo\/node_modules\/\.bin\/electron-builder/, "and the line that says why, path intact");
    assert.match(content, /admin login failed for release@lily with \*\*\*/, "an error line that carried a launch value is shown with the value removed");
    assert.ok(!content.includes(secret), "and never a value the job was launched with");
    assert.match(content, /没有新的文件改动/, "and why the chain stopped, in terms of what counts");
    check("a paused chain reports the job's real outcome, redacted by its own launch environment");
  }

  // ------------------------------------------------ Lily's node reads argv as Node
  {
    const rn = require("../src/main/runtime-node.js");
    const posix = rn.buildShimContent("/App/Lily", "/data/runtime-bin/node-argv-compat.cjs", "darwin");
    assert.match(posix, /if \[ -f '\/data\/runtime-bin\/node-argv-compat\.cjs' \]; then exec '\/App\/Lily' --require '\/data\/runtime-bin\/node-argv-compat\.cjs' "\$@"; fi/,
      "the shim preloads the argv compat module");
    assert.match(posix, /\nexec '\/App\/Lily' "\$@"\n$/, "and runs without it when the file is missing");
    const win = rn.buildShimContent("C:\\Lily\\Lily.exe", "C:\\data\\node-argv-compat.cjs", "win32");
    assert.match(win, /if exist "C:\\data\\node-argv-compat\.cjs" \(/);
    assert.match(win, /"C:\\Lily\\Lily\.exe" --require "C:\\data\\node-argv-compat\.cjs" %\*/);
    assert.match(rn.ARGV_COMPAT_CONTENT, /process\.versions\.electron && !process\.defaultApp\) process\.defaultApp = true/);
    const preflight = fs.readFileSync("scripts/release-preflight.mjs", "utf8");
    assert.ok(preflight.indexOf("check-node-argv.mjs") > 0 && preflight.indexOf("check-node-argv.mjs") < preflight.indexOf("releaseMatrixArgs()]"),
      "and a release checks it first, before anything is built");
    check("the node shim gives yargs/commander Node's argv layout, and a release checks it first");
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`job-wake-round-progress: ok (${checks} checks)`);
