#!/usr/bin/env node
// Tool-call rescue closed loop: a turn that fails because the model leaked its
// tool call as literal text is retried ONCE with a corrective instruction on
// the ENGINE-facing text (visible transcript untouched). Guard rails: per-
// session cooldown, kill switch, background self-heal still learns, and the
// normal failure UX stays intact when rescue cannot run.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-tool-call-rescue-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));

// Stub self-heal (capture background learning; heals only when the test flips
// the flag) and service-client BEFORE the orchestrator loads.
const selfHealCalls = [];
let selfHealShouldHeal = false;
const selfHealPath = require.resolve("../src/main/model-self-heal.js");
require.cache[selfHealPath] = {
  id: selfHealPath,
  filename: selfHealPath,
  loaded: true,
  exports: {
    attemptModelSelfHeal: async (args) => {
      selfHealCalls.push(args);
      return { attempted: true, healed: selfHealShouldHeal };
    },
    isHealableFailureCode: (code) =>
      ["EMPTY_ASSISTANT_COMPLETION", "MALFORMED_TOOL_CALL_TEXT", "RESPONSE_ERROR", "TRUNCATED_TURN_END"].includes(String(code || "")),
    resetSelfHealStateForTests: () => {},
  },
};
const serviceClientPath = require.resolve("../src/main/service-client.js");
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    reportUsage: async () => ({ ok: true }),
    reportRuntimeDiagnostic: async () => ({ ok: true, json: { id: "diag_test" } }),
  },
};

const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");
const { resetRescueStateForTests, correctiveHintFor, evidenceVerifyHintFor, rescueStrategyFor, isSideEffectFreeToolRun } = require("../src/main/tool-call-rescue.js");

{
  const durableMessages = [{
    id: "assistant_old",
    role: "assistant",
    turnId: "turn_old",
    content: "safe fallback",
    meta: {},
  }];
  const durableStore = new TranscriptStore({
    getConversation: () => durableMessages,
    updateMessageMeta: (_sessionId, messageId, updater) => {
      const message = durableMessages.find((item) => item.id === messageId);
      if (!message) return null;
      message.meta = updater(message.meta || {}, message);
      return message;
    },
  });
  assert.ok(durableStore.supersedeAssistantTurn("s1", "turn_old", "turn_recovery"));
  assert.deepEqual(durableMessages[0].meta, { superseded: true, supersededByTurnId: "turn_recovery" });
}

// Read-only whitelist: replaying pure-read turns is safe; anything else is not.
assert.equal(isSideEffectFreeToolRun([{ name: "read" }, { name: "glob" }, { name: "websearch" }]), true);
assert.equal(
  isSideEffectFreeToolRun([{ name: "lily_intent_contract_commit" }, { name: "websearch" }]),
  true,
  "the host-owned idempotent intent commit must not disable safe evidence recovery",
);
assert.equal(isSideEffectFreeToolRun([{ name: "read" }, { name: "write" }]), false);
assert.equal(isSideEffectFreeToolRun([{ name: "lily_tb_mail_send" }]), false, "MCP tools are never assumed safe");

// Verify-before-assert: the strategy is available by default (the orchestrator
// invokes it by default for side-effect-free external facts, opt-in for others).
// A one-shot retry steers the model to verify with tools first (language-aware).
assert.equal(rescueStrategyFor("EVIDENCE_UNVERIFIED")?.kind, "evidence_verify_retry", "verify-before-assert strategy is available by default");
assert.equal(rescueStrategyFor("DOCUMENT_DELIVERY_UNVERIFIED")?.kind, "document_verify_retry");
{
  process.env.LILY_EVIDENCE_VERIFY_RETRY = "0";
  assert.equal(rescueStrategyFor("EVIDENCE_UNVERIFIED"), null, "hard-off (LILY_EVIDENCE_VERIFY_RETRY=0) disables it entirely");
  delete process.env.LILY_EVIDENCE_VERIFY_RETRY;
}
{
  process.env.LILY_DOCUMENT_DELIVERY_RETRY = "0";
  assert.equal(rescueStrategyFor("DOCUMENT_DELIVERY_UNVERIFIED"), null);
  delete process.env.LILY_DOCUMENT_DELIVERY_RETRY;
}

