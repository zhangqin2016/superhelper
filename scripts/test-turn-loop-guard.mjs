import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session");
const { shouldRecoverParentClosure } = require("../src/main/parent-task-closure");
const { captureParentClosureSource } = require("../src/main/turn-parent-closure-runtime");
const { TurnArchive } = require("../src/main/turn-archive");
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const session = new OpencodeAgentSession("repeat-test");
  const done = [], drafts = [];
  let aborted = 0;
  session._server = { sessionID: "engine-repeat", sendPrompt: async () => {}, abort: async () => { aborted++; return true; }, terminate() {} };
  session.bindOrchestrator({ ingest: (_id, batch) => drafts.push(...batch), notifyRunnerDone: (_id, payload) => done.push(payload) });
  session.busy = true; session._turnSettled = false;
  session._pendingPromptPayload = { text: "Check the background job and deliver the result." };
  const event = (type, properties) => session._handleEvent({ type, properties });
  event("message.updated", { info: { id: "msg_test", role: "assistant" } });
  event("message.part.updated", { part: { id: "part_test", messageID: "msg_test", type: "text", text: "" } });
  const text = delta => event("message.part.delta", { partID: "part_test", messageID: "msg_test", field: "text", delta });
  let serial = 0;
  function tool(name, input, result) {
    const callID = `call_${++serial}`;
    for (const status of ["running", "completed"]) event("message.part.updated", { part: {
      id: callID, type: "tool", callID, tool: name, state: { status, input, output: JSON.stringify(result) },
    } });
  }
  return { session, done, drafts, event, text, tool, aborts: () => aborted, close: () => session.terminate() };
}
const phrase = "Let me check the flow. Let me check the job.\n";
{
  const f = fixture();
  for (const c of phrase.repeat(30)) f.text(c);
  assert.equal(f.done.length, 0, "settlement waits for bounded abort receipt");
  assert.equal(f.session.sendUserMessage("next"), false, "next turn waits for abort settlement");
  await tick();
  assert.equal(f.done.length, 1, "fragmented two-sentence loop must terminate instead of endlessly refreshing liveness");
  assert.equal(f.done[0].loopDetected?.kind, "repeated_text");
  assert(f.done[0].output.includes("Let me check"), "partial output is preserved");
  assert(f.done[0].output.includes("重复"), "termination is explained");
  assert.equal(f.aborts(), 1);
  f.text(phrase); assert.equal(f.done.length, 1, "late deltas cannot settle twice");
  await tick(); assert.equal(f.session.isBusy(), false); f.close();
}
for (const protectedPrefix of ["```text\n", "> ", "\"", "- "]) {
  const f = fixture(); f.text(protectedPrefix + phrase.repeat(30));
  assert.equal(f.done.length, 0, "structured/quoted content fails open"); f.close();
}
{
  const f = fixture(); f.text("```text\n" + "x".repeat(33_000) + "\n" + phrase.repeat(30));
  assert.equal(f.done.length, 0, "oversized snapshots cannot erase their opening protection"); f.close();
}
{
  const f = fixture(); f.session._pendingPromptPayload.text = `Repeat these exact sentences: ${phrase}`;
  f.text(phrase.repeat(30)); assert.equal(f.done.length, 0, "requested source material is not stopped"); f.close();
}
{
  const f = fixture(); f.session._pendingQuestions.set("q", { questions: [] });
  f.text(phrase.repeat(30)); assert.equal(f.done.length, 0, "pending user answer is never auto-aborted"); f.close();
}
{
  const f = fixture();
  for (let i = 0; i < 30; i++) { f.text(phrase); f.tool("job_status", { jobId: "job-1" }, { ok: true, jobId: "job-1", state: "running", stdoutBytes: i, updatedAt: String(i) }); }
  assert.equal(f.done.length, 0, "real changing job output permits long work"); f.close();
}
{
  const f = fixture();
  for (let i = 0; i < 30; i++) f.tool("lily_process_jobs_job_status", { jobId: "job-1" }, { ok: true, jobId: "job-1", state: "running", stdoutBytes: 0, updatedAt: String(i) });
  await tick();
  assert.equal(f.done.length, 1, "unchanged polling eventually yields instead of consuming model steps forever");
  assert.equal(f.done[0].loopDetected?.kind, "repeated_job_poll"); await tick(); f.close();
}
{
  process.env.LILY_TURN_LOOP_GUARD = "0";
  const f = fixture(); f.text(phrase.repeat(30)); assert.equal(f.done.length, 0, "kill switch retains baseline"); f.close();
  delete process.env.LILY_TURN_LOOP_GUARD;
}
{
  const f = fixture();
  // A code fence beyond the bounded tail must still protect subsequent contents.
  for (let i = 0; i < 1500; i++) f.text(i === 0 ? "```text\n" : phrase);
  assert.equal(f.done.length, 0, "trimming the observation tail cannot forget a protected block"); f.close();
}
{
  const f = fixture();
  for (let i = 0; i < 30; i++) f.tool("job_status", { jobId: "minimal" }, { ok: true, jobId: "minimal", state: "running" });
  await tick();
  assert.equal(f.done.length, 1, "valid status without optional timestamps is still monitored"); await tick(); f.close();
}
{
  const f = fixture();
  for (let i = 0; i < 30; i++) f.text(`Completed distinct step ${i}.\n`);
  assert.equal(f.done.length, 0, "changing text remains valid work");
  f.session._activeTools.set("long", { id: "long", name: "bash", startedAt: Date.now() });
  f.text(phrase.repeat(30)); assert.equal(f.done.length, 0, "foreground work retains its existing lease"); f.close();
}
{
  const f = fixture(); f.text(phrase.repeat(30)); await tick();
  const source = captureParentClosureSource({ turnId: "turn-one", taskContract: { active: true, taskType: "code_change" }, tools: new Map([["write", { name: "write", status: "done" }]]) }, f.done[0]);
  assert.equal(shouldRecoverParentClosure({ sessionId: "s", ...source }).reason, "CONFIRMED_LOOP", "the actual closure snapshot cannot re-prompt a stopped loop");
  f.close();
}
{
  const f = fixture();
  for (let i = 0; i < 30; i++) {
    f.tool("job_status", { jobId: "a" }, { ok: true, jobId: "a", state: "running", stdoutBytes: 0 });
    f.tool("job_status", { jobId: "b" }, { ok: true, jobId: "b", state: "running", stdoutBytes: i });
  }
  assert.equal(f.done.length, 0, "progress on another job protects the whole turn"); f.close();
}
{
  const f = fixture(); f.session._activeTools.set("foreground", { id: "foreground", name: "bash", startedAt: Date.now() });
  for (let i = 0; i < 30; i++) f.tool("job_status", { jobId: "a" }, { ok: true, jobId: "a", state: "running" });
  assert.equal(f.done.length, 0, "repetitive background inspection cannot abort unrelated foreground work"); f.close();
}
{
  const f = fixture(); f.text(phrase.repeat(30)); await tick();
  const record = new TurnArchive({}).buildRecord({ sessionId: "loop-archive", turnId: "turn-loop", tools: new Map() }, "turn.stalled", { ...f.done[0], assistant: f.done[0].output });
  assert.deepEqual(record.meta.loopDetected, f.done[0].loopDetected, "archive preserves reason without storing a separate sensitive repeated-text sample"); f.close();
}
{
  const f = fixture(); let retired = 0;
  f.session.agentResumeId = "engine-repeat";
  f.session._server.abort = async () => false;
  f.session._server.terminate = () => { retired++; };
  f.text(phrase.repeat(30)); await tick();
  assert.equal(retired, 1, "explicit false abort response must retire the unsafe adapter");
  assert.equal(f.session._server, null);
  assert.equal(f.session.agentResumeId, null, "unconfirmed abort cannot resume the same engine session");
  assert.equal(f.done[0].loopDetected.abortConfirmed, false, "failed abort is not advertised as confirmed stop"); f.close();
}
{
  const f = fixture(); let resolveAbort;
  f.session.agentResumeId = "engine-repeat";
  f.session._server.abort = () => new Promise(resolve => { resolveAbort = resolve; });
  f.text(phrase.repeat(30)); f.session.interrupt();
  assert.equal(f.done.length, 1); assert.equal(f.done[0].interruptedByUser, true);
  resolveAbort(false); await tick();
  assert.equal(f.done.length, 1, "user stop wins over pending loop finalization");
  assert.equal(f.session.agentResumeId, null, "user stop during failed abort still invalidates old resume identity"); f.close();
}
{
  const f = fixture(); const previous = OpencodeAgentSession.INTERRUPT_ABORT_TIMEOUT_MS;
  let retired = 0; f.session.agentResumeId = "engine-repeat";
  f.session._server.abort = () => new Promise(() => {});
  f.session._server.terminate = () => { retired++; };
  try {
    OpencodeAgentSession.INTERRUPT_ABORT_TIMEOUT_MS = 5;
    f.text(phrase.repeat(30));
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(retired, 1); assert.equal(f.done.length, 1);
    assert.equal(f.done[0].loopDetected.abortConfirmed, false);
    assert.equal(f.session.agentResumeId, null); assert.equal(f.session.isBusy(), false);
  } finally { OpencodeAgentSession.INTERRUPT_ABORT_TIMEOUT_MS = previous; f.close(); }
}
{
  const f = fixture(); let resolveAbort;
  f.session._server.abort = () => new Promise(resolve => { resolveAbort = resolve; });
  f.text(phrase.repeat(30)); f.session.terminate();
  const newer = { sessionID: "newer", terminate() {} };
  f.session._server = newer; f.session.agentResumeId = "newer";
  f.session._turnGates = require("../src/main/turn-continuation-budget").createTurnGateState();
  f.session.busy = true; f.session._turnSettled = false;
  resolveAbort(false); await tick();
  assert.equal(f.session._server, newer); assert.equal(f.session.agentResumeId, "newer");
  assert.equal(f.done.length, 0, "old abort completion cannot settle a replacement turn"); f.close();
}
{
  const f = fixture(); f.text(phrase.repeat(30)); await tick();
  assert.equal(f.session.sendUserMessage("A new task"), true); await tick();
  f.event("message.updated", { info: { id: "msg_test", role: "assistant" } });
  f.event("message.part.updated", { part: { id: "part_test", messageID: "msg_test", type: "text", text: "" } });
  f.text(phrase);
  assert.equal(f.done.length, 1, "real next user turn gets a fresh repetition window"); f.close();
}
for (const source of ["让我检查一下任务。让我再确认一下进度。", "Let me check.\n"]) {
  const f = fixture(); f.text(source.repeat(40)); await tick();
  assert.equal(f.done[0]?.loopDetected?.kind, "repeated_text", "short Chinese/English units still require sufficient cumulative exact-repeat evidence"); f.close();
}
console.log("turn-loop-guard: PASS");
