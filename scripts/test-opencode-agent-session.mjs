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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitIdleSettle() {
  await sleep(OpencodeAgentSession.IDLE_SETTLE_MS + 10);
}

class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.prompts = [];
    this.permissionReplies = [];
    this.summarizeCalls = [];
    this.aborted = false;
    this.process = { killed: false };
    this.sessionID = null;
    this.idleChecks = [];
    this.idleState = true;
  }
  async start() { return { host: "127.0.0.1", port: 4096 }; }
  async createSession() { this.sessionID = "ses_test"; return this.sessionID; }
  subscribe() { this.subscribed = true; }
  async sendPrompt(p) {
    this.prompts.push(p);
    if (this.failPrompt) {
      if (typeof this.failPrompt === "function") this.failPrompt();
      else throw new Error(this.failPrompt);
    }
  }
  async respondPermission(id, d, opts = {}) { this.permissionReplies.push({ id, sessionID: opts.sessionID || "", ...d }); }
  async respondQuestion(id, answers, opts = {}) {
    this.questionReplies = this.questionReplies || [];
    this.questionReplies.push({ id, sessionID: opts.sessionID || "", answers });
  }
  async summarize(body) { this.summarizeCalls.push(body); return true; }
  async abort() {
    this.aborted = true;
    if (this.abortDelayMs) await sleep(this.abortDelayMs);
    return true;
  }
  async revert(messageID) { this.reverted = messageID; return {}; }
  async unrevert() { this.unreverted = true; return {}; }
  async messages() {
    if (this.historyMessages) {
      return {
        data: this.historyMessages,
        response: { headers: { get: () => null } },
      };
    }
    return {
      data: [{
        info: {
          id: "msg_history_1",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: 1_765_000_000_000, completed: 1_765_000_001_000 },
          tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 1, write: 0 } },
        },
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "answer" },
        ],
      }],
      response: { headers: { get: (name) => (name === "x-next-cursor" ? "older_cursor" : null) } },
    };
  }
  async checkHealth() { return this.healthy !== false; }
  async isSessionIdle() {
    this.idleChecks.push(Date.now());
    return this.idleState !== false;
  }
  diagnostics() {
    return {
      fake: true,
      sessionID: this.sessionID || "",
      prompts: this.prompts.length,
    };
  }
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
  await waitIdleSettle();
  assert(orch.calls.done.length === 1, "session.idle completes the turn exactly once");
  assert(session.isBusy() === false, "session idle after completion");
}

// --- status snapshots must not terminate a turn -----------------------------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "status only" });
  await tick();
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "not done" } });
  fake.emitEvent({ type: "session.status", properties: { status: { type: "idle" }, sessionID: "s" } });
  await waitIdleSettle();
  assert(orch.calls.done.length === 0, "session.status idle does not complete the turn");
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  assert(orch.calls.done.length === 1, "real session.idle completes the turn");
  session.terminate();
}

// --- missed session.idle: authoritative status/history still settles --------
{
  const savedProbe = OpencodeAgentSession.IDLE_STATUS_PROBE_MS;
  const savedSettle = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_STATUS_PROBE_MS = 20;
  OpencodeAgentSession.IDLE_SETTLE_MS = 10;
  try {
    const { fake, session, orch } = await newSession();
    const now = Date.now();
    fake.idleState = false;
    fake.historyMessages = [{
      info: {
        id: "msg_idle_probe_final",
        role: "assistant",
        sessionID: "ses_test",
        time: { created: now, completed: now + 1 },
      },
      parts: [{ type: "text", text: "probe final answer" }],
    }];
    session.sendUserMessage({ text: "finish without idle event" });
    await tick();
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "probe" } });
    await sleep(35);
    assert(orch.calls.done.length === 0, "busy official status keeps the turn open");
    fake.idleState = true;
    await sleep(60);
    assert(orch.calls.done.length === 1, "official idle probe completes without session.idle");
    assert(orch.calls.done[0].output === "probe final answer", "probe completion syncs official final output");
    assert(orch.calls.done[0].engineMessageId === "msg_idle_probe_final", "probe completion preserves official message id");
    assert(fake.idleChecks.length >= 2, "idle probe checked official status repeatedly");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_STATUS_PROBE_MS = savedProbe;
    OpencodeAgentSession.IDLE_SETTLE_MS = savedSettle;
  }
}