// Model-connection auto-repair (2026-07-21 directive): connection-class
// failures get silent multi-attempt rescue with engine recycle — while the
// API is usable the user must never see them.
{
  const { shouldAttemptRescue, markRescueAttempt, rescueAttemptCount } = require("../src/main/tool-call-rescue.js");
  const connStrategy = rescueStrategyFor("MODEL_CONNECTION_FAILED");
  assert.equal(connStrategy?.kind, "model_connection_retry");
  assert.equal(connStrategy?.recycleEngine, true, "connection retries ride fresh connections, not the poisoned pool");
  assert.equal(connStrategy?.maxAttempts, 3, "a gateway restart loop outlasts one retry — bounded at three");
  for (const code of ["ENGINE_UNAVAILABLE", "MODEL_OVERLOADED", "RATE_LIMITED", "PERMISSION_DENIED"]) {
    assert.equal(rescueStrategyFor(code)?.kind, "model_connection_retry", `${code} joins the connection auto-repair family`);
  }
  process.env.LILY_MODEL_CONNECTION_RETRY = "0";
  assert.equal(rescueStrategyFor("MODEL_CONNECTION_FAILED"), null, "kill switch disables connection auto-repair");
  delete process.env.LILY_MODEL_CONNECTION_RETRY;

  // Turn start builds context memory; when the host has embedding keys set,
  // that path would fire a REAL external API call and stall the rescue resend
  // under test. Pin embedding off so the suite stays hermetic and fast.
  process.env.LILY_MEMORY_EMBEDDING = "0";
  process.env.LILY_EMBEDDING_API_KEY = "";
  delete process.env.DASHSCOPE_API_KEY;

  // Multi-attempt budget: attempts 1..maxAttempts pass, the next is refused;
  // the budget resets after the episode window so a later failure earns a
  // fresh set of silent attempts.
  resetRescueStateForTests();
  const t0 = Date.now();
  assert.equal(shouldAttemptRescue("s-unit", "MODEL_CONNECTION_FAILED", t0, 3), true);
  markRescueAttempt("s-unit", "MODEL_CONNECTION_FAILED", t0);
  assert.equal(shouldAttemptRescue("s-unit", "MODEL_CONNECTION_FAILED", t0 + 1000, 3), false, "double-fire debounce");
  markRescueAttempt("s-unit", "MODEL_CONNECTION_FAILED", t0 + 6000);
  assert.equal(shouldAttemptRescue("s-unit", "MODEL_CONNECTION_FAILED", t0 + 12000, 3), true, "third attempt still within budget");
  markRescueAttempt("s-unit", "MODEL_CONNECTION_FAILED", t0 + 12000);
  assert.equal(shouldAttemptRescue("s-unit", "MODEL_CONNECTION_FAILED", t0 + 20000, 3), false, "budget exhausted after maxAttempts");
  assert.equal(shouldAttemptRescue("s-unit", "MODEL_CONNECTION_FAILED", t0 + 20000, 1), false, "single-attempt strategies stop at one");
  const later = t0 + 11 * 60_000;
  assert.equal(shouldAttemptRescue("s-unit", "MODEL_CONNECTION_FAILED", later, 3), true, "a later episode earns a fresh budget");
  assert.equal(rescueAttemptCount("s-unit", t0 + 20000), 3, "attempt counting feeds the terminal copy");
  resetRescueStateForTests();
}
assert.match(evidenceVerifyHintFor({}), /verify it with a tool/i, "verify hint tells the model to verify with tools before asserting");
assert.match(evidenceVerifyHintFor({ instructionLanguage: "zh" }), /先用工具核实/, "verify hint is language-aware (zh)");
assert.match(evidenceVerifyHintFor({}), /do not return only a scope question/i, "verify hint rejects avoidable clarification-only answers");
assert.match(evidenceVerifyHintFor({ instructionLanguage: "zh" }), /不要只把范围问题抛回用户/, "zh verify hint rejects avoidable clarification-only answers");
assert.match(evidenceVerifyHintFor({}), /websearch\/webfetch or a live authoritative API/i, "external fact retry names the executable research path");
assert.match(evidenceVerifyHintFor({ instructionLanguage: "zh" }), /只引用工具真实返回的链接/, "external fact retry forbids invented citations");
assert.match(
  evidenceVerifyHintFor({ instructionLanguage: "zh" }, { reason: "authoritative_source_required" }),
  /不要重复同一条宽泛搜索.*官方机构/,
  "authority gaps tell the retry to change search strategy",
);
assert.match(
  evidenceVerifyHintFor({}, { reason: "entity_claim_not_in_evidence" }),
  /verify each one against primary material/i,
  "entity coverage gaps require item-by-item primary evidence",
);
assert.equal(isSideEffectFreeToolRun([]), true, "a tool-less turn is trivially safe to replay");

// Recipe-aware corrective hint: the probe's instructionLanguage finding picks
// the hint variant this model demonstrably follows.
assert.match(correctiveHintFor({}), /\[system correction\]/, "default corrective hint is English");
assert.match(correctiveHintFor({ instructionLanguage: "zh" }), /\[系统纠正\]/, "zh recipe switches the hint to Chinese");
assert.match(correctiveHintFor({ instructionLanguage: "en" }), /\[system correction\]/, "explicit en recipe keeps English");

class FakeRunner extends EventEmitter {
  constructor() {
    super();
    this.sessionId = "s1";
    this.busy = false;
    this.spawnOptions = {};
    this.sentPayloads = [];
  }
  isBusy() { return this.busy; }
  isAlive() { return true; }
  sendUserMessage(payload) {
    this.busy = true;
    this.sentPayloads.push(payload);
    this.emit("status", "thinking");
    return true;
  }
  failWithLeakedToolCall() {
    // Realistic Qwen-style leak: two marker kinds (<function=> + <parameter=>),
    // which is what the classifier keys on for real-world fragments.
    const leaked = "<function=read_file><parameter=path>a.txt</parameter></function>";
    ctx.turnOrchestrator.ingest("s1", [{ type: "assistant.delta", payload: { text: leaked } }]);
    this.busy = false;
    this.emit("done", { code: 0, output: leaked });
  }
  interrupt() { this.busy = false; }
  diagnostics() { return {}; }
}

