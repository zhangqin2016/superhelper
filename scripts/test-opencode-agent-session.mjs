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
const { OpencodeAgentSession, runWithTimeout, compactionTimeoutMs } = require("../src/main/opencode-agent-session.js");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
assert(
  OpencodeAgentSession.ACTIVE_TOOL_LEASE_MS >= OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS,
  "default active tool lease must not be shorter than the no-progress watchdog",
);
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(message);
}
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
    this.lastPromptText = "";
    this.promptTextBuilder = null;
  }
  async start() { return { host: "127.0.0.1", port: 4096 }; }
  async createSession() { this.sessionID = "ses_test"; return this.sessionID; }
  subscribe() { this.subscribed = true; }
  async sendPrompt(p) {
    const outboundText = typeof this.promptTextBuilder === "function"
      ? this.promptTextBuilder(p)
      : p?.text;
    this.lastPromptText = String(outboundText || "");
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

// --- unfinished native todos must not falsely complete a turn ---------------
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({ text: "fix all issues" });
  await tick();
  fake.emitEvent({
    type: "todo.updated",
    properties: {
      sessionID: "s",
      todos: [
        { content: "Read code", status: "completed" },
        { content: "Fix P0 bug", status: "in_progress" },
        { content: "Verify in browser", status: "pending" },
      ],
    },
  });
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "Starting the fixes." } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  await tick();
  assert(orch.calls.done.length === 0, "idle with unfinished todos keeps the turn open");
  assert(fake.prompts.length === 2, "unfinished todo gate sends one internal continuation prompt");
  assert(/unfinished todo/i.test(fake.prompts[1].text), "continuation prompt names unfinished todos");
  assert(/Continuation attempt: 1\/3/.test(fake.prompts[1].text), "unfinished todo gate must be bounded");

  fake.emitEvent({
    type: "todo.updated",
    properties: {
      sessionID: "s",
      todos: [
        { content: "Read code", status: "completed" },
        { content: "Fix P0 bug", status: "completed" },
        { content: "Verify in browser", status: "completed" },
      ],
    },
  });
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: " Done and verified." } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  await tick();
  assert(orch.calls.done.length === 1, "idle settles once todos are completed");
  assert(/Done and verified/.test(orch.calls.done[0].output), "final output is preserved after todo continuation");
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
    const now = Date.now() + 1_000;
    fake.idleState = false;
    fake.historyMessages = [
      {
        info: {
          id: "msg_idle_probe_user",
          role: "user",
          sessionID: "ses_test",
          time: { created: now },
        },
        parts: [{ type: "text", text: "finish without idle event" }],
      },
      {
        info: {
          id: "msg_idle_probe_final",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now + 1, completed: now + 2 },
        },
        parts: [{ type: "text", text: "probe final answer" }],
      },
    ];
    session.sendUserMessage({ text: "finish without idle event" });
    await tick();
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "probe" } });
    await sleep(35);
    assert(orch.calls.done.length === 0, "busy official status keeps the turn open");
    fake.idleState = true;
    await waitFor(() => orch.calls.done.length === 1, "official idle probe completes without session.idle", 200);
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
    const now = Date.now() + 1_000;
    fake.idleState = false;
    fake.historyMessages = [
      {
        info: {
          id: "msg_task_probe_user",
          role: "user",
          sessionID: "ses_test",
          time: { created: now },
        },
        parts: [{ type: "text", text: "use task and finish without idle event" }],
      },
      {
        info: {
          id: "msg_task_probe_final",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now + 1, completed: now + 2 },
        },
        parts: [{ type: "text", text: "Task result summarized by parent" }],
      },
    ];
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
    await waitFor(() => orch.calls.done.length === 1, "v2 task progress triggers idle probe completion without session.idle", 200);
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

// --- promptAsync transport error: unknown status still takes bounded retry --
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.idleState = false; // legacy boolean path would incorrectly call this busy
    fake.getSessionStatus = async () => "unknown";
    let attempts = 0;
    fake.failPrompt = () => {
      attempts += 1;
      if (attempts === 1) {
        fake.failPrompt = null;
        throw new Error("socket connection was closed");
      }
    };
    session.sendUserMessage({ text: "retry when official status is unknown" });
    await tick();
    await waitFor(
      () => fake.prompts.length === 2,
      "unknown status after dispatch failure must reach the existing bounded retry",
      160,
    );
    const accepted = orch.calls.ingest.filter((item) => item.type === "turn.accepted");
    assert(accepted.length === 1, "bounded retry emits one acceptance transition");
    assert(accepted[0].payload.source === "dispatch_retry_returned", "unknown status itself is not treated as busy acceptance proof");
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

// --- cold promptAsync can stay pending while official status proves it landed
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    let releasePrompt = null;
    fake.sendPrompt = async (p) => {
      fake.prompts.push(p);
      await new Promise((resolve) => {
        releasePrompt = resolve;
      });
    };
    fake.idleState = false;
    session.sendUserMessage({ text: "cold pending prompt" });
    await tick();
    await sleep(60);
    assert(fake.prompts.length === 1, "pending prompt must not be replayed while the original request may still land");
    assert(fake.idleChecks.length >= 1, "pending prompt checks official session status");
    assert(draftTypes(orch).filter((t) => t === "turn.accepted").length === 1, "official busy status moves UI out of starting");
    assert(orch.calls.error.length === 0, "officially busy pending prompt is not failed");
    releasePrompt?.();
    await tick();
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "pending landed" } });
    fake.idleState = true;
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "pending landed", "pending prompt completes through normal SSE");
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