// --- v2 Task completion without session.idle still settles via official state
{
  const savedProbe = OpencodeAgentSession.IDLE_STATUS_PROBE_MS;
  const savedSettle = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_STATUS_PROBE_MS = 20;
  OpencodeAgentSession.IDLE_SETTLE_MS = 10;
  try {
    const { fake, session, orch } = await newSession();
    const now = Date.now();
    fake.idleState = false;
    fake.historyMessages = [{
      info: {
        id: "msg_task_probe_final",
        role: "assistant",
        sessionID: "ses_test",
        time: { created: now, completed: now + 1 },
      },
      parts: [{ type: "text", text: "Task result summarized by parent" }],
    }];
    session.sendUserMessage({ text: "use task and finish without idle event" });
    await tick();
    fake.emitEvent({
      type: "session.next.tool.called",
      properties: {
        sessionID: "ses_test",
        assistantMessageID: "msg_task_probe_final",
        callID: "call_task_probe",
        tool: "task",
        input: { description: "Find TODO and FIXME in meeting code" },
        provider: { executed: true },
      },
    });
    fake.emitEvent({
      type: "session.next.tool.success",
      properties: {
        sessionID: "ses_test",
        assistantMessageID: "msg_task_probe_final",
        callID: "call_task_probe",
        structured: {},
        content: [{ type: "text", text: "no TODO/FIXME found" }],
        provider: { executed: true },
      },
    });
    await sleep(35);
    assert(orch.calls.done.length === 0, "busy official status keeps v2 task turn open");
    fake.idleState = true;
    await sleep(60);
    assert(orch.calls.done.length === 1, "v2 task progress triggers idle probe completion without session.idle");
    assert(orch.calls.done[0].output === "Task result summarized by parent", "v2 task idle probe syncs final parent answer");
    assert(draftTypes(orch).includes("tool.started"), "v2 task called is visible to orchestrator");
    assert(draftTypes(orch).includes("tool.done"), "v2 task success is visible to orchestrator");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_STATUS_PROBE_MS = savedProbe;
    OpencodeAgentSession.IDLE_SETTLE_MS = savedSettle;
  }
}

// --- promptAsync transport error: wait for SSE before failing ---------------
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 40;
  try {
    const { fake, session, orch } = await newSession();
    fake.failPrompt = "socket connection was closed";
    session.sendUserMessage({ text: "landed despite transport error" });
    await tick();
    await tick();
    assert(orch.calls.error.length === 0, "dispatch failure is not emitted immediately");
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "hello" } });
    await sleep(60);
    assert(orch.calls.error.length === 0, "SSE activity cancels dispatch failure");
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "hello", "turn completes from SSE after transport error");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- promptAsync transport error: busy engine means the turn landed ----------
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.failPrompt = "socket connection was closed";
    fake.idleState = false;
    session.sendUserMessage({ text: "accepted but response errored" });
    await tick();
    await sleep(60);
    assert(orch.calls.error.length === 0, "busy engine after dispatch failure must not fail the turn");
    fake.failPrompt = null;
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "landed" } });
    fake.idleState = true;
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "landed", "turn completes after late events");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- promptAsync transport retry success still verifies the turn started ----
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    let attempts = 0;
    fake.failPrompt = () => {
      attempts += 1;
      if (attempts === 1) {
        fake.failPrompt = null;
        throw new Error("socket connection was closed");
      }
    };
    session.sendUserMessage({ text: "retry accepted but never started" });
    await tick();
    await sleep(90);
    assert(fake.prompts.length === 2, "dispatch retry submits once");
    assert(orch.calls.error.length === 1, "dispatch retry success without activity still fails fast");
    assert(session.isBusy() === false, "dispatch retry no-activity failure clears busy state");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- promptAsync transport error: any owned engine event means landed --------
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.failPrompt = "socket connection was closed";
    session.sendUserMessage({ text: "status event proves landed" });
    await tick();
    fake.emitEvent({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } });
    await sleep(60);
    assert(orch.calls.error.length === 0, "owned engine event cancels dispatch failure");
    assert(fake.prompts.length === 1, "landed prompt must not be submitted twice");
    fake.failPrompt = null;
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "event landed" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "event landed", "turn continues after status-only proof");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- promptAsync transport error after owned event must not schedule failure -
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.failPrompt = () => {
      fake.emitEvent({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } });
      throw new Error("socket connection was closed");
    };
    session.sendUserMessage({ text: "cold first turn" });
    await tick();
    await sleep(60);
    assert(orch.calls.error.length === 0, "owned event before promptAsync rejection must not become a visible failure");
    assert(fake.prompts.length === 1, "accepted prompt must not be retried after owned event");
    fake.failPrompt = null;
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "cold turn ok" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "cold turn ok", "cold turn continues after promptAsync transport error");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- cold-start server hiccup after owned event: recover from official history
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 200;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "cold start" });
    await tick();
    fake.emitEvent({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } });
    const now = Date.now();
    fake.historyMessages = [
      {
        info: {
          id: "msg_user_after_hiccup",
          role: "user",
          sessionID: "ses_test",
          time: { created: now },
        },
        parts: [{ type: "text", text: "cold start" }],
      },
      {
        info: {
          id: "msg_recovered_after_hiccup",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now + 1, completed: now + 2 },
        },
        parts: [{ type: "text", text: "recovered answer" }],
      },
    ];
    fake.emit("error", new Error("SSE reconnect gave up after socket connection was closed"));
    assert(orch.calls.error.length === 0, "landed server hiccup is not shown as a visible failure");
    assert(session.isAlive() === true, "landed server hiccup keeps the official serve alive for recovery");
    await sleep(60);
    assert(orch.calls.error.length === 0, "recovery avoids user-visible model interruption");
    assert(orch.calls.done.length === 1, "recovery completes the turn from official history");
    assert(orch.calls.done[0].output === "recovered answer", "recovered answer is preserved");
    assert(orch.calls.done[0].engineMessageId === "msg_recovered_after_hiccup", "recovered engine message id is preserved");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
  }
}

