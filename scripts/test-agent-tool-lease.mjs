#!/usr/bin/env node
/**
 * Agent tool lease checks: shell tools keep the turn busy until tool_result,
 * while explicitly detached shell commands do not block turn auto-completion.
 */
import { AgentSession } from "../src/main/agent-session.js";

function startSyntheticTurn(runner) {
  runner.busy = true;
  runner._turnSettled = false;
  runner.collectedOutput = "partial answer";
  runner._pendingToolIds.clear();
  runner._toolLeases.clear();
  runner._pendingPermissions.clear();
}

function line(runner, event) {
  runner._handleLine(JSON.stringify(event));
}

const runner = new AgentSession("sess_tool_lease");
AgentSession.TOOL_LONG_TASK_NOTICE_MS = 5;

startSyntheticTurn(runner);
line(runner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tool_bash_1", name: "Bash" },
  },
});

if (runner._canAutoCompleteTurn()) {
  throw new Error("running Bash lease should block auto completion before tool_result");
}

const notice = await new Promise((resolve) => {
  runner.once("engine-notice", resolve);
  setTimeout(() => resolve(null), 100);
});
if (notice?.code !== "shellLongRunning") {
  throw new Error("running Bash lease should emit long-running notice");
}

line(runner, {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_bash_1",
        content: [{ type: "text", text: "done" }],
      },
    ],
  },
});
runner._clearPostToolWaitTimer();

if (!runner._canAutoCompleteTurn()) {
  throw new Error("tool_result should release Bash lease");
}

startSyntheticTurn(runner);
line(runner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tool_bash_2", name: "Bash" },
  },
});
line(runner, {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 1,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify({
        command: "nohup npm run dev > /tmp/app.log 2>&1 &",
      }),
    },
  },
});
line(runner, {
  type: "stream_event",
  event: { type: "content_block_stop", index: 1 },
});

if (!runner._canAutoCompleteTurn()) {
  throw new Error("detached Bash command should not block auto completion");
}

runner._completeTurn({ code: 0, output: "" });

AgentSession.INTERRUPT_FALLBACK_MS = 5;
const interrupted = new AgentSession("sess_interrupt_fallback");
let killed = false;
interrupted.process = {
  killed: false,
  stdin: { destroyed: false, write: () => true },
  kill: () => {
    killed = true;
  },
};
interrupted.busy = true;
interrupted._turnSettled = false;
const done = new Promise((resolve) => interrupted.once("done", resolve));
interrupted.interrupt();
const donePayload = await done;
await new Promise((resolve) => setTimeout(resolve, 0));
if (!donePayload?.interrupted) {
  throw new Error("interrupt fallback should complete as interrupted");
}
if (!killed || interrupted.process !== null) {
  throw new Error("interrupt fallback should terminate dirty runner");
}

console.log("agent-tool-lease: ok");