// --- prompt dispatch oversized context: retry in a fresh engine session -----
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const made = [];
    const session = new OpencodeAgentSession("dispatch_context_limit", {
      createServer: () => {
        const server = new FakeServer();
        server.historyMessages = [];
        if (made.length === 0) server.failPrompt = "Request failed: Request Entity Too Large";
        made.push(server);
        return server;
      },
    });
    const orch = makeOrchestrator();
    session.bindOrchestrator(orch);
    session.ensureProcess(process.cwd(), { agentCommand: "/bin/true" }, { lazy: true });
    session.sendUserMessage({ text: "发起一个很大的请求" });
    await tick();
    assert(made.length === 1, "oversized dispatch starts on the original engine session");
    for (let i = 0; i < 10 && made.length < 2; i += 1) await sleep(10);
    assert(made.length === 2, "oversized dispatch is retried in a fresh engine session");
    assert(made[0].aborted === true, "oversized dispatch aborts the bloated engine session");
    assert(made[1].prompts.length === 1 && made[1].prompts[0].text === "发起一个很大的请求", "fresh dispatch retry preserves the user request");
    made[1].emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "新会话继续。" } });
    made[1].emitEvent({ type: "session.idle", properties: { sessionID: "ses_test" } });
    await waitIdleSettle();
    assert(orch.calls.error.length === 0, "oversized dispatch retry is hidden from the user");
    assert(orch.calls.done.length === 1 && /新会话/.test(orch.calls.done[0].output), "fresh dispatch retry completes normally");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- managed gateway token invalid: refresh config and retry hidden ---------
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const made = [];
    let session;
    let refreshCalls = 0;
    const baseOptions = {
      agentCommand: "/bin/true",
      modelRouteAudit: { route: "gateway", keyKind: "gateway-token" },
    };
    const ensureWithToken = (token) => {
      session.ensureProcess(process.cwd(), {
        ...baseOptions,
        env: { LILY_API_KEY: token },
        refreshManagedModelConfig: async () => {
          refreshCalls += 1;
          ensureWithToken("fresh-token");
          return { ok: true };
        },
      }, { lazy: true });
    };
    session = new OpencodeAgentSession("managed_gateway_token_refresh", {
      createServer: (opts) => {
        const server = new FakeServer();
        server.spawnEnv = opts.env || {};
        if (made.length === 0) server.failPrompt = "Request failed: 401 Unauthorized";
        made.push(server);
        return server;
      },
    });
    const orch = makeOrchestrator();
    session.bindOrchestrator(orch);
    ensureWithToken("stale-token");
    session.sendUserMessage({ text: "use managed gateway" });
    await tick();
    for (let i = 0; i < 20 && made.length < 2; i += 1) await sleep(5);
    assert(refreshCalls === 1, "managed gateway auth failure refreshes remote config once");
    assert(made.length === 2, "managed gateway auth failure restarts with refreshed config");
    assert(made[0].aborted === true, "stale-token engine session is aborted before retry");
    assert(made[1].spawnEnv.LILY_API_KEY === "fresh-token", "retry starts with refreshed gateway token");
    assert(made[1].prompts.length === 1 && made[1].prompts[0].text === "use managed gateway", "retry preserves the user request");
    made[1].emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "managed retry ok" } });
    made[1].emitEvent({ type: "session.idle", properties: { sessionID: "ses_test" } });
    await waitIdleSettle();
    assert(orch.calls.error.length === 0, "managed gateway token refresh retry avoids user-visible auth failure");
    assert(orch.calls.done.length === 1 && /managed retry ok/.test(orch.calls.done[0].output), "managed gateway retry completes normally");
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

// --- transient recovery: stale previous history cannot replace live output --
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  const savedSettle = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 200;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "current transient turn" });
    await tick();
    fake.emitEvent({ type: "message.part.delta", properties: { field: "reasoning", delta: "current turn activity" } });
    const now = Date.now();
    fake.historyMessages = [{
      info: {
        id: "msg_previous_transient_answer",
        role: "assistant",
        sessionID: "ses_test",
        time: { created: now - 1_000, completed: now - 999 },
      },
      parts: [{ type: "text", text: "PREVIOUS ANSWER" }],
    }];
    fake.idleState = true;
    fake.emit("error", new Error("SSE reconnect gave up after socket connection was closed"));
    await waitFor(() => fake.prompts.length === 2, "transient recovery must replay instead of borrowing stale history", 160);
    assert(orch.calls.done.length === 0, "stale transient history cannot complete the current turn");
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "CURRENT LIVE OUTPUT" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitFor(() => orch.calls.done.length === 1, "replayed transient turn must settle from current live output", 160);
    assert(orch.calls.done[0].output === "CURRENT LIVE OUTPUT", "transient recovery rejects a previous turn's assistant answer");
    assert(orch.calls.done[0].resultFromOfficialHistory !== true, "stale transient history is not claimed as the current result");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
    OpencodeAgentSession.IDLE_SETTLE_MS = savedSettle;
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

// --- empty model completion: replay once before surfacing failure ------------
{
  const { fake, session, orch } = await newSession();
  fake.historyMessages = [];
  fake.idleState = true;
  session.sendUserMessage({ text: "hello" });
  await tick();
  fake.emitEvent({ type: "message.part.updated", properties: { part: { type: "step-start" } } });
  fake.emitEvent({ type: "message.part.updated", properties: { part: { type: "step-finish", reason: "unknown", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  assert(fake.prompts.length === 2, "empty completion without side effects is replayed once");
  assert(orch.calls.error.length === 0, "empty completion replay avoids user-visible failure");
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "replayed hello" } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  assert(orch.calls.done.length === 1 && orch.calls.done[0].output === "replayed hello", "empty completion replay completes with second output");
  session.terminate();
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

// --- transient attachment hiccup: replay as text-only CLI manifest ----------
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 200;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    fake.idleState = true;
    const filePath = path.join(os.tmpdir(), "lily-report.pdf");
    session.sendUserMessage({
      text: "分析这个文件",
      files: [{ path: filePath, name: "report.pdf", type: "pdf", size: 1_048_576 }],
    });
    await tick();
    fake.emitEvent({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } });
    fake.emit("error", new Error("Connection to the model service was interrupted"));
    await sleep(60);
    assert(fake.prompts.length === 2, "transient attachment hiccup is replayed once");
    assert(fake.prompts[0].files.length === 1, "first transient attempt keeps original attachment");
    assert(fake.prompts[1].files.length === 0, "transient fallback replay removes file parts");
    assert(fake.prompts[1].text.includes("Attachment fallback manifest"), "transient fallback gives the CLI a manifest");
    assert(fake.prompts[1].text.includes(filePath), "transient fallback preserves the source path");
    assert(orch.calls.error.length === 0, "transient attachment fallback avoids visible model interruption");
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "read through local tools" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && /local tools/.test(orch.calls.done[0].output), "transient attachment fallback completes");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
  }
}