// --- transient hiccup with no result: replay once when official session idle -
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 200;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    fake.idleState = true;
    session.sendUserMessage({ text: "plain question" });
    await tick();
    fake.emitEvent({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } });
    fake.emit("error", new Error("SSE reconnect gave up after socket connection was closed"));
    await sleep(60);
    assert(fake.prompts.length === 2, "idle transient hiccup without output is replayed once");
    assert(orch.calls.error.length === 0, "safe replay avoids a visible model interruption");
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "replayed answer" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "replayed answer", "replayed turn completes");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
  }
}

// --- transient hiccup after tool activity: do not replay side effects -------
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 10;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 30;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    fake.idleState = true;
    session.sendUserMessage({ text: "run a command" });
    await tick();
    fake.emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_tool_1",
          type: "tool",
          tool: "bash",
          callID: "call_tool_1",
          state: { status: "running", input: { command: "echo ok" } },
        },
      },
    });
    fake.emit("error", new Error("SSE reconnect gave up after socket connection was closed"));
    await sleep(140);
    assert(fake.prompts.length === 1, "transient failure after tool activity must not replay the prompt");
    assert(orch.calls.error.length === 1, "unsafe replay still surfaces the failure");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
  }
}

// --- transient hiccup after read-only tools: replay once --------------------
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 200;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    fake.idleState = true;
    session.sendUserMessage({ text: "inspect files" });
    await tick();
    fake.emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_read_1",
          type: "tool",
          tool: "read",
          callID: "call_read_1",
          state: { status: "running", input: { file_path: "/repo/a.md" } },
        },
      },
    });
    fake.emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_read_1",
          type: "tool",
          tool: "read",
          callID: "call_read_1",
          state: { status: "completed", output: "hello", input: { file_path: "/repo/a.md" } },
        },
      },
    });
    fake.emit("error", new Error("SSE reconnect gave up after socket connection was closed"));
    await sleep(60);
    assert(fake.prompts.length === 2, "transient failure after read-only tool activity is replayed once");
    assert(orch.calls.error.length === 0, "safe read-only replay avoids a visible model interruption");
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "replayed file answer" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "replayed file answer", "read-only replay completes");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
  }
}

