#!/usr/bin/env node
/**
 * Turn settlement semantics: a CLI `result` that arrives while blocking work
 * (foreground tools / permissions) is still outstanding must be DEFERRED, then
 * released as soon as the blockers clear — or force-released once the grace
 * window expires (a stuck blocker must not hang the turn forever).
 * These tests lock the behavior before/after the settlement extraction.
 */
import { AgentSession } from "../src/main/agent-session.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

AgentSession.DEFERRED_TURN_RESULT_GRACE_MS = 40;

function createTestSession(sessionId) {
  const runner = new AgentSession(sessionId);
  const done = [];
  runner.bindOrchestrator({
    ingest() {},
    notifyRunnerDone(_sid, payload) {
      done.push(payload);
    },
    notifyRunnerError() {},
  });
  return { runner, done };
}

function startTurn(runner) {
  runner.busy = true;
  runner._turnSettled = false;
  runner.collectedOutput = "answer";
  runner._leaseTracker.reset();
  runner._approvals.clearPermissions();
}

// 1. Deferred result releases as soon as the blocking tool finishes (well
//    inside the grace window).
{
  const { runner, done } = createTestSession("settle_release");
  startTurn(runner);
  runner._leaseTracker.track("t1", "Bash", { command: "npm test" });
  runner._deferTurnResult({ code: 0, output: "deferred answer" }, "test");
  await sleep(10);
  if (done.length !== 0) {
    throw new Error("result must stay deferred while a foreground tool is pending");
  }
  runner._finishToolLease("t1");
  runner._maybeCompleteDeferredTurnResult();
  if (done.length !== 1) {
    throw new Error(`clearing the blocker must release the deferred result, got ${done.length}`);
  }
  if (runner.busy || !runner._turnSettled) {
    throw new Error("released turn must settle");
  }
}

// 2. A blocker that never clears must not hang the turn: the grace window
//    force-releases the deferred result (with the stale-blocker warning).
{
  const { runner, done } = createTestSession("settle_stale");
  startTurn(runner);
  runner._leaseTracker.track("t_stuck", "Bash", { command: "sleep 999" });
  runner._deferTurnResult({ code: 0, output: "stale release" }, "test");
  await sleep(120);
  if (done.length !== 1) {
    throw new Error(`grace expiry must force-release the deferred result, got ${done.length}`);
  }
}

// 3. No blockers at defer time → releases almost immediately via the poll.
{
  const { runner, done } = createTestSession("settle_fast");
  startTurn(runner);
  runner._deferTurnResult({ code: 0, output: "fast" }, "test");
  await sleep(60);
  if (done.length !== 1) {
    throw new Error("deferred result without blockers must release promptly");
  }
}

// 4. Background activity blocks auto-completion until its window passes.
{
  const { runner } = createTestSession("settle_background");
  startTurn(runner);
  runner._backgroundActivityUntil = Date.now() + 30;
  if (runner._canAutoCompleteTurn()) {
    throw new Error("background activity window must block auto completion");
  }
  await sleep(45);
  if (!runner._canAutoCompleteTurn()) {
    throw new Error("auto completion must unblock after the background window");
  }
}

console.log("turn-settlement: ok");
