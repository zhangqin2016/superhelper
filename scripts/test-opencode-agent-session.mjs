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
  async revert(messageID) { this.reverted = messageID; return {}; }
  async unrevert() { this.unreverted = true; return {}; }
  async checkHealth() { return this.healthy !== false; }
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
  // Must flag user-initiated so the orchestrator classifies it as turn.interrupted,
  // not an engine abort (turn.failed). Without this a user stop was misclassified.
  assert(orch.calls.done[0].interruptedByUser === true, "user interrupt is flagged interruptedByUser");
}

// --- Pillar 3-B: completion gate ------------------------------------------
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { detectIncompleteDeliverable } = require("../src/main/opencode-agent-session.js");

// detector: high precision, fail open
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-detect-"));
  const real = path.join(tmp, "out.docx");
  fs.writeFileSync(real, "PK realish content");
  const empty = path.join(tmp, "empty.pdf");
  fs.writeFileSync(empty, "");
  const missing = path.join(tmp, "nope.pptx");
  assert(detectIncompleteDeliverable(`Saved to ${missing}`)?.reason === "does not exist", "missing deliverable detected");
  assert(detectIncompleteDeliverable(`wrote ${empty} ok`)?.reason === "is empty", "empty deliverable detected");
  assert(detectIncompleteDeliverable(`see ${real}`) === null, "existing deliverable not flagged");
  assert(detectIncompleteDeliverable("all done, no paths") === null, "no false positive without a path");
  assert(detectIncompleteDeliverable("edited src/app.docx") === null, "relative path not flagged");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// gate fires once on a missing deliverable, then settles on the next idle (no loop)
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "make a doc" });
  await tick();
  const missing = path.join(os.tmpdir(), "lily-gate-missing-zzz.docx");
  try { fs.rmSync(missing, { force: true }); } catch { /* ignore */ }
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: `Done. Saved to ${missing}` } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await tick();
  assert(orch.calls.done.length === 0, "gate keeps the turn open instead of settling on a missing deliverable");
  assert(fake.prompts.length === 2 && /Completion check/.test(fake.prompts[1].text), "gate posts exactly one corrective follow-up");
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await tick();
  assert(orch.calls.done.length === 1, "second idle settles the turn — gate is single-shot, never loops");
  session.terminate();
}

// gate does NOT fire when the claimed deliverable actually exists
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-ok-"));
  const real = path.join(tmp, "report.docx");
  fs.writeFileSync(real, "PK realish content");
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "make a doc" });
  await tick();
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: `Created ${real}` } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await tick();
  assert(orch.calls.done.length === 1, "a valid deliverable settles immediately (no gate)");
  assert(fake.prompts.length === 1, "no corrective prompt when the deliverable is valid");
  session.terminate();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- stall watchdog resets on activity (a long-but-active turn must not stall) ---
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const saved = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 100;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "a long agentic task" });
    await tick();
    // Stream stays alive for ~250ms (2.5x the timeout) via periodic events.
    for (let i = 0; i < 10; i++) {
      fake.emitEvent({ type: "message.part.delta", properties: { field: "reasoning", delta: "thinking " } });
      await sleep(25);
    }
    assert(orch.calls.done.length === 0, "active turn (events within the window) must NOT stall past the timeout");
    // Now go silent past the window: the watchdog should fire exactly once.
    await sleep(170);
    assert(orch.calls.done.length === 1, "true silence past the window settles the turn");
    assert(orch.calls.done[0].stalled === true, "the silence settlement is marked stalled");
    session.terminate();
  } finally {
    OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = saved;
  }
}

// --- context continuity: a config change must NOT respawn the server ---------
// The server is reused across turns so every turn POSTs to the same session id
// (that is what threads the conversation). AGENT.md varies per turn, so restarting
// on any config diff broke continuity ("every question treated as new").
{
  let serverCount = 0;
  const made = [];
  const session = new OpencodeAgentSession("ctx_continuity", {
    createServer: () => { serverCount += 1; const s = new FakeServer(); made.push(s); return s; },
  });
  const orch = makeOrchestrator();
  session.bindOrchestrator(orch);

  session.ensureProcess(process.cwd(), { agentCommand: "/bin/true", opencodeConfig: "CONFIG_A" }, { lazy: true });
  session.sendUserMessage({ text: "turn one" });
  await tick();
  assert(serverCount === 1, "first send starts exactly one server");
  made[0].emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  assert(orch.calls.done.length === 1, "turn one completes");

  // Config changes between turns (AGENT.md/digest churn) — must NOT respawn.
  session.ensureProcess(process.cwd(), { agentCommand: "/bin/true", opencodeConfig: "CONFIG_B_DIFFERENT" }, { lazy: true });
  session.sendUserMessage({ text: "turn two" });
  await tick();
  assert(serverCount === 1, "config change does NOT respawn the server (context stays threaded)");
  assert(made[0].prompts.length === 2 && made[0].prompts[1].text === "turn two", "turn two POSTs to the same session");
  session.terminate();
}

// --- rewind: capture the turn's engine message id; pass revert/unrevert through
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "do it" });
  await tick();
  fake.emitEvent({ type: "message.part.delta", properties: { messageID: "msg_anchor", field: "text", delta: "ok" } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  assert(orch.calls.done.length === 1, "rewind: turn completes");
  assert(orch.calls.done[0].engineMessageId === "msg_anchor", "rewind: done payload carries the turn's engine message id (anchor)");
  assert((await session.revert("msg_anchor")) === true, "rewind: revert returns true when server is up");
  assert(fake.reverted === "msg_anchor", "rewind: revert hits the engine with the anchor id");
  await session.unrevert();
  assert(fake.unreverted === true, "rewind: unrevert hits the engine");
  session.terminate();
}

// --- lifecycle: a post-ready engine crash / unreachable must not hang ---------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "go" });
  await tick();
  assert(session.isAlive() === true, "lifecycle: alive after start");
  // Engine becomes unreachable mid-turn (SSE gave up after retries).
  fake.emit("error", new Error("SSE reconnect gave up after 30 attempts"));
  assert(orch.calls.error.length === 1, "lifecycle: unreachable engine FAILS the in-flight turn (no hang)");
  assert(session.isAlive() === false, "lifecycle: server dropped after unreachable error");
}
{
  // isAlive() must reflect a crashed child (non-null exitCode), not just that a
  // process object lingers — otherwise a dead engine reads as alive.
  const { fake, session } = await newSession();
  session.sendUserMessage({ text: "go" });
  await tick();
  assert(session.isAlive() === true, "lifecycle: alive while running");
  fake.process.exitCode = 1; // crashed; exit event not yet delivered
  assert(session.isAlive() === false, "lifecycle: isAlive() false once the child has exited");
  session.terminate(); // clear the in-flight turn's watchdog so the test process exits
}

// --- health probe: a wedged engine (health keeps failing) fails the turn fast --
{
  OpencodeAgentSession.HEALTH_PROBE_MS = 5;
  OpencodeAgentSession.HEALTH_MAX_FAILS = 2;
  const { fake, session, orch } = await newSession();
  fake.healthy = false; // engine alive but health probe fails (wedged/unreachable)
  session.sendUserMessage({ text: "go" });
  await tick();
  await new Promise((r) => setTimeout(r, 40)); // let ~2 probe ticks run
  assert(orch.calls.error.length === 1, "health probe fails the turn when the engine stays unhealthy");
  assert(session.isAlive() === false, "server dropped after repeated health failure");
  session.terminate();
}

console.log("opencode-agent-session: ok");