// --- promptAsync transport error: catalog noise does not prove prompt landed -
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    let failures = 0;
    fake.failPrompt = () => {
      failures += 1;
      if (failures === 1) throw new Error("socket connection was closed");
      fake.idleState = false;
    };
    session.sendUserMessage({ text: "ignore catalog noise" });
    await tick();
    fake.emitEvent({ type: "catalog.updated", properties: { source: "background" } });
    await sleep(60);
    assert(fake.prompts.length === 2, "global catalog events must not cancel the dispatch retry");
    assert(orch.calls.error.length === 0, "retry path avoids a visible failure while retry is pending");
    fake.failPrompt = null;
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "retried after noise" } });
    fake.idleState = true;
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "retried after noise", "turn completes after real owned event");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- promptAsync transport error: if not landed, retry submit once -----------
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    let failures = 0;
    fake.failPrompt = () => {
      failures += 1;
      if (failures === 1) throw new Error("fetch failed");
      fake.idleState = false;
    };
    session.sendUserMessage({ text: "retry submit" });
    await tick();
    await sleep(60);
    assert(fake.prompts.length === 2, "failed promptAsync is retried once when no engine activity appears");
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "retried ok" } });
    fake.idleState = true;
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.error.length === 0, "retry success avoids user-visible dispatch error");
    assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "retried ok", "retried turn completes");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- promptAsync success but no engine activity: verify prompt really started -
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    session.sendUserMessage({ text: "accepted but never started" });
    await tick();
    await sleep(70);
    assert(fake.prompts.length === 2, "promptAsync success with no activity retries once");
    assert(fake.idleChecks.length >= 2, "acceptance watchdog checks official session status");
    assert(orch.calls.error.length === 1, "no activity after retry fails fast instead of hanging at starting");
    assert(session.isBusy() === false, "no-activity failure clears busy state");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    fake.idleState = false;
    session.sendUserMessage({ text: "quiet but officially busy" });
    await tick();
    await sleep(60);
    assert(fake.prompts.length === 1, "officially busy prompt is not replayed just because it is quiet");
    assert(orch.calls.error.length === 0, "officially busy prompt is not failed by acceptance watchdog");
    assert(session.isBusy() === true, "officially busy prompt remains in flight");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    const old = Date.now() - 1_000;
    fake.historyMessages = [{
      info: {
        id: "msg_previous_answer",
        role: "assistant",
        sessionID: "ses_test",
        time: { created: old, completed: old + 1 },
      },
      parts: [{ type: "text", text: "previous answer must not leak" }],
    }];
    session.sendUserMessage({ text: "accepted but history is stale" });
    await tick();
    await sleep(70);
    assert(fake.prompts.length === 2, "stale official history is not treated as this turn's answer");
    assert(orch.calls.done.length === 0, "stale official answer must not complete this turn");
    assert(orch.calls.error.length === 1, "stale official history still fails fast after one retry");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    const now = Date.now();
    fake.historyMessages = [
      {
        info: {
          id: "msg_acceptance_user",
          role: "user",
          sessionID: "ses_test",
          time: { created: now },
        },
        parts: [{ type: "text", text: "accepted and completed without SSE" }],
      },
      {
        info: {
          id: "msg_acceptance_recovered",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now + 1, completed: now + 2 },
        },
        parts: [{ type: "text", text: "official answer despite missing SSE" }],
      },
    ];
    session.sendUserMessage({ text: "accepted and completed without SSE" });
    await tick();
    await sleep(50);
    assert(fake.prompts.length === 1, "official final recovery does not replay a completed prompt");
    assert(orch.calls.error.length === 0, "official final recovery avoids a visible failure");
    assert(orch.calls.done.length === 1, "official final recovery completes the turn");
    assert(orch.calls.done[0].output === "official answer despite missing SSE", "official recovered answer is used");
    assert(orch.calls.done[0].recoveredFromPromptAcceptance === true, "recovery source is recorded");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- idle settle grace: late deltas behind idle must not be truncated --------
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 25;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "finish cleanly" });
    await tick();
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "hello " } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    assert(orch.calls.done.length === 0, "idle does not finalize on the same tick");
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "world" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1, "idle settles after the drain window");
    assert(orch.calls.done[0].output === "hello world", `late delta preserved: ${orch.calls.done[0].output}`);
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- official messages are the final output source after idle ---------------
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "sync final answer" });
    await tick();
    const now = Date.now();
    fake.historyMessages = [{
      info: {
        id: "msg_official_final",
        role: "assistant",
        sessionID: "ses_test",
        time: { created: now, completed: now + 1 },
      },
      parts: [{ type: "text", text: "partial plus official tail" }],
    }];
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "partial" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    const textDeltas = orch.calls.ingest
      .filter((item) => item.type === "assistant.delta")
      .map((item) => item.payload.text)
      .join("");
    assert(textDeltas === "partial plus official tail", `missing official tail was emitted to UI: ${textDeltas}`);
    assert(orch.calls.done.length === 1, "turn completes after official final sync");
    assert(orch.calls.done[0].output === "partial plus official tail", "official message text is final output");
    assert(orch.calls.done[0].engineMessageId === "msg_official_final", "official message id becomes turn anchor");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- idle confirmation: status busy delays completion like official client ---
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "wait for true idle" });
    await tick();
    fake.idleState = false;
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "still running" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await sleep(60);
    assert(orch.calls.done.length === 0, "busy session.status delays idle completion");
    assert(fake.idleChecks.length >= 1, "idle confirmation checked session status");
    fake.idleState = true;
    await waitIdleSettle();
    assert(orch.calls.done.length === 1, "turn completes after session.status becomes idle");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- missed idle fallback must be delayed, not a 0ms status busy-poll ----------
{
  const savedProbe = OpencodeAgentSession.IDLE_STATUS_PROBE_MS;
  const savedSettle = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_STATUS_PROBE_MS = 80;
  OpencodeAgentSession.IDLE_SETTLE_MS = 10;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "recover missed idle" });
    await tick();
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "answer" } });
    await sleep(30);
    assert(fake.idleChecks.length === 0, "idle probe waits for its configured delay before polling status");
    await sleep(80);
    assert(fake.idleChecks.length >= 1, "idle probe eventually checks official session status");
    await waitIdleSettle();
    assert(orch.calls.done.length === 1, "idle probe completes a turn when session.idle was missed");
    assert(orch.calls.done[0].completedByIdleProbe === true, "completion records idle-probe recovery");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_STATUS_PROBE_MS = savedProbe;
    OpencodeAgentSession.IDLE_SETTLE_MS = savedSettle;
  }
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