// --- model-level document attachment error: isolate poisoned engine session -
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 250;
  try {
    const made = [];
    const session = new OpencodeAgentSession("docx_model_error_isolation", {
      createServer: () => {
        const server = new FakeServer();
        server.historyMessages = [];
        made.push(server);
        return server;
      },
    });
    const orch = makeOrchestrator();
    session.bindOrchestrator(orch);
    session.ensureProcess(process.cwd(), { agentCommand: "/bin/true" }, { lazy: true });
    const filePath = path.join(os.tmpdir(), "lily-poison-clipboard-staged");
    session.sendUserMessage({
      text: "分析这个文件",
      files: [{ path: filePath, name: "poison.docx", type: "docx", size: 65_536 }],
    });
    await tick();
    assert(made.length === 1, "first document prompt starts the original engine session");
    made[0].idleState = true;
    made[0].emitEvent({
      type: "message.error",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_poison",
        error: { message: "Connection to the model service was interrupted. Please check your network and API settings, then retry." },
      },
    });
    await sleep(80);
    assert(made.length === 2, "document model interruption is replayed in a fresh engine session");
    assert(made[0].aborted === true, "poisoned engine session is aborted before isolation");
    assert(made[1].prompts.length === 1, "fresh engine session receives the recovery prompt");
    assert(Array.isArray(made[1].prompts[0].files) && made[1].prompts[0].files.length === 0, "recovery prompt is text-only");
    assert(made[1].prompts[0].text.includes("Attachment fallback manifest"), "recovery prompt carries the attachment manifest");
    assert(made[1].prompts[0].text.includes(filePath), "recovery prompt preserves the local source path");
    assert(orch.calls.error.length === 0, "model interruption is recovered without a sticky visible failure");

    made[1].emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "已通过本地路径读取。" } });
    made[1].emitEvent({ type: "session.idle", properties: { sessionID: "ses_test" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && /本地路径/.test(orch.calls.done[0].output), "isolated recovery turn completes");

    session.sendUserMessage({ text: "继续" });
    await tick();
    assert(made.length === 2, "subsequent messages stay on the recovered engine session");
    assert(made[1].prompts.length === 2 && made[1].prompts[1].text === "继续", "follow-up is not sent to the poisoned session");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
  }
}

// --- model-side oversized context: compact by isolating engine session -------
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 250;
  try {
    const made = [];
    const session = new OpencodeAgentSession("context_limit_auto_replay", {
      createServer: () => {
        const server = new FakeServer();
        server.historyMessages = [];
        made.push(server);
        return server;
      },
    });
    const orch = makeOrchestrator();
    session.bindOrchestrator(orch);
    session.ensureProcess(process.cwd(), { agentCommand: "/bin/true" }, { lazy: true });
    session.sendUserMessage({ text: "继续分析这个截图问题" });
    await tick();
    assert(made.length === 1, "oversized-context prompt starts the original engine session");
    made[0].idleState = true;
    made[0].emitEvent({
      type: "message.error",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_context_limit",
        error: { message: "Request failed: Request Entity Too Large" },
      },
    });
    await sleep(80);
    assert(made.length === 2, "oversized-context failure is replayed in a fresh engine session");
    assert(made[0].aborted === true, "oversized engine session is aborted before replay");
    assert(made[1].prompts.length === 1, "fresh engine receives the replayed prompt");
    assert(made[1].prompts[0].text === "继续分析这个截图问题", "fresh replay preserves the current user request");
    assert(!made[1].prompts[0].attachmentFallback, "context compaction replay does not invent an attachment fallback");
    assert(orch.calls.error.length === 0, "oversized-context recovery is hidden from the user");

    made[1].emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "压缩后继续回答。" } });
    made[1].emitEvent({ type: "session.idle", properties: { sessionID: "ses_test" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && /压缩后/.test(orch.calls.done[0].output), "fresh context replay completes normally");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
  }
}

// --- legacy resumed engine interruption: isolate poisoned resume state -------
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 250;
  try {
    const made = [];
    const session = new OpencodeAgentSession("legacy_resume_poison", {
      createServer: (opts = {}) => {
        const server = new FakeServer();
        server.wasResumed = Boolean(opts.resumeSessionID);
        server.historyMessages = [];
        made.push({ server, opts });
        return server;
      },
    });
    const orch = makeOrchestrator();
    session.bindOrchestrator(orch);
    session.ensureProcess(process.cwd(), { agentCommand: "/bin/true", resumeSessionId: "ses_old_poisoned" }, { lazy: true });
    session.sendUserMessage({ text: "继续" });
    await tick();
    assert(made.length === 1, "legacy follow-up starts by resuming the old engine session");
    assert(made[0].opts.resumeSessionID === "ses_old_poisoned", "first engine session is a resume attempt");

    made[0].server.idleState = true;
    made[0].server.emitEvent({
      type: "message.error",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_resume_poison",
        error: { message: "Connection to the model service was interrupted. Please check your network and API settings, then retry." },
      },
    });
    await sleep(80);
    assert(made.length === 2, "resumed model interruption is replayed in a fresh engine session");
    assert(made[0].server.aborted === true, "old resumed engine session is aborted before isolation");
    assert(!made[1].opts.resumeSessionID, "fresh recovery engine does not resume the poisoned history row");
    assert(made[1].server.prompts.length === 1, "fresh engine receives the recovery prompt");
    assert(made[1].server.prompts[0].text === "继续", "plain follow-up is replayed unchanged");
    assert(!made[1].server.prompts[0].attachmentFallback, "legacy recovery does not invent an attachment fallback");
    assert(orch.calls.error.length === 0, "legacy resume interruption is recovered without a sticky failure");

    made[1].server.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "恢复后的回答" } });
    made[1].server.emitEvent({ type: "session.idle", properties: { sessionID: "ses_test" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1 && /恢复后的回答/.test(orch.calls.done[0].output), "fresh replay completes normally");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
  }
}

