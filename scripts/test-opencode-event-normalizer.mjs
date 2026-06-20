#!/usr/bin/env node
/**
 * OpenCode adapter contract (INSTANCE-API classic events). Server SSE events
 * (envelope {id,type,properties}) must become the SAME engine-agnostic actions +
 * RuntimeEvent drafts the renderer + agent-session already consume.
 *
 * Tests encode WHY: a text delta MUST stream as assistant_text; a tool part MUST
 * emit exactly one tool_use (on running) and one tool_result (on completed) or
 * the UI shows duplicate/again-running tools; session.idle MUST end the turn or
 * it hangs forever.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpencodeEventAdapter } = require("../src/main/runtime/adapters/opencode-cli-adapter.js");
const { normalizeOpencodeEvent } = require("../src/main/runtime/adapters/opencode-event-normalizer.js");

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const ev = (type, properties) => ({ id: "evt_x", type, properties });
function actions(type, properties, state) { return normalizeOpencodeEvent(ev(type, properties), state); }
function only(type, properties, state) {
  const a = actions(type, properties, state);
  if (a.length !== 1) throw new Error(`expected 1 action for ${type}, got ${a.length}: ${JSON.stringify(a)}`);
  return a[0];
}

// --- streaming text / reasoning deltas -------------------------------------
{
  const t = only("message.part.delta", { field: "text", delta: "hi", messageID: "m", partID: "p" });
  assert(t.kind === "assistant_text" && t.text === "hi", "text delta -> assistant_text");
  const r = only("message.part.delta", { field: "reasoning", delta: "ponder" });
  assert(r.kind === "assistant_thinking" && r.text === "ponder", "reasoning delta -> assistant_thinking");
  assert(actions("message.part.delta", { field: "text", delta: "" }).length === 0, "empty delta ignored");
}

// --- reasoning deltas mislabeled field:"text" are routed by part type --------
// (deepseek-v4-pro via the Anthropic endpoint streams reasoning deltas as
//  field:"text"; without partID routing the chain-of-thought leaks into the answer.)
{
  const state = { tools: new Map(), parts: new Map() };
  // the reasoning part announces itself first
  actions("message.part.updated", { part: { id: "prt_r", type: "reasoning", text: "" } }, state);
  actions("message.part.updated", { part: { id: "prt_t", type: "text", text: "" } }, state);
  // a delta for the reasoning part arrives mislabeled as field:"text"
  const r = only("message.part.delta", { partID: "prt_r", field: "text", delta: "thinking..." }, state);
  assert(r.kind === "assistant_thinking", "delta for a reasoning part -> assistant_thinking (not leaked as answer)");
  const t = only("message.part.delta", { partID: "prt_t", field: "text", delta: "你好" }, state);
  assert(t.kind === "assistant_text" && t.text === "你好", "delta for a text part -> assistant_text");
}

// --- text part.updated is NOT re-emitted (would dup the deltas / echo user) --
{
  assert(actions("message.part.updated", { part: { type: "text", text: "say hi in 3 words" } }).length === 0,
    "text part.updated suppressed (deltas already streamed it)");
}

// --- tool lifecycle: one tool_use (running) + one tool_result (completed) ----
{
  const state = { tools: new Map() };
  const start = only("message.part.updated", { part: { type: "tool", tool: "bash", callID: "c1", state: { status: "running", input: { command: "ls" } } } }, state);
  assert(start.kind === "assistant_tool_use" && start.id === "c1" && start.name === "bash", "tool running -> assistant_tool_use");
  assert(start.input.command === "ls", "tool input carried");

  // an intermediate running update (metadata) must NOT re-emit the tool_use.
  assert(actions("message.part.updated", { part: { type: "tool", tool: "bash", callID: "c1", state: { status: "running", metadata: { output: "partial" }, input: { command: "ls" } } } }, state).length === 0,
    "duplicate running update suppressed");

  const done = only("message.part.updated", { part: { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", output: "file.txt", input: { command: "ls" } } } }, state);
  assert(done.kind === "tool_result" && done.id === "c1" && done.isError === false, "tool completed -> tool_result");
  assert(done.content === "file.txt", "tool output flattened into result");
}

// --- tool_use waits for args; error still yields a tool_result --------------
{
  const state = { tools: new Map() };
  // First running event has no args yet -> no premature (blank) tool_use.
  assert(actions("message.part.updated", { part: { type: "tool", tool: "bash", callID: "c2", state: { status: "running", input: {} } } }, state).length === 0,
    "running with empty input -> no blank tool_use yet");
  const start = only("message.part.updated", { part: { type: "tool", tool: "bash", callID: "c2", state: { status: "running", input: { command: "x" } } } }, state);
  assert(start.kind === "assistant_tool_use" && start.input.command === "x", "tool_use emitted once args arrive");
  const fail = only("message.part.updated", { part: { type: "tool", tool: "bash", callID: "c2", state: { status: "error", error: "boom", input: { command: "x" } } } }, state);
  assert(fail.kind === "tool_result" && fail.isError === true && fail.content === "boom", "tool error -> tool_result isError");
}

// --- tool that goes straight to completed (no args-bearing running) still works
{
  const state = { tools: new Map() };
  const acts = actions("message.part.updated", { part: { type: "tool", tool: "bash", callID: "c4", state: { status: "completed", output: "done", input: { command: "y" } } } }, state);
  assert(acts.length === 2 && acts[0].kind === "assistant_tool_use" && acts[1].kind === "tool_result", "completed-without-prior-running emits both use + result");
}

// --- step-finish carries token usage ---------------------------------------
{
  const u = only("message.part.updated", { part: { type: "step-finish", reason: "stop", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 8, write: 2 } }, cost: 0.01 } });
  assert(u.kind === "stream_message_delta", "step-finish -> stream_message_delta (carries usage)");
  assert(u.usage.input_tokens === 100, "input tokens mapped");
  assert(u.usage.output_tokens === 25, "output+reasoning tokens summed");
  assert(u.usage.cache_read_input_tokens === 8 && u.usage.cache_creation_input_tokens === 2, "cache tokens mapped");
}

// --- turn completion: session.idle / session.status idle --------------------
{
  assert(only("session.idle", { sessionID: "s" }).kind === "turn_result", "session.idle -> turn_result");
  assert(only("session.status", { status: { type: "idle" } }).kind === "turn_result", "session.status idle -> turn_result");
  assert(actions("session.status", { status: { type: "busy" } }).length === 0, "session.status busy -> nothing");
}

// --- engine error -----------------------------------------------------------
{
  const e = only("message.error", { error: { message: "model down" } });
  assert(e.kind === "runtime_error" && e.event.message === "model down", "message.error -> runtime_error");
}

// --- permission request (real instance `permission.asked` shape) ------------
{
  const p = only("permission.asked", {
    id: "perm_1",
    permission: "bash",
    metadata: { command: "rm", description: "remove" },
    tool: { callID: "c9", messageID: "m1" },
  });
  assert(p.kind === "permission_check" && p.requestId === "perm_1", "permission.asked -> permission_check");
  assert(p.toolName === "bash", "toolName from the `permission` field");
  assert(p.callId === "c9", "callID from tool.callID");
  assert(p.input.command === "rm" && p.description === "remove", "metadata surfaced for the dialog");
}

// --- question tool -> ask_user_question -------------------------------------
{
  const q = only("question.asked", {
    id: "que_1",
    questions: [{ question: "Which DB?", header: "DB", options: [{ label: "PG" }, { label: "SQLite" }], multiple: false, custom: true }],
    tool: { callID: "c7" },
  });
  assert(q.kind === "ask_user_question" && q.requestId === "que_1", "question.asked -> ask_user_question");
  assert(q.input.questions[0].header === "DB", "question carried");
  assert(q.input.questions[0].multiSelect === false && q.input.questions[0].allowCustom === true, "multiple->multiSelect, custom->allowCustom");
  assert(q.input.questions[0].options.length === 2, "options carried");
}

// --- noise events are silent; unknown events surface for diagnostics ---------
{
  for (const t of ["server.connected", "plugin.added", "catalog.updated", "message.updated", "session.updated", "step-start", "session.next.prompt.admitted"]) {
    assert(actions(t, {}).length === 0, `${t} silent`);
  }
  const u = only("some.future.event", {});
  assert(u.kind === "unknown_runtime_event", "unknown event surfaced for diagnostics");
}

// --- adapter envelope + runtime drafts + capabilities -----------------------
{
  const adapter = new OpencodeEventAdapter();
  const env = adapter.normalizeEvent(ev("message.part.delta", { field: "text", delta: "hi" }));
  assert(env.adapter === "opencode", "envelope adapter=opencode");
  assert(env.runtimeEvents[0].type === "assistant.delta" && env.runtimeEvents[0].source === "opencode", "delta -> assistant.delta runtime draft (opencode source)");
  assert(adapter.capabilities.streamInput === false && adapter.capabilities.permissionAlwaysAsk === true, "capabilities declared");

  // adapter de-dups tools across calls via internal state; reset() clears it.
  const toolEv = ev("message.part.updated", { part: { type: "tool", tool: "bash", callID: "z", state: { status: "running", input: { command: "x" } } } });
  adapter.normalizeEvent(toolEv);
  assert(adapter.normalizeEvent(toolEv).actions.length === 0, "same tool/state de-duped within a turn");
  adapter.reset();
  const after = adapter.normalizeEvent(toolEv);
  assert(after.actions.length === 1 && after.actions[0].kind === "assistant_tool_use", "reset() clears tool de-dup so a new turn re-emits");
}

console.log("opencode-event-normalizer: ok");