// --- diagnostics: runner exposes per-session engine state without payload text
{
  const { session, fake } = await newSession();
  const cold = session.diagnostics();
  assert(cold.sessionId === "app_session_1", "diagnostics carries app session id");
  assert(cold.busy === false && cold.server === null, "cold diagnostics has no server before lazy start");
  session.sendUserMessage({ text: "diagnose me" });
  await tick();
  const live = session.diagnostics();
  assert(live.alive === true && live.busy === true, "live diagnostics reflects runner state");
  assert(live.server?.fake === true && live.server.sessionID === "ses_test", "live diagnostics includes server snapshot");
  assert(live.server.prompts === fake.prompts.length, "server diagnostics is current");
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
    properties: { id: "per_1", permission: "bash", metadata: { command: "rm -rf x" }, tool: { callID: "c9" } },
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
  fake.emitEvent({
    type: "permission.asked",
    properties: { id: "per_2", permission: "bash", metadata: { command: "rm -rf x" }, tool: {} },
  });
  session.respondPermission("per_2", { allow: false });
  await tick();
  assert(fake.permissionReplies[0].reply === "reject", "deny maps to reply=reject");
  session.terminate();
}

// --- workspace grounding surfaces unsafe new top-level writes in ASK mode ----
// The grounding gate is a confirm-first SAFETY check for the balanced default;
// it must still surface a new-top-level write so "ask" mode can confirm it.
{
  const { fake, session, orch } = await newSession();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-opencode-grounding-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  session.cwd = tmp;
  session.spawnOptions.permissionMode = "ask";
  session.sendUserMessage({
    text: "improve existing code",
    taskContract: {
      projectPath: tmp,
      workspaceGroundingPolicy: {
        required: true,
        allowNewTopLevel: false,
      },
    },
  });
  await tick();
  fake.emitEvent({
    type: "permission.asked",
    properties: { id: "per_ground_1", permission: "write", metadata: { path: "new-app/index.js" }, tool: {} },
  });
  assert(draft(orch, "permission.requested")?.payload.requestId === "per_ground_1",
    "new top-level write surfaces for confirmation in ask mode");
  assert(fake.permissionReplies.length === 0, "grounding ask must not auto-allow");
  session.terminate();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- full mode is FULL: the grounding gate is skipped, only disasters confirm -
// User-confirmed contract: in full mode the same new-top-level write that "ask"
// confirms above runs WITHOUT a prompt; only catastrophic shell still surfaces.
{
  const { fake, session, orch } = await newSession();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-opencode-grounding-full-"));
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  session.cwd = tmp;
  session.spawnOptions.permissionMode = "full";
  session.sendUserMessage({
    text: "improve existing code",
    taskContract: {
      projectPath: tmp,
      workspaceGroundingPolicy: { required: true, allowNewTopLevel: false },
    },
  });
  await tick();
  fake.emitEvent({
    type: "permission.asked",
    properties: { id: "per_ground_full", permission: "write", metadata: { path: "new-app/index.js" }, tool: {} },
  });
  await tick();
  assert(fake.permissionReplies[0]?.reply === "once",
    "full mode auto-allows a grounded new top-level write (gate skipped — full means full)");
  // ...but a catastrophic command still surfaces even in full mode.
  fake.emitEvent({
    type: "permission.asked",
    properties: { id: "per_catastrophe", permission: "bash", metadata: { command: "rm -rf /" }, tool: {} },
  });
  assert(draft(orch, "permission.requested")?.payload.requestId === "per_catastrophe",
    "catastrophic shell still confirms in full mode (irreversible-disaster backstop)");
  session.terminate();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- explicit greenfield can create a new top-level target ------------------
{
  const { fake, session } = await newSession();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-opencode-greenfield-"));
  session.cwd = tmp;
  session.spawnOptions.permissionMode = "full";
  session.sendUserMessage({
    text: "create from scratch",
    taskContract: {
      projectPath: tmp,
      workspaceGroundingPolicy: {
        required: true,
        allowNewTopLevel: true,
      },
    },
  });
  await tick();
  fake.emitEvent({
    type: "permission.asked",
    properties: { id: "per_ground_2", permission: "write", metadata: { path: "new-app/index.js" }, tool: {} },
  });
  await tick();
  assert(fake.permissionReplies[0]?.reply === "once", "greenfield write should auto-allow in full mode");
  session.terminate();
  fs.rmSync(tmp, { recursive: true, force: true });
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

// --- subagent permission/question round trip -------------------------------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "delegate" });
  await tick();
  fake.emitEvent({
    __lilySubagentSessionID: "child_1",
    type: "permission.asked",
    properties: {
      id: "per_child",
      permission: "bash",
      metadata: { command: "rm -rf child" },
      tool: { callID: "child_call" },
    },
  });
  const req = orch.calls.ingest.find((d) => (
    d.type === "permission.requested" &&
    d.payload?.requestId === "subagent:child_1:per_child"
  ));
  assert(req, "subagent permission is surfaced as a parent-visible prompt");
  assert(req.payload.subagent?.sessionId === "child_1", "subagent permission carries child session id");
  assert(session.respondPermission("subagent:child_1:per_child", { allow: true }) === true,
    "subagent permission response accepted");
  await tick();
  assert(fake.permissionReplies.at(-1)?.id === "per_child", "subagent permission replies with raw request id");
  assert(fake.permissionReplies.at(-1)?.sessionID === "child_1", "subagent permission reply targets child session");

  fake.emitEvent({
    __lilySubagentSessionID: "child_1",
    type: "question.asked",
    properties: {
      id: "que_child",
      questions: [{ question: "Mode?", header: "Mode", options: [{ label: "Fast" }], multiple: false }],
      tool: { callID: "child_question" },
    },
  });
  const q = orch.calls.ingest.find((d) => (
    d.type === "user_question.requested" &&
    d.payload?.requestId === "subagent:child_1:que_child"
  ));
  assert(q, "subagent question is surfaced as a parent-visible prompt");
  assert(session.respondUserQuestion("subagent:child_1:que_child", { answers: { Mode: "Fast" } }) === true,
    "subagent question response accepted");
  await tick();
  assert(fake.questionReplies.at(-1)?.id === "que_child", "subagent question replies with raw request id");
  assert(fake.questionReplies.at(-1)?.answers?.[0]?.[0] === "Fast", "subagent question answer is coerced");
  session.terminate();
}

// --- engine error fails the turn ------------------------------------------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "x" });
  await tick();
  fake.emitEvent({ type: "message.error", properties: { error: { message: "model exploded" } } });
  await tick();
  assert(orch.calls.error.length === 1, "message.error triggers notifyRunnerError");
  assert(fake.aborted === false, "message.error is already terminal and must not issue a second abort");
  assert(session.isBusy() === false, "session idle after failure");
}

// --- promptAsync dispatch does not pre-poll status -------------------------
{
  const { fake, session } = await newSession();
  fake.idleState = false;
  session.sendUserMessage({ text: "post through promptAsync immediately" });
  await tick();
  assert(fake.prompts.length === 1, "promptAsync is posted immediately; SSE/session.idle owns completion");
  assert(fake.prompts[0].text === "post through promptAsync immediately", "prompt text is preserved");
  session.terminate();
}

// --- Lily guidance must be present on every turn, including resumed sessions -
{
  const { fake, session, orch } = await newSession();
  session.ensureProcess(process.cwd(), { agentCommand: "/bin/true", guidance: "LILY_RULES_V1" }, { lazy: true });
  session.sendUserMessage({ text: "turn one" });
  await tick();
  assert(fake.prompts[0].guidance === "LILY_RULES_V1", "turn one carries Lily guidance");
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  assert(orch.calls.done.length === 1, "turn one completes before turn two");

  session.ensureProcess(process.cwd(), { agentCommand: "/bin/true", guidance: "LILY_RULES_V2" }, { lazy: true });
  session.sendUserMessage({ text: "turn two" });
  await tick();
  assert(fake.prompts[1].guidance === "LILY_RULES_V2", "turn two carries the latest Lily guidance");
  session.terminate();
}
{
  let captured = null;
  const fake = new FakeServer();
  fake.wasResumed = true;
  const session = new OpencodeAgentSession("app_resume_guidance", { createServer: (opts) => { captured = opts; return fake; } });
  session.bindOrchestrator(makeOrchestrator());
  session.ensureProcess(process.cwd(), {
    agentCommand: "/bin/true",
    resumeSessionId: "ses_prev_guidance",
    guidance: "CURRENT_LILY_RULES",
  }, { lazy: true });
  session.sendUserMessage({ text: "continue with current rules" });
  await tick();
  assert(captured.resumeSessionID === "ses_prev_guidance", "resume still flows to OpenCode");
  assert(fake.prompts[0].guidance === "CURRENT_LILY_RULES", "resumed sessions still receive current Lily guidance");
  session.terminate();
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

// --- conversation history reads from official session.messages -------------
{
  const { session } = await newSession();
  const page = await session.getConversationPage({ limit: 1 });
  assert(page.source === "opencode", "history page is OpenCode-backed");
  assert(page.hasMore === true && page.nextBefore === "older_cursor", "history cursor preserved");
  assert(page.conversation.length === 1, "history message adapted");
  const message = page.conversation[0];
  assert(message.id === "msg_history_1", "OpenCode message id is canonical");
  assert(message.content === "answer", "assistant text adapted");
  assert(message.record.thinkingText === "thinking", "reasoning text adapted");
  assert(message.record.usage.output_tokens === 5, "reasoning tokens included in output usage");
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

// --- interrupt keeps runner busy until official abort settles ---------------
{
  const { fake, session } = await newSession();
  fake.abortDelayMs = 30;
  session.sendUserMessage({ text: "x" });
  await tick();
  session.interrupt();
  assert(fake.aborted === true, "interrupt starts official abort");
  assert(session.isBusy() === true, "session remains busy while abort is settling");
  await sleep(45);
  assert(session.isBusy() === false, "session becomes idle after official abort settles");
}

// --- interrupt abort timeout drops the server instead of wedging forever -----
{
  const previousAbortTimeout = OpencodeAgentSession.INTERRUPT_ABORT_TIMEOUT_MS;
  OpencodeAgentSession.INTERRUPT_ABORT_TIMEOUT_MS = 10;
  try {
    const { fake, session } = await newSession();
    fake.abortDelayMs = 80;
    session.sendUserMessage({ text: "x" });
    await tick();
    session.interrupt();
    assert(session.isBusy() === true, "session remains busy while abort timeout is pending");
    await sleep(30);
    assert(session.isBusy() === false, "abort timeout releases busy state");
    assert(fake.process === null, "abort timeout terminates the stale server view");
  } finally {
    OpencodeAgentSession.INTERRUPT_ABORT_TIMEOUT_MS = previousAbortTimeout;
  }
}

// --- Pillar 3-B: completion gate ------------------------------------------
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
  await waitIdleSettle();
  await tick();
  assert(orch.calls.done.length === 0, "gate keeps the turn open instead of settling on a missing deliverable");
  assert(fake.prompts.length === 2 && /Completion check/.test(fake.prompts[1].text), "gate posts exactly one corrective follow-up");
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
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
  await waitIdleSettle();
  await tick();
  assert(orch.calls.done.length === 1, "a valid deliverable settles immediately (no gate)");
  assert(fake.prompts.length === 1, "no corrective prompt when the deliverable is valid");
  session.terminate();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- stall watchdog resets on activity (a long-but-active turn must not stall) ---
{
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

// --- visible no-progress notice: quiet turns must not look frozen -----------
{
  const savedNotice = OpencodeAgentSession.PROGRESS_NOTICE_MS;
  const savedTimeout = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  OpencodeAgentSession.PROGRESS_NOTICE_MS = 25;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 500;
  try {
    const { session, orch } = await newSession();
    session.sendUserMessage({ text: "quiet but still running" });
    await tick();
    await new Promise((r) => setTimeout(r, 60));
    const notice = orch.calls.ingest.find((d) => d.type === "engine.notice" && d.payload?.notice?.code === "longWait");
    assert(notice, "quiet in-flight turn emits a visible longWait progress notice");
    assert(notice.payload.notice.level === "progress", "longWait is a progress notice");
    assert(notice.payload.notice.replace === true, "longWait notice is replaceable, not stack-building");
    assert(orch.calls.done.length === 0, "visible progress notice does not settle the turn");
    session.terminate();
  } finally {
    OpencodeAgentSession.PROGRESS_NOTICE_MS = savedNotice;
    OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = savedTimeout;
  }
}

// --- subagent progress suppresses duplicate generic long-wait notice --------
{
  const savedNotice = OpencodeAgentSession.PROGRESS_NOTICE_MS;
  const savedTimeout = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  OpencodeAgentSession.PROGRESS_NOTICE_MS = 25;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 500;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "delegate quietly" });
    await tick();
    fake.emitEvent({
      __lilySubagentSessionID: "child_slow",
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "read",
          callID: "child_read",
          state: { status: "running", input: { file_path: "src/a.js" } },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    const notice = orch.calls.ingest.find((d) => d.type === "engine.notice" && d.payload?.notice?.code === "longWait");
    assert(!notice, "active subagent progress suppresses duplicate generic longWait notice");
    assert(orch.calls.ingest.some((d) => d.type === "subagent.event"), "subagent progress remains visible");
    session.terminate();
  } finally {
    OpencodeAgentSession.PROGRESS_NOTICE_MS = savedNotice;
    OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = savedTimeout;
  }
}

// --- platform tool progress: long-running tools stay visible generically -----
{
  const savedNotice = OpencodeAgentSession.PROGRESS_NOTICE_MS;
  const savedTimeout = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  OpencodeAgentSession.PROGRESS_NOTICE_MS = 25;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 500;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "run a long command" });
    await tick();
    fake.emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "long_bash",
          state: {
            status: "running",
            input: { command: "python3 slow-scan.py --max-pages 80" },
          },
        },
      },
    });
    await sleep(70);
    const toolNotice = orch.calls.ingest.find((d) => d.type === "engine.notice" && d.payload?.notice?.code === "toolProgress");
    assert(toolNotice, "active tool emits generic visible tool progress");
    assert(String(toolNotice.payload.notice.detail || "").includes("Bash python3 slow-scan.py"), "generic tool progress includes the running tool preview");
    const longWait = orch.calls.ingest.find((d) => d.type === "engine.notice" && d.payload?.notice?.code === "longWait");
    assert(!longWait, "active tool progress replaces generic longWait");
    assert(orch.calls.done.length === 0, "visible tool progress does not settle the turn");
    session.terminate();
  } finally {
    OpencodeAgentSession.PROGRESS_NOTICE_MS = savedNotice;
    OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = savedTimeout;
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
  await waitIdleSettle();
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
  await waitIdleSettle();
  assert(orch.calls.done.length === 1, "rewind: turn completes");
  assert(orch.calls.done[0].engineMessageId === "msg_anchor", "rewind: done payload carries the turn's engine message id (anchor)");
  assert((await session.revert("msg_anchor")) === true, "rewind: revert returns true when server is up");
  assert(fake.reverted === "msg_anchor", "rewind: revert hits the engine with the anchor id");
  await session.unrevert();
  assert(fake.unreverted === true, "rewind: unrevert hits the engine");
  session.terminate();
}