// --- already-started legacy resume must keep its isolation marker ------------
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 250;
  try {
    const made = [];
    const session = new OpencodeAgentSession("legacy_resume_prestarted_poison", {
      createServer: (opts = {}) => {
        const server = new FakeServer();
        server.wasResumed = Boolean(opts.resumeSessionID);
        server.historyMessages = [];
        made.push({ server, opts });
        return server;
      },
    });
    const orch = makeOrchestrator();
    session.bindOrchestrator(orch);
    session.ensureProcess(process.cwd(), { agentCommand: "/bin/true", resumeSessionId: "ses_prestarted_poisoned" }, { lazy: false });
    await tick();
    assert(made.length === 1 && made[0].server.wasResumed === true, "prestarted engine resumes old history");

    session.sendUserMessage({ text: "继续" });
    await tick();
    made[0].server.idleState = true;
    made[0].server.emitEvent({
      type: "message.error",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_prestarted_poison",
        error: { message: "Connection to the model service was interrupted. Please check your network and API settings, then retry." },
      },
    });
    await sleep(80);
    assert(made.length === 2, "prestarted resumed interruption still isolates into a fresh engine");
    assert(made[0].server.aborted === true, "prestarted poisoned engine is aborted");
    assert(!made[1].opts.resumeSessionID, "fresh prestarted recovery does not reuse poisoned resume id");
    assert(made[1].server.prompts.length === 1 && made[1].server.prompts[0].text === "继续", "current prompt is replayed");
    session.terminate();
  } finally {
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = savedPoll;
    OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = savedWindow;
  }
}

// --- unsafe resumed transport failure: clear poisoned engine state ----------
{
  const savedPoll = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS;
  const savedWindow = OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS = 20;
  OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS = 90;
  try {
    const made = [];
    const invalidated = [];
    const session = new OpencodeAgentSession("legacy_resume_unsafe_failure", {
      createServer: (opts = {}) => {
        const server = new FakeServer();
        server.wasResumed = Boolean(opts.resumeSessionID);
        server.historyMessages = [];
        made.push({ server, opts });
        return server;
      },
    });
    const orch = makeOrchestrator();
    session.bindOrchestrator(orch);
    session.on("engine-session-invalidated", (payload) => invalidated.push(payload));
    session.ensureProcess(process.cwd(), { agentCommand: "/bin/true", resumeSessionId: "ses_unsafe_poisoned" }, { lazy: true });
    session.sendUserMessage({ text: "继续处理文件" });
    await tick();
    assert(made.length === 1 && made[0].server.wasResumed === true, "unsafe failure starts from a resumed engine session");
    made[0].server.idleState = true;
    made[0].server.emitEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        part: {
          id: "part_bash_1",
          type: "tool",
          tool: "bash",
          callID: "call_bash_1",
          state: { status: "running", input: { command: "python3 parse_doc.py" } },
        },
      },
    });
    made[0].server.emitEvent({
      type: "message.error",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_unsafe_poison",
        error: { message: "Connection to the model service was interrupted. Please check your network and API settings, then retry." },
      },
    });
    await sleep(160);
    assert(made.length === 1, "unsafe resumed failures must not blindly replay the prompt");
    assert(invalidated.length === 1, "visible resumed transport failure must invalidate the engine session");
    assert(invalidated[0].resetResume === true, "invalidated resumed failure clears persisted resume");
    assert(invalidated[0].previousResumeId === "ses_unsafe_poisoned" || invalidated[0].previousResumeId === "ses_test",
      `invalidated payload should identify the previous resume/session: ${JSON.stringify(invalidated[0])}`);
    assert(session.diagnostics().server == null, "poisoned engine view is detached after visible failure");
    assert(orch.calls.error.length === 1, "unsafe visible failure still settles the turn");
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

// --- pending prompt: unknown status is not busy acceptance proof -------------
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    let releasePrompt = null;
    let statusChecks = 0;
    fake.sendPrompt = async (p) => {
      fake.prompts.push(p);
      await new Promise((resolve) => { releasePrompt = resolve; });
    };
    fake.idleState = false;
    fake.getSessionStatus = async () => {
      statusChecks += 1;
      return "unknown";
    };
    session.sendUserMessage({ text: "pending request with unavailable status" });
    await tick();
    await waitFor(() => statusChecks >= 1, "pending prompt must consult tri-state session status", 120);
    assert(fake.prompts.length === 1, "unknown pending status never duplicates the unresolved request");
    assert(draftTypes(orch).filter((type) => type === "turn.accepted").length === 0,
      "unknown pending status does not mark the turn accepted");
    releasePrompt?.();
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
}

