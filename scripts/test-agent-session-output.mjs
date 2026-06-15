#!/usr/bin/env node
/**
 * AgentSession output aggregation checks.
 *
 * Claude CLI can emit assistant text twice in different shapes:
 * - fine-grained streaming deltas while the turn is running
 * - a final `result` string when the turn completes
 *
 * The UI should show the answer once, and streaming deltas must be joined
 * exactly as text, not as paragraph segments.
 */
import { AgentSession } from "../src/main/agent-session.js";

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
  runner.collectedOutput = "";
  runner._leaseTracker.reset();
  runner._approvals.clearPermissions();
}

{
  const { runner } = createTestSession("output_stream_concat");
  startTurn(runner);
  for (const text of ["你", "好", "！", "有什么", "可以", "帮", "你的", "吗", "？"]) {
    runner._handleNormalizedAction({ kind: "assistant_text", text });
  }
  const expected = "你好！有什么可以帮你的吗？";
  if (runner.collectedOutput !== expected) {
    throw new Error(`assistant_text deltas should concatenate exactly: ${JSON.stringify(runner.collectedOutput)}`);
  }
  runner._completeTurn({ code: 0, output: runner.collectedOutput });
}

{
  const { runner, done } = createTestSession("output_result_dedupes_stream");
  startTurn(runner);
  for (const text of ["你", "好", "！", "有什么", "可以", "帮", "你的", "吗", "？"]) {
    runner._handleNormalizedAction({ kind: "assistant_text", text });
  }
  runner._handleTurnResult({
    type: "result",
    subtype: "success",
    result: "你好！有什么可以帮你的吗？",
  });
  if (done.length !== 1) {
    throw new Error(`turn result should complete once, got ${done.length}`);
  }
  if (done[0].output !== "你好！有什么可以帮你的吗？") {
    throw new Error(`final result should be emitted once: ${JSON.stringify(done[0].output)}`);
  }
  if (done[0].output.includes("\n\n")) {
    throw new Error(`final output must not contain paragraph breaks from deltas: ${JSON.stringify(done[0].output)}`);
  }
}

{
  const { runner, done } = createTestSession("output_stream_fallback");
  startTurn(runner);
  runner._handleNormalizedAction({ kind: "assistant_text", text: "stream-only answer" });
  runner._handleTurnResult({ type: "result", subtype: "success" });
  if (done[0]?.output !== "stream-only answer") {
    throw new Error(`stream fallback should remain available: ${JSON.stringify(done[0]?.output)}`);
  }
}

console.log("agent-session-output: ok");
