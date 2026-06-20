#!/usr/bin/env node
/**
 * OpencodeAgentSession integration logic, exercised with a fake server manager
 * and fake orchestrator (no network). Verifies the drop-in contract that the
 * real turn-orchestrator depends on:
 *  - streaming events become orchestrator.ingest() drafts (renderer-neutral);
 *  - a terminal turn_result calls notifyRunnerDone exactly once;
 *  - a runtime_error calls notifyRunnerError;
 *  - a permission request surfaces a permission.requested draft AND the host's
 *    allow/deny maps to the right OpenCode reply (once/always/reject);
 *  - the busy guard rejects a concurrent send.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const tick = () => new Promise((r) => setImmediate(r));

class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.prompts = [];
    this.permissionReplies = [];
    this.aborted = false;
    this.process = { killed: false };
    this.sessionID = null;
  }
  async start() { return { host: "127.0.0.1", port: 4096 }; }
  async createSession() { this.sessionID = "ses_test"; return this.sessionID; }
  subscribe() { this.subscribed = true; }
  async sendPrompt(p) { this.prompts.push(p); }
  async respondPermission(id, d) { this.permissionReplies.push({ id, ...d }); }
  async respondQuestion(id, answers) { this.questionReplies = this.questionReplies || []; this.questionReplies.push({ id, answers }); }
  async abort() { this.aborted = true; return true; }
  terminate() { this.process = null; }
  emitEvent(ev) { this.emit("event", ev); }
}

function makeOrchestrator() {
  const calls = { ingest: [], done: [], error: [] };
  return {
    calls,
    ingest: (sid, drafts) => calls.ingest.push(...drafts),
    notifyRunnerDone: (sid, p) => calls.done.push(p),
    notifyRunnerError: (sid, m) => calls.error.push(m),
  };
}
const draftTypes = (orch) => orch.calls.ingest.map((d) => d.type);
const draft = (orch, type) => orch.calls.ingest.find((d) => d.type === type);

async function newSession() {
  const fake = new FakeServer();
  const session = new OpencodeAgentSession("app_session_1", { createServer: () => fake });
  const orch = makeOrchestrator();
  session.bindOrchestrator(orch);
  session.ensureProcess(process.cwd(), { agentCommand: "/bin/true" }, { lazy: true });
  return { fake, session, orch };
}

// --- a full text turn ------------------------------------------------------
{
  const { fake, session, orch } = await newSession();
  assert(session.sendUserMessage({ text: "hello" }) === true, "first send accepted");
  assert(session.isBusy() === true, "session is busy after send");
  await tick(); // let _ensureStarted (start + createSession) resolve
  assert(fake.prompts.length === 1 && fake.prompts[0].text === "hello", "prompt POSTed with text");
  assert(orch.calls.done.length === 0, "turn not done before terminal event");

  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "hi " } });
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "there" } });
  assert(draftTypes(orch).filter((t) => t === "assistant.delta").length === 2, "text deltas ingested");

  fake.emitEvent({ type: "message.part.updated", properties: { part: { type: "step-finish", reason: "stop", tokens: { input: 50, output: 10, cache: { read: 0, write: 0 } } } } });
  assert(draftTypes(orch).includes("usage.updated"), "step-finish surfaces usage.updated to renderer");

  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  assert(orch.calls.done.length === 1, "session.idle completes the turn exactly once");
  assert(session.isBusy() === false, "session idle after completion");
}

// --- spawn:true preflight: isAlive() true during async startup --------------
// (Regression: the orchestrator rejects a send with "Unable to start the
//  assistant process" if isAlive() is false right after a non-lazy ensureProcess;
//  OpenCode's serve starts async, so isAlive must count the in-flight start.)
{
  const fake = new FakeServer();
  let resolveStart;
  fake.start = () => new Promise((r) => { resolveStart = () => r({ host: "127.0.0.1", port: 4096 }); });
  const session = new OpencodeAgentSession("app_preflight", { createServer: () => fake });
  session.bindOrchestrator(makeOrchestrator());
  session.ensureProcess(process.cwd(), { agentCommand: "/bin/true" }, { lazy: false });
  assert(session.isAlive() === true, "isAlive() true while serve is still starting (preflight passes)");
  resolveStart();
  await tick();
  session.terminate();
}

// --- busy guard ------------------------------------------------------------
{
  const { session } = await newSession();
  session.sendUserMessage({ text: "one" });
  assert(session.sendUserMessage({ text: "two" }) === false, "concurrent send rejected while busy");
  session.terminate();
}

// --- tool flow: started + result, content relocated to result -------------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "run a tool" });
  await tick();
  fake.emitEvent({ type: "message.part.updated", properties: { part: { type: "tool", tool: "bash", callID: "c1", state: { status: "running", input: { command: "ls" } } } } });
  fake.emitEvent({ type: "message.part.updated", properties: { part: { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", output: "file.txt", input: { command: "ls" } } } } });

  assert(draftTypes(orch).includes("tool.started"), "tool running -> tool.started draft");
  const done = draft(orch, "tool.done");
  assert(done, "tool completed -> tool.done draft");
  assert(!("content" in done.payload), "tool.done content relocated off payload");
  assert(done.payload.result && done.payload.result.content === "file.txt", "tool output moved into result");
  session.terminate();
}

// --- permission round trip -------------------------------------------------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "delete stuff" });
  await tick();
  fake.emitEvent({
    type: "permission.asked",
    properties: { id: "per_1", permission: "bash", metadata: { command: "rm x" }, tool: { callID: "c9" } },
  });
  const req = draft(orch, "permission.requested");
  assert(req && req.payload.requestId === "per_1", "permission.requested surfaced to UI");
  assert(req.payload.toolName === "bash", "permission toolName carried");

  // Host allows-and-remembers -> OpenCode "always".
  assert(session.respondPermission("per_1", { allow: true, remember: true }) === true, "respondPermission accepted");
  await tick();
  assert(fake.permissionReplies.length === 1 && fake.permissionReplies[0].reply === "always",
    "allow+remember maps to reply=always");
  assert(draft(orch, "permission.resolved"), "permission.resolved draft emitted");

  // Replying to an unknown request id is a no-op.
  assert(session.respondPermission("nope", { allow: false }) === false, "unknown permission id ignored");
  session.terminate();
}

// --- deny maps to reject ---------------------------------------------------
{
  const { fake, session } = await newSession();
  session.sendUserMessage({ text: "x" });
  await tick();
  fake.emitEvent({ type: "permission.asked", properties: { id: "per_2", permission: "edit", metadata: {}, tool: {} } });
  session.respondPermission("per_2", { allow: false });
  await tick();
  assert(fake.permissionReplies[0].reply === "reject", "deny maps to reply=reject");
  session.terminate();
}

// --- question round trip ----------------------------------------------------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "pick one" });
  await tick();
  fake.emitEvent({
    type: "question.asked",
    properties: { id: "que_1", questions: [{ question: "DB?", header: "DB", options: [{ label: "PG" }], multiple: false }], tool: { callID: "c7" } },
  });
  const req = draft(orch, "user_question.requested");
  assert(req && req.payload.requestId === "que_1", "question surfaced to UI");
  assert(req.payload.questions[0].header === "DB", "questions carried to UI");

  assert(session.respondUserQuestion("que_1", { answers: { DB: "PG" } }) === true, "respondUserQuestion accepted");
  await tick();
  assert(fake.questionReplies?.length === 1, "question reply POSTed");
  assert(JSON.stringify(fake.questionReplies[0].answers) === JSON.stringify([["PG"]]), "answer coerced to string[][] by header");
  assert(draft(orch, "user_question.resolved"), "user_question.resolved emitted");
  session.terminate();
}

// --- engine error fails the turn ------------------------------------------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "x" });
  await tick();
  fake.emitEvent({ type: "message.error", properties: { error: { message: "model exploded" } } });
  assert(orch.calls.error.length === 1, "message.error triggers notifyRunnerError");
  assert(session.isBusy() === false, "session idle after failure");
}

// --- resume: prior OpenCode session id flows to the server for continuity ---
{
  let captured = null;
  const fake = new FakeServer();
  const session = new OpencodeAgentSession("app_resume", { createServer: (opts) => { captured = opts; return fake; } });
  session.bindOrchestrator(makeOrchestrator());
  session.ensureProcess(process.cwd(), { agentCommand: "/bin/true", resumeSessionId: "ses_prev123" }, { lazy: true });
  session.sendUserMessage({ text: "continue" });
  await tick();
  assert(captured && captured.resumeSessionID === "ses_prev123", "resumeSessionId -> server resumeSessionID (model context continuity)");
  assert(captured.dataDir && captured.dataDir.endsWith(".db"), "per-session persistent db path passed");
  session.terminate();
}

// --- interrupt aborts + completes -----------------------------------------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "x" });
  await tick();
  session.interrupt();
  assert(fake.aborted === true, "interrupt calls server.abort");
  assert(orch.calls.done.length === 1 && orch.calls.done[0].interrupted === true, "interrupt completes turn as interrupted");
}

console.log("opencode-agent-session: ok");