// --- attachment dispatch failure: retry as text-only so CLI can handle it ---
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    let failures = 0;
    fake.failPrompt = () => {
      failures += 1;
      if (failures === 1) throw new Error("Connection to the model service was interrupted");
      fake.idleState = false;
    };
    const filePath = path.join(os.tmpdir(), "lily-chart.svg");
    session.sendUserMessage({
      text: "分析这个",
      files: [{ path: filePath, name: "chart.svg", type: "svg", size: 26_676, isImage: true }],
    });
    await tick();
    await sleep(60);
    assert(fake.prompts.length === 2, "attachment dispatch failure is retried once");
    assert(fake.prompts[0].files.length === 1, "first attempt keeps original attachment");
    assert(Array.isArray(fake.prompts[1].files) && fake.prompts[1].files.length === 0, "fallback retry removes file parts");
    assert(/Attachment fallback manifest/.test(fake.prompts[1].text), "fallback retry gives the CLI an attachment manifest");
    assert(fake.prompts[1].text.includes(filePath), "fallback retry preserves the source path");
    assert(/Do not ask the user to re-upload/.test(fake.prompts[1].text), "fallback retry tells the CLI to continue with tools");
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "I can inspect the source path." } });
    fake.idleState = true;
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.error.length === 0, "fallback avoids direct model interruption");
    assert(orch.calls.done.length === 1 && /source path/.test(orch.calls.done[0].output), "fallback turn completes through CLI");
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

// --- accepted prompt: unknown status waits without replaying -----------------
{
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    let statusChecks = 0;
    fake.historyMessages = [];
    fake.getSessionStatus = async () => {
      statusChecks += 1;
      return "unknown";
    };
    session.sendUserMessage({ text: "quiet turn while status is unavailable" });
    await tick();
    await waitFor(
      () => statusChecks >= 2 || fake.prompts.length > 1,
      "acceptance watchdog must keep checking unknown status without replaying",
      140,
    );
    assert(fake.prompts.length === 1, "unknown accepted status does not replay the prompt");
    assert(orch.calls.error.length === 0, "unknown accepted status stays under the response watchdog");
    assert(session.isBusy() === true, "unknown accepted status keeps the turn in flight");
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
    session.sendUserMessage({ text: "accepted and completed without SSE" });
    const now = session._turnStartedAt;
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
    delete fake.lastPromptText; // legacy server fallback uses the pending raw text
    const now = Date.now();
    fake.historyMessages = [
      {
        info: {
          id: "msg_previous_final",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now - 5_000, completed: now - 4_999 },
        },
        parts: [{ type: "text", text: "PREVIOUS ANSWER" }],
      },
      {
        info: {
          id: "msg_current_user",
          role: "user",
          sessionID: "ses_test",
          time: { created: now },
        },
        parts: [{ type: "text", text: "sync final answer" }],
      },
      {
        info: {
          id: "msg_official_final",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now + 1, completed: now + 2 },
        },
        parts: [{ type: "text", text: "CURRENT ANSWER" }],
      },
    ];
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "partial" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1, "turn completes after official final sync");
    assert(orch.calls.done[0].output === "CURRENT ANSWER", "final sync selects the answer owned by the current prompt");
    assert(orch.calls.done[0].engineMessageId === "msg_official_final", "official message id becomes turn anchor");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- final sync: attachment-expanded current prompt still proves ownership ---
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    const outboundText = "analyze attachment\n\n[Attachment index]\n- report.pdf\n\nExtracted document text";
    fake.promptTextBuilder = (payload) => payload?.text === "analyze attachment"
      ? outboundText
      : String(payload?.text || "");
    session.sendUserMessage({ text: "analyze attachment" });
    await tick();
    assert(fake.lastPromptText === outboundText, "fake server records the exact expanded outbound prompt text");
    const now = Date.now();
    fake.historyMessages = [
      {
        info: {
          id: "msg_attachment_user",
          role: "user",
          sessionID: "ses_test",
          time: { created: now },
        },
        parts: [{ type: "text", text: outboundText }],
      },
      {
        info: {
          id: "msg_attachment_answer",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now + 1, completed: now + 2 },
        },
        parts: [{ type: "text", text: "ATTACHMENT CURRENT ANSWER" }],
      },
    ];
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "partial attachment answer" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1, "attachment final sync completes once");
    assert(orch.calls.done[0].output === "ATTACHMENT CURRENT ANSWER", "attachment-expanded current prompt owns its official answer");
    assert(orch.calls.done[0].engineMessageId === "msg_attachment_answer", "attachment answer keeps its official message id");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- final sync: same raw prefix with different attachment text is unowned ---
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    const exactOutboundText = "analyze attachment\n\n[Attachment index]\n- report.pdf";
    const differentHistoryText = "analyze attachment\n\n[Attachment index]\n- different.pdf";
    fake.promptTextBuilder = () => exactOutboundText;
    session.sendUserMessage({ text: "analyze attachment" });
    await tick();
    const now = Date.now();
    fake.historyMessages = [
      {
        info: {
          id: "msg_attachment_mismatch_user",
          role: "user",
          sessionID: "ses_test",
          time: { created: now },
        },
        parts: [{ type: "text", text: differentHistoryText }],
      },
      {
        info: {
          id: "msg_attachment_mismatch_answer",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now + 1, completed: now + 2 },
        },
        parts: [{ type: "text", text: "UNOWNED PREFIX-MATCH ANSWER" }],
      },
    ];
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "CURRENT LIVE OUTPUT" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1, "attachment mismatch final sync completes once");
    assert(orch.calls.done[0].output === "CURRENT LIVE OUTPUT", "different attachment expansion cannot borrow the same raw prefix");
    assert(orch.calls.done[0].resultFromOfficialHistory !== true, "prefix-only attachment match is never official ownership proof");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- final sync: identical previous prompt before turn start is unowned ------
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "repeat" });
    await tick();
    const previousCreatedAt = session._turnStartedAt - 1_000;
    fake.historyMessages = [
      {
        info: {
          id: "msg_previous_identical_user",
          role: "user",
          sessionID: "ses_test",
          time: { created: previousCreatedAt },
        },
        parts: [{ type: "text", text: "repeat" }],
      },
      {
        info: {
          id: "msg_previous_identical_answer",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: previousCreatedAt + 1, completed: previousCreatedAt + 2 },
        },
        parts: [{ type: "text", text: "PREVIOUS IDENTICAL-PROMPT ANSWER" }],
      },
    ];
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "CURRENT LIVE OUTPUT" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1, "identical previous prompt final sync completes once");
    assert(orch.calls.done[0].output === "CURRENT LIVE OUTPUT", "identical prompt before turn start cannot own current output");
    assert(orch.calls.done[0].resultFromOfficialHistory !== true, "previous identical prompt is not marked as current official history");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- final sync: file-only prompt uses exact nonempty outbound ownership -----
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    const outboundText = "[Attachment index]\n- report.pdf\n  source path: /tmp/report.pdf";
    fake.promptTextBuilder = () => outboundText;
    session.sendUserMessage({
      text: "",
      files: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
    });
    await tick();
    assert(fake.lastPromptText === outboundText, "file-only prompt still records a nonempty exact outbound text");
    const now = Date.now();
    fake.historyMessages = [
      {
        info: {
          id: "msg_file_only_user",
          role: "user",
          sessionID: "ses_test",
          time: { created: now },
        },
        parts: [{ type: "text", text: outboundText }],
      },
      {
        info: {
          id: "msg_file_only_answer",
          role: "assistant",
          sessionID: "ses_test",
          time: { created: now + 1, completed: now + 2 },
        },
        parts: [{ type: "text", text: "FILE-ONLY CURRENT ANSWER" }],
      },
    ];
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "partial file-only answer" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1, "file-only final sync completes once");
    assert(orch.calls.done[0].output === "FILE-ONLY CURRENT ANSWER", "exact file-only outbound text owns its assistant answer");
    assert(orch.calls.done[0].engineMessageId === "msg_file_only_answer", "file-only answer keeps its official message id");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- final sync: missing/mismatched outbound text cannot claim history -------
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    for (const scenario of [
      { label: "missing", lastPromptText: "" },
      { label: "mismatched", lastPromptText: "[Attachment index]\n- different.pdf" },
    ]) {
      const { fake, session, orch } = await newSession();
      const actualOutboundText = "[Attachment index]\n- report.pdf\n  source path: /tmp/report.pdf";
      fake.promptTextBuilder = () => actualOutboundText;
      session.sendUserMessage({
        text: "",
        files: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
      });
      await tick();
      fake.lastPromptText = scenario.lastPromptText;
      const now = Date.now();
      fake.historyMessages = [
        {
          info: {
            id: `msg_file_only_${scenario.label}_user`,
            role: "user",
            sessionID: "ses_test",
            time: { created: now },
          },
          parts: [{ type: "text", text: actualOutboundText }],
        },
        {
          info: {
            id: `msg_file_only_${scenario.label}_answer`,
            role: "assistant",
            sessionID: "ses_test",
            time: { created: now + 1, completed: now + 2 },
          },
          parts: [{ type: "text", text: "UNPROVEN OFFICIAL ANSWER" }],
        },
      ];
      const liveOutput = `CURRENT LIVE OUTPUT (${scenario.label})`;
      fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: liveOutput } });
      fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
      await waitIdleSettle();
      assert(orch.calls.done.length === 1, `${scenario.label} outbound ownership settles once`);
      assert(orch.calls.done[0].output === liveOutput, `${scenario.label} outbound ownership preserves current live output`);
      assert(orch.calls.done[0].resultFromOfficialHistory !== true,
        `${scenario.label} outbound ownership cannot claim unproven official history`);
      session.terminate();
    }
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- final sync: stale previous answer cannot replace current live output ----
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "current prompt missing from official history" });
    await tick();
    const now = Date.now();
    fake.historyMessages = [{
      info: {
        id: "msg_previous_idle_sync_answer",
        role: "assistant",
        sessionID: "ses_test",
        time: { created: now - 1_000, completed: now - 999 },
      },
      parts: [{ type: "text", text: "PREVIOUS ANSWER" }],
    }];
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "CURRENT LIVE OUTPUT" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitIdleSettle();
    assert(orch.calls.done.length === 1, "idle settlement completes the current turn once");
    assert(orch.calls.done[0].stalled !== true, "idle final sync is not a watchdog stall");
    assert(orch.calls.done[0].output === "CURRENT LIVE OUTPUT", "idle final sync preserves current live output when history is unowned");
    assert(orch.calls.done[0].resultFromOfficialHistory !== true, "unowned previous answer is not marked as the official current result");
    session.terminate();
  } finally {
    OpencodeAgentSession.IDLE_SETTLE_MS = saved;
  }
}

