#!/usr/bin/env node
// A runner a turn has claimed is not idle, so no configuration change may
// terminate it under the turn.
//
// Field case (2026-09-19, session d6b5a406): the orchestrator ensured a runner,
// then ran pre-turn work on it (compaction) while the runner was not yet busy.
// A "terminate idle runners" path fired in that window, so compaction and the
// send both hit RUNNER_TERMINATED, a 12 s dispatch grace elapsed for an engine
// that did not exist, a failed card landed, and only then did the rescue start a
// second turn. The runner now owns ONE idleness predicate that includes the
// turn's claim, every idle-termination path asks it, and a dispatch failure with
// no engine confirms at once. [gate: runner-turn-reservation]
// Run: node scripts/test-runner-turn-reservation.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
const liveConfig = require("../src/main/runner-live-config.js");

let checks = 0;
function check(name, fn) { const r = fn(); checks += 1; console.log(`ok - ${name}`); return r; }
async function checkAsync(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

/** A runner whose engine start is in flight — alive, not busy: the field shape. */
function startingRunner(id) {
  const runner = new OpencodeAgentSession(id, { createServer: () => ({ terminate() {} }) });
  runner._starting = new Promise(() => {});
  return runner;
}

function poolOf(runners) {
  const map = new Map(runners.map((r) => [r.sessionId, r]));
  const terminated = [];
  return {
    terminated,
    getSessionIds: () => [...map.keys()],
    get: (id) => map.get(id) || null,
    terminateSession(id) { terminated.push(id); map.get(id)?.terminate(); map.delete(id); },
  };
}

check("a claimed runner is not idle; the claim expires with the turn, by construction", () => {
  const runner = startingRunner("claimed");
  assert.equal(runner.isIdle(), true, "alive and not busy: idle");
  const turn = { turnId: "t1", terminalEmitted: false };
  runner.reserveForTurn("t1", () => turn.turnId === "t1" && !turn.terminalEmitted);
  assert.equal(runner.isReserved(), true);
  assert.equal(runner.isIdle(), false, "claimed: not idle");
  turn.terminalEmitted = true;
  assert.equal(runner.isIdle(), true, "the turn ended: the claim is gone without anyone releasing it");
  assert.equal(runner.isReserved(), false);
});

check("the field race: a settings save during pre-turn work no longer kills the turn's runner", () => {
  const claimed = startingRunner("s-claimed");
  const idle = startingRunner("s-idle");
  const pool = poolOf([claimed, idle]);
  const turn = { turnId: "t1", terminalEmitted: false };
  claimed.reserveForTurn("t1", () => turn.turnId === "t1" && !turn.terminalEmitted);
  const first = liveConfig.terminateIdleRunners(pool);
  assert.deepEqual(first.terminated, ["s-idle"], "only the genuinely idle runner is terminated");
  assert.equal(claimed.spawnOptions === null && claimed._starting === null, false, "the claimed runner is intact");
  turn.terminalEmitted = true; // the turn finished (or was aborted before sending)
  const second = liveConfig.terminateIdleRunners(pool);
  assert.deepEqual(second.terminated, ["s-claimed"], "after the turn the same change applies — nothing is lost, only deferred");
});

check("busy and termination both supersede the claim", () => {
  const runner = startingRunner("supersede");
  runner.reserveForTurn("t1", () => true);
  runner.terminate();
  assert.equal(runner.isReserved(), false, "terminate() drops the claim with everything else");
  const src = fs.readFileSync(path.join(ROOT, "src/main/opencode-agent-session.js"), "utf8");
  assert.match(src, /this\.busy = true;\n\s*this\._turnSettled = false;\n\s*this\._turnReservation = null;/, "a send clears the claim the moment busy covers it");
});

check("a stand-in without isIdle gets the pre-reservation baseline, never a crash", () => {
  assert.equal(liveConfig.runnerIsIdle({ isAlive: () => true, isBusy: () => false }), true);
  assert.equal(liveConfig.runnerIsIdle({ isAlive: () => true, isBusy: () => true }), false);
  assert.equal(liveConfig.runnerIsIdle({ isAlive: () => false, isBusy: () => false }), false);
  assert.equal(liveConfig.runnerIsIdle(null), false);
  const throwing = startingRunner("throwing");
  throwing.reserveForTurn("t1", () => { throw new Error("predicate broke"); });
  assert.equal(throwing.isIdle(), true, "a predicate that throws cannot hold a claim — fail open to idle");
});

check("no module outside the runner recomputes idleness by hand", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full);
      if (rel === "src/main/opencode-agent-session.js" || rel === "src/main/runner-idle-lifecycle.js") continue; // the owner
      // Comments may describe the forbidden form; only code is judged.
      const src = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      // The one permitted copy is the documented fallback inside runnerIsIdle.
      const body = rel === "src/main/runner-live-config.js" ? src.replace(/function runnerIsIdle[\s\S]*?\n}\n/, "") : src;
      if (/isAlive\??\.?\(\)\s*&&\s*!\s*[\w.?]*isBusy/.test(body)) offenders.push(rel);
    }
  };
  walk(path.join(ROOT, "src/main"));
  assert.deepEqual(offenders, [], `idleness is the runner's to answer (runnerIsIdle / isIdle):\n${offenders.join("\n")}`);
});

check("the orchestrator claims the runner at every ensure site", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/main/turn-orchestrator.js"), "utf8");
  const ensures = src.match(/runner = ensured\.runner;\n\s*require\("\.\/runner-idle-lifecycle"\)\.claimForTurn\(runner, state\.turnId, \(\) => this\.states\.get\(session\.id\)\);/g) || [];
  const sites = src.match(/runner = ensured\.runner;/g) || [];
  assert.equal(ensures.length, sites.length, "each `runner = ensured.runner` is followed by the claim");
  assert.ok(sites.length >= 2, `both ensure sites are present: ${sites.length}`);
  const lifecycle = fs.readFileSync(path.join(ROOT, "src/main/runner-idle-lifecycle.js"), "utf8");
  assert.match(lifecycle, /state\.turnId === turnId && !state\.terminalEmitted/, "the claim is the turn's own liveness, not a flag");
});

await checkAsync("a dispatch failure with no engine confirms at once instead of waiting out a 12 s grace", async () => {
  const runner = new OpencodeAgentSession("no-engine", { createServer: () => ({ terminate() {} }) });
  runner.cwd = "/tmp";
  // spawnOptions null = a recycled runner: _ensureStarted rejects RUNNER_TERMINATED.
  const failures = [];
  runner._orchestrator = { notifyRunnerError: (id, message) => failures.push(message) };
  const started = Date.now();
  assert.equal(runner.sendUserMessage({ text: "继续" }), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const elapsed = Date.now() - started;
  assert.equal(failures.length, 1, `the failure surfaced: ${JSON.stringify(failures)}`);
  assert.match(String(failures[0]), /RUNNER_TERMINATED|recycled/i);
  assert.ok(elapsed < OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS / 10, `took ${elapsed} ms, not the ${OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS} ms grace`);
  assert.equal(runner.busy, false, "and the runner is free for the rescue");
});

console.log(`\n${checks} checks passed (runner turn reservation)`);