const sent = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
};
const messages = [];
const session = { id: "s1", projectId: "p1", messages };
const runner = new FakeRunner();
const durableTurns = new Map();
let admittedSeq = 0;
function admitTestTurn(sessionId, input) {
  const turn = {
    sessionId,
    admittedSeq: ++admittedSeq,
    turnId: input.turnId,
    delivery: input.delivery || "direct",
    status: "admitted",
    userText: input.userText || "",
    files: input.files || [],
    metadata: input.metadata || {},
    ownerScope: "profile:tool-call-rescue",
    dispatchAttemptId: null,
  };
  durableTurns.set(turn.turnId, turn);
  return turn;
}
const ctx = {
  get mainWindow() { return fakeWindow; },
  eventBus: new RuntimeEventBus(() => fakeWindow),
  sessionManager: {
    findById: (id) => (id === "s1" ? session : null),
    getActive: () => session,
    pushMessageTo: (_sessionId, role, content, files, extra) => messages.push({ role, content, files, ...extra }),
    popLastAssistantMessage: () => false,
    getLastUserMessage: () => [...messages].reverse().find((m) => m.role === "user") || null,
    findAgentResumeOwner: () => null,
    setAgentResumeId: () => {},
    claimAgentResumeId: () => ({ ok: true, evictedSessionIds: [] }),
    clearAgentResumeId: () => true,
    resolveTurnOwnerScope: () => ({
      ok: true,
      error: null,
      ownerScope: "profile:tool-call-rescue",
    }),
    admitTurnInput: (sessionId, input) => admitTestTurn(sessionId, input),
    admitTurnInputFromSource: (sessionId, input) => (
      admitTestTurn(sessionId, input)
    ),
    markTurnInputTerminal: (claim, terminalType) => {
      const turn = durableTurns.get(claim.turnId);
      if (
        !turn
        || turn.sessionId !== claim.sessionId
        || turn.ownerScope !== claim.ownerScope
        || turn.dispatchAttemptId !== claim.dispatchAttemptId
        || !claim.fromStatuses.includes(turn.status)
      ) return { ok: false, reason: "TERMINAL_CLAIM_MISMATCH", turn };
      const terminal = {
        ...turn,
        status: terminalType === "turn.completed"
          ? "completed"
          : terminalType === "turn.interrupted"
            ? "interrupted"
            : "failed",
        terminalType,
      };
      durableTurns.set(terminal.turnId, terminal);
      return { ok: true, turn: terminal };
    },
  },
  projectManager: { find: () => ({ id: "p1", path: process.cwd() }) },
  runnerPool: {
    get: () => runner,
    ensure: () => runner,
    terminateSession: () => {},
    getSessionIds: () => ["s1"],
  },
  scheduledTaskManager: { completeQueuedRun: () => true },
};
ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
ctx.turnArchive = new TurnArchive(ctx.sessionManager, { eventBus: ctx.eventBus });
ctx.turnOrchestrator = new TurnOrchestrator(ctx);
ctx.turnOrchestrator.bindRunner(runner);