// --- explicit idle: unknown status still settles from the authoritative event -
{
  const saved = OpencodeAgentSession.IDLE_SETTLE_MS;
  OpencodeAgentSession.IDLE_SETTLE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    fake.idleState = false; // legacy boolean path would keep rescheduling forever
    fake.getSessionStatus = async () => "unknown";
    session.sendUserMessage({ text: "explicit idle with unavailable status" });
    await tick();
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "CURRENT LIVE OUTPUT" } });
    fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
    await waitFor(() => orch.calls.done.length === 1, "explicit idle must settle once even when status is unknown", 160);
    assert(orch.calls.done[0].stalled !== true, "explicit idle with unknown status is not marked stalled");
    assert(orch.calls.done[0].output === "CURRENT LIVE OUTPUT", "explicit idle with unknown status preserves live output");
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
  const saved = OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS;
  OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    fake.idleState = true;
    session.sendUserMessage({ text: "accepted but never starts" });
    await tick();
    await sleep(80);
    assert(fake.prompts.length === 2, "accepted-but-idle prompt is retried once before failing");
    assert(orch.calls.error.length === 1, "accepted-but-idle failure is visible after bounded retry");
    assert(/unexpected response|did not start/i.test(orch.calls.error[0]), `accepted-but-idle failure should be classified/retryable: ${orch.calls.error[0]}`);
    assert(session.diagnostics().server == null, "accepted-but-idle failure detaches the stale engine view");
    session.terminate();
  } finally {
    OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS = saved;
  }
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
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "turn one done" } });
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

