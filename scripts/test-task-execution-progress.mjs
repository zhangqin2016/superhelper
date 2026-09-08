import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session");
const { createOpencodeRuntimeState, reduceOpencodeRuntimeEvent } = require("../src/main/runtime/opencode-runtime-reducer");
const { createTurnGateState, claimContinuation } = require("../src/main/turn-continuation-budget");
const { todoContinuationDecision } = require("../src/main/opencode-todo-completion-policy");
const session = new OpencodeAgentSession("execution-progress-test");
const runtime = createOpencodeRuntimeState();
let serial = 0;
function execution({ name = "bash", input = { command: "node test-one.cjs" }, output = "1 passed", status = "completed", exit = 0 } = {}) {
  const id = `call-${++serial}`;
  for (const state of ["running", status]) {
    const reduced = reduceOpencodeRuntimeEvent({ type: "message.part.updated", properties: {
      part: { type: "tool", callID: id, tool: name, state: { status: state, input, output, metadata: { exit } } },
    } }, runtime);
    for (const draft of reduced.drafts) if (draft.type.startsWith("tool.")) session._noteToolActivity(draft);
  }
}
session._rememberLatestTodos([{ content: "finish complex implementation", status: "in_progress" }]);
session._turnGates.todo.attempts = 2;
execution();
assert.equal(session._turnGates.todo.attempts, 0, "a real unique successful receipt resets consecutive attempts even with unchanged todos");
assert.equal(session._turnGates.todo.progress, 1);
session._turnGates.todo.attempts = 2;
execution();
assert.equal(session._turnGates.todo.attempts, 2, "a different call id is not new progress");
execution({ status: "error", output: "failed" });
execution({ exit: 1, output: "new failure" });
execution({ input: { command: 'node test-one.cjs; echo "EXIT_CODE=$?"' }, output: "failed\nEXIT_CODE=1\n" });
execution({ input: { command: 'node test-one.cjs; echo "EXIT_CODE=$?"' }, output: "passed\nEXIT_CODE=0\n", exit: 1 });
execution({ status: "running", output: "running" });
execution({ status: "cancelled", output: "cancelled" });
execution({ name: "todowrite", input: { todos: [{ content: "rename todo", status: "completed" }] }, output: "updated" });
session._rememberLatestTodos([{ content: "rename complex implementation", status: "in_progress" }]);
assert.equal(session._turnGates.todo.attempts, 2, "failures, active work and plan churn cannot refill budget");
execution({ output: "2 passed" });
assert.equal(session._turnGates.todo.attempts, 0, "a changed successful observation is progress");
session._turnGates.todo.total = 6;
assert.equal(todoContinuationDecision({ total: 1, unfinished: [{}] }, 0, session._turnGates.todo.total), "settle");
session._turnGates.continuations = 4;
assert.equal(claimContinuation(session._turnGates, "todo"), false, "execution progress never refills shared cap");
session._turnGates = createTurnGateState();
session._turnGates.todo.attempts = 2;
execution();
assert.equal(session._turnGates.todo.attempts, 0, "receipt deduplication is turn scoped");
for (let i = 0; i < 4; i++) {
  session._turnGates.todo.attempts = 2;
  execution({ name: "lily_process_jobs_job_status", input: { jobId: "job-1" }, output: JSON.stringify({
    ok: true, jobId: "job-1", state: "running", stdoutBytes: 0, updatedAt: String(i), heartbeatAt: String(i),
  }) });
  assert.equal(session._turnGates.todo.attempts, i === 0 ? 0 : 2, "observation timestamp changes cannot refill no-progress attempts");
}
execution({ name: "lily_process_jobs_job_status", input: { jobId: "job-1" }, output: JSON.stringify({
  ok: true, jobId: "job-1", state: "running", stdoutBytes: 10, updatedAt: "5",
}) });
assert.equal(session._turnGates.todo.attempts, 0, "real job log growth remains progress");
console.log("task execution progress: PASS (actual reducer → session completion path, bounded continuation)");