// --- native compaction: expose OpenCode summarize only when idle -------------
{
  const { fake, session } = await newSession();
  assert(await session.compactContext({ providerID: "lily", modelID: "deepseek-chat", auto: true }) === false,
    "compaction before startup is a no-op");
  session.sendUserMessage({ text: "seed session" });
  await tick();
  assert(await session.compactContext({ providerID: "lily", modelID: "deepseek-chat", auto: true }) === false,
    "busy turn must not be interrupted by background compaction");
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  assert(await session.compactContext({ providerID: "lily", modelID: "deepseek-chat", auto: true }) === true,
    "idle runner passes native compaction through");
  assert(
    JSON.stringify(fake.summarizeCalls) === JSON.stringify([{ providerID: "lily", modelID: "deepseek-chat", auto: true }]),
    "native compaction uses the requested model/body",
  );
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

// --- no-progress: busy heartbeats (no actions) still force-end the turn --------
// A turn pinging "busy" but doing nothing is caught even though events keep
// arriving — the case a reset-on-every-event watchdog would miss, and without a
// blunt wall-clock cap that would kill a legit long-but-progressing task.
{
  const saved = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  const savedSync = OpencodeAgentSession.STALLED_HISTORY_SYNC_MS;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 60;
  OpencodeAgentSession.STALLED_HISTORY_SYNC_MS = 5;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    session.sendUserMessage({ text: "stuck but noisy" });
    await tick();
    for (let i = 0; i < 6; i++) {
      fake.emitEvent({ type: "session.status", properties: { status: { type: "busy" } } });
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(orch.calls.done.length === 1, "busy-only heartbeats (no progress) force-end the turn");
    assert(orch.calls.done[0].stalled === true, "no-progress force-end is marked stalled");
    assert(fake.aborted === true, "force-end aborts the engine");
    session.terminate();
  } finally {
    OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = saved;
    OpencodeAgentSession.STALLED_HISTORY_SYNC_MS = savedSync;
  }
}

// --- no-progress: recover final answer from official messages before stalling -
{
  const savedTimeout = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  const savedSync = OpencodeAgentSession.STALLED_HISTORY_SYNC_MS;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 40;
  OpencodeAgentSession.STALLED_HISTORY_SYNC_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "official final already exists" });
    await tick();
    const now = Date.now();
    fake.historyMessages = [
      {
        info: {
          id: "msg_user_stall_recovered",
          role: "user",
          sessionID: "ses_test",
          time: { created: now },
        },
        parts: [{ type: "text", text: "official final already exists" }],
      },
      {
        info: {
          id: "msg_stall_recovered",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now + 1, completed: now + 2 },
        },
        parts: [{ type: "text", text: "official recovered answer" }],
      },
    ];
    await sleep(80);
    assert(orch.calls.done.length === 1, "watchdog checks official messages before declaring stalled");
    assert(orch.calls.done[0].stalled !== true, "official final recovery is not marked stalled");
    assert(orch.calls.done[0].recoveredFromStall === true, "done payload records stall recovery");
    assert(orch.calls.done[0].output === "official recovered answer", "official final text wins");
    assert(orch.calls.done[0].engineMessageId === "msg_stall_recovered", "official recovered message id is preserved");
    assert(fake.aborted === false, "recovered official final must not abort the engine");
    session.terminate();
  } finally {
    OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = savedTimeout;
    OpencodeAgentSession.STALLED_HISTORY_SYNC_MS = savedSync;
  }
}

// --- no-progress: do not treat an in-progress official message as final ------
{
  const savedTimeout = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  const savedSync = OpencodeAgentSession.STALLED_HISTORY_SYNC_MS;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 40;
  OpencodeAgentSession.STALLED_HISTORY_SYNC_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.idleState = false;
    session.sendUserMessage({ text: "official still busy" });
    await tick();
    const now = Date.now();
    fake.historyMessages = [{
      info: {
        id: "msg_still_running",
        role: "assistant",
        sessionID: "ses_test",
        time: { created: now },
      },
      parts: [{ type: "text", text: "partial official text" }],
    }];
    await sleep(90);
    assert(orch.calls.done.length === 1, "busy official partial still settles by watchdog");
    assert(orch.calls.done[0].stalled === true, "busy official partial remains stalled");
    assert(fake.aborted === true, "unrecovered stalled turn aborts the engine");
    session.terminate();
  } finally {
    OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = savedTimeout;
    OpencodeAgentSession.STALLED_HISTORY_SYNC_MS = savedSync;
  }
}

console.log("opencode-agent-session: ok");