// Character authoring is complete only after the persistent draft tool succeeds.
{
  const { fake, session, orch } = await newSession();
  session.sendUserMessage({
    text: "create a character",
    requiredSuccessfulTools: ["lily_character_draft"],
  });
  await tick();
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "Created character.md" } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  await tick();
  assert(orch.calls.done.length === 0, "missing persistent draft tool keeps authoring turn open");
  assert(
    fake.prompts.length === 2 && /lily_character_draft/.test(fake.prompts[1].text),
    "required-tool gate posts a corrective native-tool prompt",
  );
  fake.emitEvent({
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "lily_character_draft",
        callID: "draft-1",
        state: { status: "running", input: { action: "create", kind: "character" } },
      },
    },
  });
  fake.emitEvent({
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "lily_character_draft",
        callID: "draft-1",
        state: { status: "completed", output: JSON.stringify({ ok: true, entityId: "character-1" }) },
      },
    },
  });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  await tick();
  assert(orch.calls.done.length === 1, "successful persistent draft tool permits completion");
  session.terminate();
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

// --- no-progress: active foreground tools get a lease, not a weak fallback ----
{
  const savedNotice = OpencodeAgentSession.PROGRESS_NOTICE_MS;
  const savedTimeout = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  OpencodeAgentSession.PROGRESS_NOTICE_MS = 25;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 60;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "run a quiet long command" });
    await tick();
    fake.emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "quiet_bash",
          state: {
            status: "running",
            input: { command: "python3 generate-report.py --full" },
          },
        },
      },
    });
    await sleep(150);
    assert(orch.calls.done.length === 0, "active tool must not be force-ended only because it is quiet");
    assert(fake.aborted === false, "active tool lease must not abort the engine");
    const toolNotice = orch.calls.ingest.find((d) => d.type === "engine.notice" && d.payload?.notice?.code === "toolProgress");
    assert(toolNotice, "active quiet tool emits observable progress instead of downgrading");
    assert(String(toolNotice.payload.notice.detail || "").includes("generate-report.py"), "tool lease notice names the running command");
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

  session.ensureProcess(process.cwd(), {
    agentCommand: "/bin/true",
    opencodeConfig: "CONFIG_A",
    modelConfigFingerprint: "same-model-fp",
  }, { lazy: true });
  session.sendUserMessage({ text: "turn one" });
  await tick();
  assert(serverCount === 1, "first send starts exactly one server");
  made[0].emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "turn one done" } });
  made[0].emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  assert(orch.calls.done.length === 1, "turn one completes");

  // Config changes between turns (AGENT.md/digest churn) — must NOT respawn.
  session.ensureProcess(process.cwd(), {
    agentCommand: "/bin/true",
    opencodeConfig: "CONFIG_B_DIFFERENT",
    modelConfigFingerprint: "same-model-fp",
  }, { lazy: true });
  session.sendUserMessage({ text: "turn two" });
  await tick();
  assert(serverCount === 1, "config change does NOT respawn the server (context stays threaded)");
  assert(made[0].prompts.length === 2 && made[0].prompts[1].text === "turn two", "turn two POSTs to the same session");
  session.terminate();
}