const flushEvents = () => {
  ctx.eventBus.flush();
  const events = sent.flatMap((entry) => entry.payload?.events || []);
  sent.length = 0;
  return events;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// Evidence retries supersede the safe placeholder only AFTER the replacement
// turn is accepted. The durable marker protects history reload, while the typed
// event removes the duplicate bubble immediately.
{
  const sequence = [];
  const originalSend = ctx.turnOrchestrator.sendUserMessage.bind(ctx.turnOrchestrator);
  const originalRemove = ctx.transcriptStore.removeLastAssistantMessage.bind(ctx.transcriptStore);
  const originalSupersede = ctx.transcriptStore.supersedeAssistantTurn.bind(ctx.transcriptStore);
  messages.push({ role: "user", content: "Who is the current CEO?", files: [] });
  ctx.transcriptStore.removeLastAssistantMessage = () => { sequence.push("remove"); return true; };
  ctx.transcriptStore.supersedeAssistantTurn = () => { sequence.push("supersede"); return { ok: true }; };
  ctx.turnOrchestrator.sendUserMessage = async () => { sequence.push("send"); return { ok: true }; };
  resetRescueStateForTests();
  const dispatched = await ctx.turnOrchestrator._maybeToolCallRescueRetry("s1", {
    code: "EVIDENCE_UNVERIFIED",
    supersedesTurnId: "fact-turn-old",
  });
  assert.equal(dispatched, true);
  assert.deepEqual(sequence, ["send", "supersede"], "evidence fallback receives a durable supersession only after retry acceptance");
  const supersession = flushEvents().find((event) => event.type === "assistant.supersedes");
  assert.equal(supersession?.turnId, "fact-turn-old");
  assert.equal(supersession?.payload?.supersedes, "fact-turn-old");

  sequence.length = 0;
  ctx.turnOrchestrator.sendUserMessage = async () => { sequence.push("send"); return { ok: false, error: "BUSY" }; };
  resetRescueStateForTests();
  await ctx.turnOrchestrator._maybeToolCallRescueRetry("s1", {
    code: "EVIDENCE_UNVERIFIED",
    supersedesTurnId: "fact-turn-kept",
  });
  assert.deepEqual(sequence, ["send"], "failed retry dispatch must keep the existing safe fallback");
  assert.equal(flushEvents().some((event) => event.type === "assistant.supersedes"), false);
  messages.pop();
  ctx.turnOrchestrator.sendUserMessage = originalSend;
  ctx.transcriptStore.removeLastAssistantMessage = originalRemove;
  ctx.transcriptStore.supersedeAssistantTurn = originalSupersede;
}

// A first-party Bash web search is semantically read-only, so a repairable
// authority gap may retry once with a reason-specific strategy. Arbitrary Bash
// remains blocked because replaying the whole turn could repeat side effects.
{
  const state = ctx.turnOrchestrator._state("s1");
  const originalTools = state.tools;
  const originalSend = ctx.turnOrchestrator.sendUserMessage.bind(ctx.turnOrchestrator);
  const originalRemove = ctx.transcriptStore.removeLastAssistantMessage.bind(ctx.transcriptStore);
  messages.push({ role: "user", content: "Which organizations have this classification?", files: [] });
  state.tools = new Map([["search", {
    name: "Bash",
    input: { command: String.raw`echo '{"query":"classification"}' | "C:\runtime-bin\node.cmd" "C:\skills\websearch\scripts\websearch.cjs"` },
  }]]);
  let captured = null;
  ctx.turnOrchestrator.sendUserMessage = async (...args) => { captured = args; return { ok: true }; };
  ctx.transcriptStore.removeLastAssistantMessage = () => true;
  resetRescueStateForTests();
  const evidenceRecoveryContext = {
    schemaVersion: 1,
    mode: "evidence_verify_retry",
    sourceTurnId: "weak-source-turn",
    tools: [],
  };
  const upgraded = await ctx.turnOrchestrator._maybeToolCallRescueRetry("s1", {
    code: "EVIDENCE_UNVERIFIED",
    evidenceReason: "authoritative_source_required",
    supersedesTurnId: "weak-source-turn",
    evidenceRecoveryContext,
  });
  assert.equal(upgraded, true);
  assert.equal(captured?.[3]?.engineText, undefined, "internal recovery guidance must not replace the visible user text");
  assert.equal(captured?.[3]?.recovery?.kind, "evidence_verify_retry");
  assert.equal(captured?.[3]?.recovery?.evidenceContext, evidenceRecoveryContext);
  assert.match(captured?.[3]?.recovery?.guidance || "", /Do not repeat the same broad query/);
  assert.match(captured?.[3]?.recovery?.guidance || "", /responsible regulator/);

  state.tools = new Map([["shell", { name: "Bash", input: { command: "rg classification src" } }]]);
  captured = null;
  resetRescueStateForTests();
  const blocked = await ctx.turnOrchestrator._maybeToolCallRescueRetry("s1", {
    code: "EVIDENCE_UNVERIFIED",
    evidenceReason: "authoritative_source_required",
    supersedesTurnId: "unsafe-shell-turn",
  });
  assert.equal(blocked, false);
  assert.equal(captured, null);

  messages.pop();
  state.tools = originalTools;
  ctx.turnOrchestrator.sendUserMessage = originalSend;
  ctx.transcriptStore.removeLastAssistantMessage = originalRemove;
  flushEvents();
}

// Document QA is a continuation over explicit files, not a replay of the
// authoring request. It is therefore allowed after a write tool and receives
// full preflight plus the inherited artifact list.
{
  const documentPath = path.join(tempUserData, "delivery.pdf");
  fs.writeFileSync(documentPath, "%PDF-1.7\n%%EOF\n");
  const state = ctx.turnOrchestrator._state("s1");
  state.wasRescueAttempt = false;
  state.tools.set("write-for-delivery", { id: "write-for-delivery", name: "write", status: "done" });
  let captured = null;
  const originalSend = ctx.turnOrchestrator.sendUserMessage.bind(ctx.turnOrchestrator);
  const originalRemove = ctx.transcriptStore.removeLastAssistantMessage.bind(ctx.transcriptStore);
  ctx.turnOrchestrator.sendUserMessage = async (...args) => { captured = args; return { ok: true }; };
  ctx.transcriptStore.removeLastAssistantMessage = () => true;
  resetRescueStateForTests();
  const dispatched = await ctx.turnOrchestrator._maybeToolCallRescueRetry("s1", {
    code: "DOCUMENT_DELIVERY_UNVERIFIED",
    supersedesTurnId: "document-turn-old",
    userText: "Create a polished report",
    documentDelivery: { artifacts: [{ path: documentPath }], missing: ["visual_inspection"] },
  });
  assert.equal(dispatched, true, "a document QA continuation is allowed after file writes");
  assert.match(captured[1], /internal continuation/i);
  assert.deepEqual(captured[2], []);
  assert.equal(captured[3].recordUser, false);
  assert.equal(captured[3].skipPreflight, false, "managed document runtime preflight remains enabled");
  assert.equal(captured[3].documentDeliveryRecovery, true);
  assert.deepEqual(captured[3].expectedArtifactPaths, [documentPath]);
  state.tools.clear();
  state.wasRescueAttempt = false;
  ctx.turnOrchestrator.sendUserMessage = originalSend;
  ctx.transcriptStore.removeLastAssistantMessage = originalRemove;
  flushEvents();
}

// --- rescue fires once, silently, on the engine text only --------------------

const sendResult = await ctx.turnOrchestrator.sendUserMessage("s1", "please read a.txt", [], {
  spawnEngine: false,
  skipPreflight: true,
});
assert.equal(sendResult.ok, true, `turn must start: ${JSON.stringify(sendResult)}`);
assert.equal(runner.sentPayloads.length, 1, "first send reaches the engine");
flushEvents();

runner.failWithLeakedToolCall();
await settle();
const events = flushEvents();

const failed = events.find((event) => event.type === "turn.failed");
assert(failed, "the leaked-tool-call turn still fails visibly first");
assert.equal(failed.payload.errorCode, "MALFORMED_TOOL_CALL_TEXT");

const retryEvent = events.find((event) => event.type === "turn.self_heal_retry");
assert(retryEvent, "rescue announces the silent retry");
assert.equal(retryEvent.payload.kind, "tool_call_rescue", "the retry is marked as a rescue, not a config heal");

assert.equal(runner.sentPayloads.length, 2, "rescue dispatches exactly one retry");
const retryPayload = JSON.stringify(runner.sentPayloads[1]);
assert.match(retryPayload, /\[system correction\]/, "the corrective hint rides the engine-facing text");
assert.match(retryPayload, /NATIVE structured tool\/function call/, "the hint teaches the native tool-call rule");
const userMessages = messages.filter((m) => m.role === "user");
assert.equal(userMessages.length, 1, "the visible transcript gains no duplicate user message");
assert.equal(selfHealCalls.length, 0,
  "rescue must NOT burn the self-heal probe cooldown — a deterministic defect needs the probe fresh on the second failure");

// --- cooldown: an immediate second failure falls back to the self-heal path --

runner.failWithLeakedToolCall();
await settle();
const secondEvents = flushEvents();
assert(secondEvents.some((event) => event.type === "turn.failed"), "the rescued retry may still fail");
assert.equal(
  secondEvents.filter((event) => event.type === "turn.self_heal_retry").length,
  0,
  "cooldown prevents a rescue loop (self-heal stub does not heal → no retry either)",
);
assert.equal(runner.sentPayloads.length, 2, "no additional retry is dispatched during cooldown");
assert.equal(selfHealCalls.length, 1, "the second failure takes the untouched probe→heal recovery path");

// --- kill switch --------------------------------------------------------------

resetRescueStateForTests();
process.env.LILY_TOOL_CALL_RESCUE = "0";
try {
  const again = await ctx.turnOrchestrator.sendUserMessage("s1", "try tools again", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(again.ok, true);
  flushEvents();
  // Single-marker <tool_call> JSON leak: previously evaded classification when
  // normalized.text + state.assistantText carried the same duplicated fragment.
  const singleMarker = '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>';
  ctx.turnOrchestrator.ingest("s1", [{ type: "assistant.delta", payload: { text: singleMarker } }]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: singleMarker });
  await settle();
  const killedEvents = flushEvents();
  const killedFailure = killedEvents.find((event) => event.type === "turn.failed");
  assert(killedFailure, "single-marker tool_call leaks must still classify as a failure");
  assert.equal(killedFailure.payload.errorCode, "MALFORMED_TOOL_CALL_TEXT",
    "per-candidate leak detection catches the duplicated single-marker fragment");
  assert.equal(
    killedEvents.filter((event) => event.type === "turn.self_heal_retry").length,
    0,
    "kill switch disables rescue entirely",
  );
  assert.equal(runner.sentPayloads.length, 3, "no rescue retry beyond the explicit user send");
  assert.doesNotMatch(JSON.stringify(runner.sentPayloads[2]), /\[system correction\]/,
    "explicit sends never carry the corrective hint");
} finally {
  delete process.env.LILY_TOOL_CALL_RESCUE;
}

// --- empty-completion flake: plain retry, no corrective hint ------------------

resetRescueStateForTests();
const healCallsBefore = selfHealCalls.length;
{
  const emptySend = await ctx.turnOrchestrator.sendUserMessage("s1", "say hi", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(emptySend.ok, true);
  flushEvents();
  const payloadsBefore = runner.sentPayloads.length;
  runner.busy = false;
  runner.emit("done", { code: 0, output: "" });
  await settle();
  const emptyEvents = flushEvents();
  const emptyFailed = emptyEvents.find((event) => event.type === "turn.failed");
  assert.equal(emptyFailed?.payload?.errorCode, "EMPTY_ASSISTANT_COMPLETION");
  const emptyRetry = emptyEvents.find((event) => event.type === "turn.self_heal_retry");
  assert(emptyRetry, "an empty completion with no tool activity gets a fast plain retry");
  assert.equal(emptyRetry.payload.kind, "empty_completion_retry", "the retry is marked as a flake retry");
  assert.equal(runner.sentPayloads.length, payloadsBefore + 1, "one plain retry is dispatched");
  assert.doesNotMatch(JSON.stringify(runner.sentPayloads.at(-1)), /\[system correction\]/,
    "the flake retry carries NO corrective hint — the message is resent as-is");
  assert.equal(selfHealCalls.length, healCallsBefore, "the flake retry must not touch the probe cooldown");
}

// --- side-effect guard: a turn that ran tools is never auto-replayed ----------

{
  // Settle the retried turn from the flake test while its cooldown is still
  // active (fails EMPTY again → no further retry), THEN reset cooldowns so the
  // guard below is what blocks the rescue — not the cooldown.
  runner.busy = false;
  runner.emit("done", { code: 0, output: "" });
  await settle();
  flushEvents();
  resetRescueStateForTests();
  const payloadsBefore = runner.sentPayloads.length;

  const toolTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "send the mail", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(toolTurn.ok, true);
  ctx.turnOrchestrator.ingest("s1", [
    { type: "tool.started", payload: { id: "t1", name: "mail_send", input: {} } },
    { type: "tool.done", payload: { id: "t1", status: "done", result: "sent" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "" });
  await settle();
  const guardedEvents = flushEvents();
  assert(guardedEvents.some((event) => event.type === "turn.failed"), "the tool-running empty turn still fails");
  assert.equal(
    guardedEvents.filter((event) => event.type === "turn.self_heal_retry").length,
    0,
    "a turn that executed tools is never auto-replayed (side-effect guard)",
  );
  assert.equal(runner.sentPayloads.length, payloadsBefore + 1,
    "only the explicit user send reaches the engine — no rescue retry");
}

// --- mid-turn stream truncation: fails + retries when tools were read-only ----

resetRescueStateForTests();
{
  const payloadsBefore = runner.sentPayloads.length;
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "做一个漂亮的登录页面", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  ctx.turnOrchestrator.ingest("s1", [
    { type: "tool.started", payload: { id: "g1", name: "glob", input: { pattern: "**/*" } } },
    { type: "tool.done", payload: { id: "g1", status: "done" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "tool-calls" } },
    { type: "tool.started", payload: { id: "r1", name: "read", input: { filePath: "/x/layout.html" } } },
    { type: "tool.done", payload: { id: "r1", status: "done" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "tool-calls" } },
    { type: "assistant.delta", payload: { text: "让我查看一下这些文件，然后创建登录页面。" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "unknown" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "让我查看一下这些文件，然后创建登录页面。" });
  await settle();
  const events = flushEvents();
  const failed = events.find((event) => event.type === "turn.failed");
  assert(failed, "an unknown final finish reason after recognized ones must fail the turn, not complete it");
  assert.equal(failed.payload.errorCode, "TRUNCATED_TURN_END");
  const retry = events.find((event) => event.type === "turn.self_heal_retry");
  assert(retry, "a truncated turn with only read-only tools gets a silent retry");
  assert.equal(retry.payload.kind, "truncated_turn_retry");
  // The rescue resend is issued only AFTER the async finalize completes (so
  // its send never races phase "finalizing"); let that settle before counting.
  await settle();
  assert.equal(runner.sentPayloads.length, payloadsBefore + 2, "explicit send + one rescue retry");
}

// Negative: the SAME truncation after a mutating tool fails visibly, no replay.
resetRescueStateForTests();
{
  runner.busy = false;
  runner.emit("done", { code: 0, output: "ok" }); // settle the retried turn (stop reasons were reset with the new turn)
  await settle();
  flushEvents();
  const payloadsBefore = runner.sentPayloads.length;
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "改完文件后继续", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  ctx.turnOrchestrator.ingest("s1", [
    { type: "tool.started", payload: { id: "w1", name: "write", input: { filePath: "/x/login.html" } } },
    { type: "tool.done", payload: { id: "w1", status: "done" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "tool-calls" } },
    { type: "assistant.delta", payload: { text: "接下来我会继续完善样式。" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "unknown" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "接下来我会继续完善样式。" });
  await settle();
  const events = flushEvents();
  const failed = events.find((event) => event.type === "turn.failed");
  assert.equal(failed?.payload?.errorCode, "TRUNCATED_TURN_END", "truncation is still surfaced honestly");
  assert.equal(events.filter((event) => event.type === "turn.self_heal_retry").length, 0,
    "a turn that wrote files is never auto-replayed even when truncated");
  assert.equal(runner.sentPayloads.length, payloadsBefore + 1, "no rescue retry after mutating tools");
}

// Negative: even a SUCCESSFUL heal (profile changed) must not replay a turn
// that ran mutating tools — the field bug: self-heal retried a write turn.
resetRescueStateForTests();
{
  selfHealShouldHeal = true;
  const payloadsBefore = runner.sentPayloads.length;
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "写完文件后被截断的任务", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  ctx.turnOrchestrator.ingest("s1", [
    { type: "tool.started", payload: { id: "w2", name: "write", input: { filePath: "/x/out.html" } } },
    { type: "tool.done", payload: { id: "w2", status: "done" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "tool-calls" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "unknown" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "让我继续。" });
  await settle();
  const events = flushEvents();
  assert.equal(events.find((event) => event.type === "turn.failed")?.payload?.errorCode, "TRUNCATED_TURN_END");
  assert.equal(events.filter((event) => event.type === "turn.self_heal_retry").length, 0,
    "a healed profile must NOT auto-replay a turn that wrote files");
  assert.equal(runner.sentPayloads.length, payloadsBefore + 1, "no heal retry after mutating tools");
  selfHealShouldHeal = false;
}

// Micro-completion: a sentence-tail fragment as the whole answer (gateway
// thinking-mode glitch) fails + gets a plain retry; a real short answer with
// sentence-final punctuation is untouched.
resetRescueStateForTests();
{
  const payloadsBefore = runner.sentPayloads.length;
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "给我设计一个复杂的任务", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  const fragment = " file paths, and a single research question";
  ctx.turnOrchestrator.ingest("s1", [
    { type: "assistant.delta", payload: { text: fragment } },
    { type: "usage.updated", payload: { usage: { output_tokens: 9 }, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: fragment });
  await settle();
  const events = flushEvents();
  const failed = events.find((event) => event.type === "turn.failed");
  assert.equal(failed?.payload?.errorCode, "MICRO_COMPLETION",
    "a 9-token mid-sentence fragment on a non-trivial ask is a failure, not an answer");
  const retry = events.find((event) => event.type === "turn.self_heal_retry");
  assert.equal(retry?.payload?.kind, "micro_completion_retry", "the fragment gets a plain retry");
  assert.equal(runner.sentPayloads.length, payloadsBefore + 2, "explicit send + one rescue retry");

  // Settle the retried turn with a real answer (ends like a sentence).
  ctx.turnOrchestrator.ingest("s1", [
    { type: "assistant.delta", payload: { text: "这是一个完整的任务设计方案。" } },
    { type: "usage.updated", payload: { usage: { output_tokens: 380 }, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "这是一个完整的任务设计方案。" });
  await settle();
  assert(flushEvents().some((event) => event.type === "turn.completed"), "the retried turn completes normally");
}

{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "帮我确认一下这个方案可以吗", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  ctx.turnOrchestrator.ingest("s1", [
    { type: "assistant.delta", payload: { text: "可以。" } },
    { type: "usage.updated", payload: { usage: { output_tokens: 3 }, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "可以。" });
  await settle();
  const events = flushEvents();
  assert(events.some((event) => event.type === "turn.completed"),
    "a genuinely short answer ending like a sentence stays a normal completion");
  assert.equal(events.filter((event) => event.type === "turn.failed").length, 0);
}

// Field case 2: leaked CODE fragment from an earlier task as the answer to a
// trivial greeting — 18 tokens, so the tiny-token branch alone would miss it;
// the code-shape signature catches it.
resetRescueStateForTests();
{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "hi", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  const leakedCode = "paragraphs.push(p2('7.4 在线学习生态'));\\nparagraph";
  ctx.turnOrchestrator.ingest("s1", [
    { type: "assistant.delta", payload: { text: leakedCode } },
    { type: "usage.updated", payload: { usage: { output_tokens: 18 }, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: leakedCode });
  await settle();
  const events = flushEvents();
  assert.equal(events.find((event) => event.type === "turn.failed")?.payload?.errorCode, "MICRO_COMPLETION",
    "a code fragment leaked as the whole answer is a failure even on a trivial ask");
  assert.equal(events.find((event) => event.type === "turn.self_heal_retry")?.payload?.kind, "micro_completion_retry");
  // Settle the retry with a normal greeting.
  ctx.turnOrchestrator.ingest("s1", [
    { type: "assistant.delta", payload: { text: "你好！有什么可以帮你？" } },
    { type: "usage.updated", payload: { usage: { output_tokens: 12 }, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "你好！有什么可以帮你？" });
  await settle();
  flushEvents();
}

// Field case 3: the model echoes a fragment of OUR OWN system guide as the
// answer to "你好" — "ily-csv-conversion (CSV 转换)**", 11 tokens. It slipped
// every earlier signature (not code-shaped, no comma, ask under 8 chars); the
// dangling ** and the unprompted lily- namespace are the new evidence.
resetRescueStateForTests();
{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "你好", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  const leakedGuide = "ily-csv-conversion (CSV 转换)**";
  ctx.turnOrchestrator.ingest("s1", [
    { type: "assistant.delta", payload: { text: leakedGuide } },
    { type: "usage.updated", payload: { usage: { output_tokens: 11 }, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: leakedGuide });
  await settle();
  const events = flushEvents();
  assert.equal(events.find((event) => event.type === "turn.failed")?.payload?.errorCode, "MICRO_COMPLETION",
    "a system-guide echo fragment (dangling ** / unprompted skill namespace) is a failure, not an answer");
  assert.equal(events.find((event) => event.type === "turn.self_heal_retry")?.payload?.kind, "micro_completion_retry");
  ctx.turnOrchestrator.ingest("s1", [
    { type: "assistant.delta", payload: { text: "你好！有什么可以帮你？" } },
    { type: "usage.updated", payload: { usage: { output_tokens: 12 }, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "你好！有什么可以帮你？" });
  await settle();
  flushEvents();
}

// Rescue-chain guard + user-resend fairness ("小模型自动修复没有了吗" field case):
// a failed rescue turn never chains into a second rescue and its failure
// message SAYS a retry already happened; a fresh manual resend afterwards
// gets a fresh rescue instead of being punished by a long cooldown.
resetRescueStateForTests();
{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "你好", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  flushEvents();
  const payloadsBefore = runner.sentPayloads.length;
  runner.busy = false;
  runner.emit("done", { code: 0, output: "" });
  await settle();
  assert(flushEvents().some((e) => e.type === "turn.self_heal_retry"), "first empty failure gets the silent rescue");
  // The rescue retry fails the same way — no second rescue, and the visible
  // failure admits the auto-retry already ran.
  runner.busy = false;
  runner.emit("done", { code: 0, output: "" });
  await settle();
  const chainEvents = flushEvents();
  assert.equal(chainEvents.filter((e) => e.type === "turn.self_heal_retry").length, 0,
    "a failed rescue turn never chains into another rescue");
  const chainFailed = chainEvents.find((e) => e.type === "turn.failed");
  assert.match(String(chainFailed?.payload?.assistant || ""), /已自动修复重试 1 次/,
    "the second failure tells the user the platform already retried");
  assert.equal(runner.sentPayloads.length, payloadsBefore + 1, "exactly one rescue dispatch");

  // Manual resend after the debounce window: rescue fires again for the
  // user's own action (the old 5-minute cooldown left this naked).
  resetRescueStateForTests();
  const resend = await ctx.turnOrchestrator.sendUserMessage("s1", "你好", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(resend.ok, true);
  flushEvents();
  runner.busy = false;
  runner.emit("done", { code: 0, output: "" });
  await settle();
  assert(flushEvents().some((e) => e.type === "turn.self_heal_retry"),
    "a fresh user resend gets a fresh rescue");
  // Settle the retried turn cleanly.
  ctx.turnOrchestrator.ingest("s1", [
    { type: "assistant.delta", payload: { text: "你好！有什么可以帮你？" } },
    { type: "usage.updated", payload: { usage: { output_tokens: 12 }, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "你好！有什么可以帮你？" });
  await settle();
  flushEvents();
}

// Model-connection auto-repair chain (2026-07-21 directive): while the episode
// budget lasts, connection-class failures keep earning silent rescues (engine
// recycle + env hot-refresh) — the user only ever sees anything after the
// platform exhausted its attempts, and that copy admits the real count.
process.env.LILY_RESCUE_DELAY_MS = "10";
resetRescueStateForTests();
{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "你好", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  flushEvents();
  const fail502 = async () => {
    runner.busy = false;
    runner.emit("done", { code: 1, error: "API Error: 502 bad gateway", output: "" });
    await settle();
  };
  await fail502();
  let events = flushEvents();
  assert.equal(events.find((e) => e.type === "turn.failed")?.payload?.errorCode, "MODEL_CONNECTION_FAILED",
    "a gateway 502 classifies as a connection failure");
  assert.equal(events.find((e) => e.type === "turn.self_heal_retry")?.payload?.kind, "model_connection_retry",
    "first connection failure gets a silent connection rescue");
  await fail502();
  events = flushEvents();
  assert.equal(events.filter((e) => e.type === "turn.self_heal_retry").length, 1,
    "multi-attempt budget allows the rescue to chain (attempt 2)");
  await fail502();
  events = flushEvents();
  assert.equal(events.filter((e) => e.type === "turn.self_heal_retry").length, 1,
    "multi-attempt budget allows the rescue to chain (attempt 3)");
  await fail502();
  events = flushEvents();
  assert.equal(events.filter((e) => e.type === "turn.self_heal_retry").length, 0,
    "budget exhausted — no fourth rescue");
  const finalFailure = events.find((e) => e.type === "turn.failed");
  assert.match(String(finalFailure?.payload?.assistant || ""), /已自动修复重试 3 次/,
    "the terminal copy admits the real attempt count");
  assert.doesNotMatch(String(finalFailure?.payload?.assistant || ""), /check your|请检查/,
    "the terminal copy never blames the user's network or settings");
}
delete process.env.LILY_RESCUE_DELAY_MS;

// Safety: a punctuation-less CJK greeting to a trivial ask has NO fragment
// signature — it completes normally (no hidden retry, no failure).
{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "hello", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  ctx.turnOrchestrator.ingest("s1", [
    { type: "assistant.delta", payload: { text: "你好" } },
    { type: "usage.updated", payload: { usage: { output_tokens: 2 }, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "你好" });
  await settle();
  const events = flushEvents();
  assert(events.some((event) => event.type === "turn.completed"),
    "a bare CJK greeting to a trivial ask completes normally");
  assert.equal(events.filter((event) => event.type === "turn.failed").length, 0);
}

// Negative: a clean "stop" final reason completes normally — no false positive.
{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "总结一下刚才做了什么", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  ctx.turnOrchestrator.ingest("s1", [
    { type: "tool.started", payload: { id: "r2", name: "read", input: { filePath: "/x/login.html" } } },
    { type: "tool.done", payload: { id: "r2", status: "done" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "tool-calls" } },
    { type: "assistant.delta", payload: { text: "已完成登录页面的创建。" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "stop" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "已完成登录页面的创建。" });
  await settle();
  const events = flushEvents();
  assert(events.some((event) => event.type === "turn.completed"), "a clean stop still completes normally");
  assert.equal(events.filter((event) => event.type === "turn.failed").length, 0);
}

// Negative: a gateway that NEVER emits recognized reasons is left alone.
{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "回答一个小问题", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  ctx.turnOrchestrator.ingest("s1", [
    { type: "tool.started", payload: { id: "r3", name: "read", input: { filePath: "/x/a.txt" } } },
    { type: "tool.done", payload: { id: "r3", status: "done" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "unknown" } },
    { type: "assistant.delta", payload: { text: "答案在文件里。" } },
    { type: "usage.updated", payload: { usage: {}, stopReason: "unknown" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "答案在文件里。" });
  await settle();
  const events = flushEvents();
  assert(events.some((event) => event.type === "turn.completed"),
    "all-unknown gateways never trip the truncation guard (no recognized-reason evidence)");
}

// RUNNER_TERMINATED strategy: a recycled runner is gone from the pool, so its
// rescue MUST run the full preflight (skipPreflight would pool.get() -> null
// and the silent retry would die as RUNNER_ERROR).
{
  const rescue = require("../src/main/tool-call-rescue.js");
  const strategy = rescue.rescueStrategyFor("RUNNER_TERMINATED");
  assert(strategy, "recycled-runner failures are rescuable");
  assert.equal(strategy.kind, "runner_terminated_retry");
  assert.equal(strategy.preflight, true, "the resend needs the full ensure path to build a fresh runner");
  const others = ["MALFORMED_TOOL_CALL_TEXT", "EMPTY_ASSISTANT_COMPLETION", "TRUNCATED_TURN_END", "MICRO_COMPLETION"];
  for (const code of others) {
    assert(!rescue.rescueStrategyFor(code)?.preflight, `${code} keeps skipping preflight (its runner is proven alive)`);
  }
  // Empty completions recycle the idle engine before retrying: same-process
  // retries ride the same poisoned keep-alive socket during gateway backend
  // swaps (field: engine 100% empty while fresh connections were 100% ok).
  assert.equal(rescue.rescueStrategyFor("EMPTY_ASSISTANT_COMPLETION")?.recycleEngine, true,
    "empty-completion rescue gets fresh gateway connections");

  // Engine start failures wait out the transient cause then resend with full
  // preflight ("这种不能等恢复重试吗" — yes, it can).
  const startRetry = rescue.rescueStrategyFor("RUNNER_ERROR");
  assert(startRetry, "engine-start failures are rescuable");
  assert.equal(startRetry.kind, "runner_start_retry");
  assert.equal(startRetry.preflight, true, "the resend rebuilds a fresh runner via full preflight");
  assert(startRetry.delayMs >= 1000, "the retry waits for the transient start failure to clear");
}

console.log("tool-call-rescue: ok");