// --- model config continuity: provider/model changes must restart engine ----
// OpenCode can keep a provider/model instance alive inside the shared serve. A
// changed baseURL/key/model options hash must not keep posting into that stale
// engine session, otherwise custom provider body overlays can appear "missing".
{
  let serverCount = 0;
  const made = [];
  const invalidations = [];
  const session = new OpencodeAgentSession("model_config_restart", {
    createServer: (opts) => {
      serverCount += 1;
      const s = new FakeServer();
      s.opts = opts;
      made.push(s);
      return s;
    },
  });
  const orch = makeOrchestrator();
  session.bindOrchestrator(orch);
  session.on("engine-session-invalidated", (payload) => invalidations.push(payload));

  session.ensureProcess(process.cwd(), {
    agentCommand: "/bin/true",
    opencodeConfig: "CONFIG_MODEL_A",
    modelConfigFingerprint: "model-fp-a",
    resumeSessionId: "ses_old_model_config",
  }, { lazy: true });
  session.sendUserMessage({ text: "turn one" });
  await tick();
  assert(serverCount === 1, "first model config starts one server");
  assert(made[0].opts.resumeSessionID === "ses_old_model_config", "first start may resume the persisted session");
  made[0].emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "turn one done" } });
  made[0].emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  assert(orch.calls.done.length === 1, "turn one completes before model config changes");

  session.ensureProcess(process.cwd(), {
    agentCommand: "/bin/true",
    opencodeConfig: "CONFIG_MODEL_B",
    modelConfigFingerprint: "model-fp-b",
    resumeSessionId: "ses_old_model_config",
  }, { lazy: true });
  assert(made[0].process === null, "stale model-config server is terminated while idle");
  assert(invalidations.length === 1 && invalidations[0].reason === "model_config_changed", "model config change invalidates the stale resume id");

  session.sendUserMessage({ text: "turn two" });
  await tick();
  assert(serverCount === 2, "changed model config starts a fresh server");
  assert(made[1].opts.configContent === "CONFIG_MODEL_B", "fresh server receives the new OpenCode config");
  assert(!made[1].opts.resumeSessionID, "fresh model config does not reuse the stale OpenCode session id");
  assert(made[1].prompts.length === 1 && made[1].prompts[0].text === "turn two", "turn two posts to the fresh model-config session");
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
  assert(await session.compactContext({ providerID: "lily", modelID: "deepseek-chat", auto: true }) === true,
    "compaction before first user send starts the runtime and summarizes");
  assert(
    JSON.stringify(fake.summarizeCalls) === JSON.stringify([{ providerID: "lily", modelID: "deepseek-chat", auto: true }]),
    "pre-start native compaction uses the requested model/body",
  );
  session.sendUserMessage({ text: "seed session" });
  await tick();
  assert(await session.compactContext({ providerID: "lily", modelID: "deepseek-chat", auto: true }) === false,
    "busy turn must not be interrupted by background compaction");
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "seeded" } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  assert(await session.compactContext({ providerID: "lily", modelID: "deepseek-chat", auto: true }) === true,
    "idle runner passes native compaction through");
  assert(
    JSON.stringify(fake.summarizeCalls) === JSON.stringify([
      { providerID: "lily", modelID: "deepseek-chat", auto: true },
      { providerID: "lily", modelID: "deepseek-chat", auto: true },
    ]),
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

// --- no-progress: orphaned running tools have a bounded lease ----------------
{
  const savedTimeout = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  const savedLease = OpencodeAgentSession.ACTIVE_TOOL_LEASE_MS;
  const savedSync = OpencodeAgentSession.STALLED_HISTORY_SYNC_MS;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 35;
  OpencodeAgentSession.ACTIVE_TOOL_LEASE_MS = 45;
  OpencodeAgentSession.STALLED_HISTORY_SYNC_MS = 5;
  try {
    const { fake, session, orch } = await newSession();
    fake.historyMessages = [];
    session.sendUserMessage({ text: "run a tool that never closes" });
    await tick();
    fake.emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call_orphan",
          state: { status: "running", input: { command: "python3 -c 'print(1)'" } },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 120));
    assert(orch.calls.done.length === 1, "orphaned running tool does not keep the turn alive forever");
    assert(orch.calls.done[0].stalled === true, "orphaned tool force-end is marked stalled");
    assert(fake.aborted === true, "orphaned tool force-end aborts the engine");
    session.terminate();
  } finally {
    OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = savedTimeout;
    OpencodeAgentSession.ACTIVE_TOOL_LEASE_MS = savedLease;
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

// --- no-progress: stale previous answer cannot replace current live output --
{
  const savedTimeout = OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS;
  const savedSync = OpencodeAgentSession.STALLED_HISTORY_SYNC_MS;
  OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS = 40;
  OpencodeAgentSession.STALLED_HISTORY_SYNC_MS = 20;
  try {
    const { fake, session, orch } = await newSession();
    session.sendUserMessage({ text: "current prompt with live output" });
    await tick();
    const now = Date.now();
    fake.historyMessages = [{
      info: {
        id: "msg_previous_stale_answer",
        role: "assistant",
        sessionID: "ses_test",
        time: { created: now - 1_000, completed: now - 999 },
      },
      parts: [{ type: "text", text: "PREVIOUS ANSWER" }],
    }];
    fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "CURRENT LIVE OUTPUT" } });
    await sleep(90);
    assert(orch.calls.done.length === 1, "watchdog settles the current turn once");
    assert(orch.calls.done[0].stalled === true, "unowned stale history cannot be recovered as a completed current turn");
    assert(orch.calls.done[0].output === "CURRENT LIVE OUTPUT", "stalled recovery preserves current live output");
    assert(fake.aborted === true, "unrecovered current turn aborts the engine before settling");
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

// --- recycleIdleEngine: fresh serve next send, SAME engine session resumed ---
// (field: gateway connection-affinity pinned the engine's keep-alive pool to a
// dead backend pod — recycling before a rescue retry gets fresh sockets)
{
  const { fake, session } = await newSession();
  session.sendUserMessage({ text: "warm up" });
  await tick();
  assert(session.recycleIdleEngine("test") === false, "a busy engine is never recycled");
  fake.emitEvent({ type: "message.part.delta", properties: { field: "text", delta: "done" } });
  fake.emitEvent({ type: "session.idle", properties: { sessionID: "s" } });
  await waitIdleSettle();
  assert(session.isBusy() === false, "warm-up turn settled");
  const resumeBefore = session.agentResumeId || fake.sessionID || "";
  assert(session.recycleIdleEngine("test") === true, "an idle engine recycles");
  assert(session._server === null, "the old serve object is dropped");
  assert(session.agentResumeId === resumeBefore, "the engine session id survives for resume");
  assert(session.isAlive() === false || session._starting === null, "no phantom start is left behind");
  session.terminate();
}

// Pre-turn context compaction must be BOUNDED: a hung model summarize call
// cannot be allowed to freeze the turn forever at "Preparing to compact…".
{
  // Timeout mechanism: fast promise resolves; a hang rejects with the label
  // within the bound (fail-open catch turns that into "skip compaction").
  const fast = await runWithTimeout(Promise.resolve("ok"), 1000, "X");
  assert(fast === "ok", "runWithTimeout passes through a fast result");
  let caught = "";
  const started = Date.now();
  try { await runWithTimeout(new Promise(() => {}), 100, "COMPACTION_TIMEOUT"); }
  catch (err) { caught = err.message; }
  assert(caught === "COMPACTION_TIMEOUT", "a hung promise rejects with the timeout label");
  assert(Date.now() - started < 800, "the timeout fires promptly, not after an unbounded wait");
  // Bound is env-configurable but floored so a legit large summary is not cut short.
  assert(compactionTimeoutMs() === 90000, "default compaction timeout is 90s");
  process.env.LILY_COMPACTION_TIMEOUT_MS = "5000";
  assert(compactionTimeoutMs() === 15000, "compaction timeout floors at 15s");
  delete process.env.LILY_COMPACTION_TIMEOUT_MS;

  // compactContext fails OPEN (returns false) when the summarize call errors,
  // so the caller runs the turn without compaction instead of blocking.
  const fakeServer = { summarize: async () => { throw new Error("summarize boom"); }, terminate: () => {} };
  const session = new OpencodeAgentSession("compact_fail_open", { createServer: () => fakeServer });
  session._server = fakeServer;
  const compacted = await session.compactContext({ reason: "test" });
  assert(compacted === false, "compactContext returns false (fail-open) when summarize fails");
  session.terminate?.();
}

console.log("opencode-agent-session: ok");
