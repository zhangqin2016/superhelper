#!/usr/bin/env node

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-turn-orchestrator-"));

async function waitFor(predicate, { timeoutMs = 1_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return Boolean(predicate());
}

process.env.LILY_USER_DATA_DIR = tempUserData;
// Turn rescue would silently retry the synthetic empty/malformed failures this
// harness uses to exercise failure paths, occupying the runner and queueing
// later sends. Rescue has its own closed loop in test-tool-call-rescue.mjs.
process.env.LILY_TOOL_CALL_RESCUE = "0";
process.env.LILY_EMPTY_COMPLETION_RETRY = "0";
process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY = "0";
process.env.LILY_MODEL_CONNECTION_RETRY = "0";
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));
const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");
const {
  clearSessionSummary,
  markSessionCompacted,
  readSessionSummary,
  updateSessionSummaryFromRecord,
} = require("../src/main/session-memory.js");
const { appendLearnedConvention } = require("../src/main/learned-context.js");
const { listMemoryProposals } = require("../src/main/auto-memory-proposals.js");

class FakeRunner extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.busy = false;
    this.sentPayloads = [];
    this.compactions = [];
    this.compactResult = { ok: true };
    this.spawnOptions = {};
  }
  isBusy() {
    return this.busy;
  }
  isAlive() {
    return true;
  }
  sendUserMessage(payload) {
    if (this.busy) return false;
    this.busy = true;
    this.sentPayloads.push(payload);
    this.emit("status", "thinking");
    return true;
  }
  finish(text = "done") {
    ctx.turnOrchestrator.ingest(this.sessionId, [{ type: "assistant.delta", payload: { text } }]);
    this.busy = false;
    this.emit("done", { code: 0, output: text });
  }
  respondPermission() {
    return true;
  }
  respondUserQuestion() {
    return true;
  }
  respondHook() {
    return true;
  }
  interrupt() {
    this.busy = false;
  }
  compactContext(body) {
    this.compactions.push(body);
    return Promise.resolve(this.compactResult);
  }
  diagnostics() {
    return {
      sessionId: this.sessionId,
      busy: this.busy,
      modelRoute: this.spawnOptions.modelRouteAudit || null,
    };
  }
}

const sent = [];
const runtimeDiagnosticReports = [];
const serviceClientPath = require.resolve("../src/main/service-client.js");
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    reportUsage: async () => ({ ok: true }),
    reportRuntimeDiagnostic: async (payload) => {
      runtimeDiagnosticReports.push(payload);
      return { ok: true, json: { id: "diag_test" } };
    },
  },
};
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  },
};

const messages = [];
const session = { id: "s1", projectId: "p1", messages };
const otherSession = { id: "s2", projectId: "p1", messages: [] };
const runner = new FakeRunner("s1");
const otherRunner = new FakeRunner("s2");
runner.spawnOptions.modelRouteAudit = { route: "gateway", provider: "deepseek", model: "deepseek-v4-pro[1m]" };
const terminatedSessions = [];
const clearedResumeSessions = [];
const completedQueuedRuns = [];
const startedScheduledRuns = [];
const durableTurns = new Map();
const testOwnerScope = "profile:test-turn-orchestrator";
const otherTestOwnerScope = "profile:test-turn-orchestrator-b";
let activeTestOwnerScope = testOwnerScope;
const dispatchClaims = [];
const terminalClaims = [];
function hydrateTestTurn(sessionId, input, queueRecovery = null) {
  const external = queueRecovery?.options?.externalCommand || null;
  return {
    sessionId,
    admittedSeq: durableTurns.size + 1,
    turnId: input.turnId,
    delivery: input.delivery || "queue",
    status: "admitted",
    userText: input.userText || "",
    files: input.files || [],
    metadata: {
      ...(input.metadata || {}),
      ...(queueRecovery ? { queueRecovery } : {}),
    },
    ownerScope: activeTestOwnerScope,
    dispatchAttemptId: null,
    externalCommandId: external?.commandId || null,
    externalIdempotencyKey: external?.idempotencyKey || null,
    externalPayloadHash: external?.payloadHash || null,
    externalDesktopDeviceId: external?.desktopDeviceId || null,
    externalMobileDeviceId: external?.mobileDeviceId || null,
  };
}
function admitTestTurn(sessionId, input, queueRecovery = null) {
  const turn = hydrateTestTurn(sessionId, input, queueRecovery);
  durableTurns.set(turn.turnId, turn);
  return turn;
}
const ctx = {
  get mainWindow() {
    return fakeWindow;
  },
  eventBus: new RuntimeEventBus(() => fakeWindow),
  sessionManager: {
    findById: (id) => (id === "s1" ? session : id === "s2" ? otherSession : null),
    getActive: () => session,
    pushMessageTo: (_sessionId, role, content, files, extra) => {
      messages.push({ role, content, files, ...extra });
    },
    popLastAssistantMessage: () => false,
    getLastUserMessage: () => messages.find((m) => m.role === "user") || null,
    findAgentResumeOwner: (agentResumeId) => (agentResumeId === "ses_live_owner" ? otherSession : null),
    setAgentResumeId: () => {},
    claimAgentResumeId: (_sessionId, agentResumeId) => ({
      ok: true,
      evictedSessionIds: agentResumeId === "ses_shared" ? ["s2"] : [],
    }),
    clearAgentResumeId: (sessionId) => {
      clearedResumeSessions.push(sessionId);
      return true;
    },
    resolveTurnOwnerScope: () => ({
      ok: true,
      error: null,
      ownerScope: activeTestOwnerScope,
    }),
    admitTurnInput: (sessionId, input) => admitTestTurn(sessionId, input),
    admitTurnInputFromSource: (sessionId, input) => (
      admitTestTurn(sessionId, input)
    ),
    admitQueuedTurnInput: (sessionId, input, queueRecovery) => {
      const identity = queueRecovery?.options?.externalCommand;
      const existing = identity
        ? [...durableTurns.values()].find((turn) => (
            turn.externalDesktopDeviceId === identity.desktopDeviceId
            && turn.externalMobileDeviceId === identity.mobileDeviceId
            && turn.externalIdempotencyKey === identity.idempotencyKey
          ))
        : null;
      if (existing) {
        if (existing.externalPayloadHash !== identity.payloadHash) {
          return {
            ok: false,
            error: "IDEMPOTENCY_CONFLICT",
            inserted: false,
            duplicate: true,
            turn: existing,
          };
        }
        return {
          ok: true,
          inserted: false,
          duplicate: true,
          turn: existing,
        };
      }
      const turn = admitTestTurn(sessionId, input, queueRecovery);
      return { ok: true, inserted: true, duplicate: false, turn };
    },
    claimTurnInputDispatch: (sessionId, turnId, claim) => {
      dispatchClaims.push({ sessionId, turnId, claim });
      const turn = durableTurns.get(turnId);
      if (
        !turn
        || turn.sessionId !== sessionId
        || turn.ownerScope !== claim.ownerScope
        || turn.status !== "admitted"
      ) return { ok: false, reason: "STATUS", turn: turn || null };
      const claimed = {
        ...turn,
        status: "dispatching",
        dispatchAttemptId: claim.attemptId,
        dispatchStartedAt: claim.startedAt || Date.now(),
      };
      durableTurns.set(turnId, claimed);
      return { ok: true, attemptId: claim.attemptId, turn: claimed };
    },
    markTurnInputPromoted: (turnId, patch) => {
      const turn = durableTurns.get(turnId);
      if (!turn || turn.dispatchAttemptId !== patch.dispatchAttemptId) return null;
      const promoted = {
        ...turn,
        status: patch.status === "accepted" ? "accepted" : "promoted",
        acceptedAt: patch.acceptedAt || Date.now(),
      };
      durableTurns.set(turnId, promoted);
      return promoted;
    },
    markTurnInputTerminal: (claim, terminalType, patch = {}) => {
      terminalClaims.push({ claim, terminalType, patch });
      const turn = durableTurns.get(claim.turnId);
      if (!turn || turn.ownerScope !== claim.ownerScope) {
        return { ok: false, reason: "NOT_FOUND", turn: null };
      }
      const terminal = {
        ...turn,
        status: terminalType === "turn.completed"
          ? "completed"
          : terminalType === "turn.interrupted"
            ? "interrupted"
            : "failed",
        terminalType,
        terminalAt: Date.now(),
      };
      durableTurns.set(turn.turnId, terminal);
      return { ok: true, turn: terminal };
    },
    pendingTurnInputs: (sessionId) => (
      [...durableTurns.values()].filter((turn) => (
        turn.sessionId === sessionId
        && turn.ownerScope === activeTestOwnerScope
        && turn.status === "admitted"
        && turn.delivery === "queue"
        && turn.metadata?.queueRecovery
      ))
    ),
    outcomeUnknownTurnInputs: () => [],
    getTurnInputByTurnId: (_sessionId, turnId) => (
      durableTurns.get(turnId) || null
    ),
    findTurnInputByExternalIdentity: (_sessionId, identity) => (
      [...durableTurns.values()].find((turn) => (
        turn.externalDesktopDeviceId === identity.desktopDeviceId
        && turn.externalMobileDeviceId === identity.mobileDeviceId
        && turn.externalIdempotencyKey === identity.idempotencyKey
      )) || null
    ),
  },
  projectManager: {
    find: () => ({ id: "p1", path: process.cwd() }),
  },
  runnerPool: {
    get: (sessionId) => (sessionId === "s2" ? otherRunner : runner),
    ensure: () => runner,
    terminateSession: (sessionId) => {
      terminatedSessions.push(sessionId);
    },
    getSessionIds: () => ["s1"],
  },
  scheduledTaskManager: {
    canStartRun: () => true,
    markRunStarted: (runId, turnId, dispatchAttemptId, dispatchStartedAt) => {
      startedScheduledRuns.push({
        runId,
        turnId,
        dispatchAttemptId,
        dispatchStartedAt,
      });
      return true;
    },
    completeQueuedRun: (runId, terminalType, payload) => {
      completedQueuedRuns.push({ runId, terminalType, payload });
      return true;
    },
  },
};
ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
ctx.turnArchive = new TurnArchive(ctx.sessionManager, { eventBus: ctx.eventBus });
ctx.turnOrchestrator = new TurnOrchestrator(ctx);
ctx.turnOrchestrator.bindRunner(runner);
ctx.turnOrchestrator.bindRunner(otherRunner);

// Local assistant completion must use the active turn id directly. A previous
// refactor accidentally referenced an out-of-scope `snapshot` variable here,
// which failed after durable admission and stranded the turn in `starting`.
const localAssistantResult = await ctx.turnOrchestrator.completeLocalAssistantTurn(
  "s1",
  "local assistant input",
  [],
  { assistant: "local assistant result" },
);
if (!localAssistantResult.ok || !localAssistantResult.turnId) {
  throw new Error(`local assistant turn must complete: ${JSON.stringify(localAssistantResult)}`);
}
await new Promise((resolve) => setTimeout(resolve, 0));
if (ctx.turnOrchestrator._state("s1").phase !== "idle") {
  throw new Error("local assistant completion must leave the session idle");
}

runner.emit("agent-resume-id", "ses_shared");
if (!terminatedSessions.includes("s2")) {
  throw new Error(`claiming an engine session must terminate evicted runner owners: ${JSON.stringify(terminatedSessions)}`);
}
if (sent.some((entry) => entry.payload?.sessionId === "s2")) {
  throw new Error(`engine session ownership repair must stay invisible to evicted sessions: ${JSON.stringify(sent)}`);
}
terminatedSessions.length = 0;
sent.length = 0;

runner.emit("agent-resume-id", "ses_live_owner");
if (!terminatedSessions.includes("s1") || terminatedSessions.includes("s2")) {
  throw new Error(`a duplicate claimant must not evict the live existing owner: ${JSON.stringify(terminatedSessions)}`);
}
if (sent.some((entry) => entry.payload?.events?.some((event) => event.type === "session.hydrated"))) {
  throw new Error(`rejected duplicate claimant must not publish hydration events: ${JSON.stringify(sent)}`);
}
terminatedSessions.length = 0;
sent.length = 0;

ctx.turnOrchestrator.ingest("s1", [{
  type: "tool.started",
  payload: { id: "orphan_tool", name: "Bash", input: {} },
}]);
ctx.eventBus.flush();
let allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (allEvents.some((event) => event.type === "engine.warning")) {
  throw new Error("orphan tool event should be dropped silently without user-visible warning");
}
sent.length = 0;

const invalidatedTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "continue poisoned old chat", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!invalidatedTurn.ok || !runner.isBusy()) {
  throw new Error(`invalidated turn should start before runner failure: ${JSON.stringify(invalidatedTurn)}`);
}
runner.emit("engine-session-invalidated", {
  resetResume: true,
  errorCode: "MODEL_CONNECTION_FAILED",
  reason: "Connection to the model service was interrupted.",
});
runner.busy = false;
runner.emit("error", "API Error: upstream socket closed while streaming token sk-testsecret123456789");
await new Promise((resolve) => setTimeout(resolve, 0));
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
const invalidatedTerminal = allEvents.find((event) => (
  event.turnId === invalidatedTurn.turnId
  && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type)
));
if (invalidatedTerminal?.type !== "turn.failed" || invalidatedTerminal.payload?.errorCode !== "MODEL_CONNECTION_FAILED") {
  throw new Error(`invalidated recoverable model failure should still finish the visible turn: ${JSON.stringify(invalidatedTerminal)}`);
}
if (!clearedResumeSessions.includes("s1") || !terminatedSessions.includes("s1")) {
  throw new Error(`engine invalidation must clear resume and terminate this runner: cleared=${JSON.stringify(clearedResumeSessions)} terminated=${JSON.stringify(terminatedSessions)}`);
}
const modelFailureReport = runtimeDiagnosticReports.find((report) => report.normalizedKind === "MODEL_CONNECTION_FAILED");
if (!modelFailureReport || modelFailureReport.eventSubtype !== "model_connection_failed") {
  throw new Error(`model connection failure should upload runtime diagnostics: ${JSON.stringify(runtimeDiagnosticReports)}`);
}
if (JSON.stringify(modelFailureReport).includes("sk-testsecret123456789")) {
  throw new Error(`runtime diagnostics must redact model secrets: ${JSON.stringify(modelFailureReport)}`);
}
if (modelFailureReport.trace?.modelRoute?.route !== "gateway") {
  throw new Error(`runtime diagnostics should include the effective model route: ${JSON.stringify(modelFailureReport)}`);
}
runtimeDiagnosticReports.length = 0;
clearedResumeSessions.length = 0;
terminatedSessions.length = 0;
sent.length = 0;
messages.length = 0;

const scheduledDraft = {
  status: "pending",
  originalText: "please create a schedule every hour. say hello",
  draft: {
    title: "Say hello",
    prompt: "say hello",
    scheduleText: "Every hour on the hour",
    rrule: "FREQ=HOURLY;INTERVAL=1",
  },
};
const localTurn = await ctx.turnOrchestrator.completeLocalAssistantTurn(
  "s2",
  scheduledDraft.originalText,
  [],
  {
    assistant: "I understand this as an automated task. Please confirm to create it.",
    scheduledDraft,
  },
);
if (!localTurn.ok || !localTurn.localAssistant) {
  throw new Error(`local assistant turn failed: ${JSON.stringify(localTurn)}`);
}
if (otherRunner.sentPayloads.length !== 0) {
  throw new Error("local assistant turn must not send anything to the runtime runner");
}
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
const localTerminal = allEvents.find((event) => event.sessionId === "s2" && event.type === "turn.completed");
if (localTerminal?.payload?.record?.meta?.scheduledDraft?.draft?.rrule !== scheduledDraft.draft.rrule) {
  throw new Error(`local scheduled draft must survive through turn archive: ${JSON.stringify(localTerminal)}`);
}
const localFinal = allEvents.find((event) => event.sessionId === "s2" && event.type === "assistant.final");
if (localFinal?.payload?.scheduledDraft?.draft?.rrule !== scheduledDraft.draft.rrule) {
  throw new Error(`local scheduled draft must be present on assistant.final: ${JSON.stringify(localFinal)}`);
}
const localAssistant = messages.find((message) => message.role === "assistant" && message.turnId === localTurn.turnId);
if (localAssistant?.meta?.scheduledDraft?.draft?.title !== "Say hello") {
  throw new Error(`local scheduled draft must be committed as assistant metadata: ${JSON.stringify(messages)}`);
}
sent.length = 0;
messages.length = 0;
otherSession.messages.length = 0;
otherRunner.sentPayloads.length = 0;

const runningBeforeLocalDraft = await ctx.turnOrchestrator.sendUserMessage("s2", "existing work", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!runningBeforeLocalDraft.ok || !otherRunner.isBusy()) {
  throw new Error(`s2 should have an active runtime turn before local draft queueing: ${JSON.stringify(runningBeforeLocalDraft)}`);
}
const queuedLocalDraft = await ctx.turnOrchestrator.completeLocalAssistantTurn(
  "s2",
  scheduledDraft.originalText,
  [],
  {
    assistant: "I understand this as an automated task. Please confirm to create it.",
    scheduledDraft,
  },
);
if (!queuedLocalDraft.queued || !queuedLocalDraft.itemId) {
  throw new Error(`local assistant draft must queue behind an active turn: ${JSON.stringify(queuedLocalDraft)}`);
}
if (otherRunner.sentPayloads.length !== 1) {
  throw new Error("queued local assistant draft must not send a second runtime prompt");
}
otherRunner.finish("existing work done");
await new Promise((resolve) => setTimeout(resolve, 0));
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
const queuedLocalStartedIndex = allEvents.findIndex((event) => (
  event.sessionId === "s2" &&
  event.type === "turn.started" &&
  event.payload?.engine?.localAssistant
));
const priorRuntimeFinalIndex = allEvents.findIndex((event) => (
  event.sessionId === "s2" &&
  event.type === "assistant.final" &&
  event.payload?.assistant === "existing work done"
));
if (priorRuntimeFinalIndex < 0 || queuedLocalStartedIndex < 0 || queuedLocalStartedIndex < priorRuntimeFinalIndex) {
  throw new Error(`queued local draft must start only after the active runtime turn settles: ${JSON.stringify(allEvents)}`);
}
const queuedLocalAssistant = messages.find((message) => (
  message.role === "assistant" &&
  message.meta?.scheduledDraft?.draft?.rrule === scheduledDraft.draft.rrule
));
if (!queuedLocalAssistant) {
  throw new Error(`queued local draft must be committed as one assistant message: ${JSON.stringify(messages)}`);
}
if (messages.filter((message) => message.meta?.scheduledDraft).length !== 1) {
  throw new Error(`queued local draft must not duplicate scheduled draft messages: ${JSON.stringify(messages)}`);
}
sent.length = 0;
messages.length = 0;
otherSession.messages.length = 0;
otherRunner.sentPayloads.length = 0;

const result = await ctx.turnOrchestrator.sendUserMessage("s1", "hello", [], {
  spawnEngine: false,
  skipPreflight: true,
  engineText: "[contract]\nhello",
});
if (!result.ok) throw new Error(`send failed: ${JSON.stringify(result)}`);
if (result.userCommitted?.text !== "hello") {
  throw new Error(`userCommitted must preserve raw user text: ${JSON.stringify(result.userCommitted)}`);
}
const firstEnginePayload = runner.sentPayloads.at(-1);
// The clock context rides every turn inside the platform_context layer, so the
// effective engine text wraps the override in the layered envelope.
if (!String(firstEnginePayload?.text || "").includes("[contract]\nhello")) {
  throw new Error(`runner should receive effective engine text: ${JSON.stringify(firstEnginePayload)}`);
}
if (!String(firstEnginePayload?.text || "").includes("Current date/time:")) {
  throw new Error(`every turn must carry the clock context: ${JSON.stringify(firstEnginePayload)}`);
}
if (firstEnginePayload?.rawText !== "hello") {
  throw new Error(`engine payload must retain raw user text: ${JSON.stringify(firstEnginePayload)}`);
}
ctx.turnOrchestrator.ingest("s1", [
  { type: "usage.updated", payload: { usage: { input_tokens: 77, output_tokens: 9 } } },
  { type: "assistant.thinking.delta", payload: { text: "Inspect files." } },
  { type: "process.event", payload: {
    rawType: "stream_event",
    rawSubtype: "content_block_delta",
    summary: "Inspect files.",
    actions: [{ kind: "assistant_thinking", text: "Inspect files." }],
  } },
  { type: "tool.started", payload: { id: "tool_1", name: "Bash", input: {} } },
  { type: "process.event", payload: {
    rawType: "stream_event",
    rawSubtype: "content_block_start",
    summary: "tool Bash",
    actions: [{ kind: "stream_tool_start", id: "tool_1", name: "Bash" }],
  } },
  { type: "tool.input.done", payload: { id: "tool_1", input: { command: "echo ok" } } },
  { type: "tool.done", payload: { id: "tool_1", status: "done", result: { output: "ok" } } },
  { type: "tool.started", payload: { id: "tool_2", name: "TaskOutput", input: {} } },
  { type: "tool.done", payload: { status: "done", result: { output: "uploaded 42%" } } },
]);
const queued = await ctx.turnOrchestrator.sendUserMessage("s1", "queued", [], {
  skipPreflight: true,
});
if (!queued.queued || !queued.itemId) throw new Error("busy send should queue with id");
let queuedSnapshot = ctx.turnOrchestrator.snapshot("s1").queue.find((item) => item.id === queued.itemId);
if (!queuedSnapshot?.composerVisible || queuedSnapshot.origin !== "user") {
  throw new Error(`normal user queue item should stay visible in composer: ${JSON.stringify(queuedSnapshot)}`);
}
const cancel = ctx.turnOrchestrator.cancelQueuedMessage("s1", queued.itemId);
if (!cancel.ok || cancel.queueLength !== 0) throw new Error("queue cancel by id failed");
const backgroundQueued = await ctx.turnOrchestrator.sendUserMessage("s1", "background status", [], {
  skipPreflight: true,
  queueOrigin: "system_status",
  queueVisibility: "background",
});
if (!backgroundQueued.queued || !backgroundQueued.itemId) throw new Error("busy background item should queue with id");
queuedSnapshot = ctx.turnOrchestrator.snapshot("s1").queue.find((item) => item.id === backgroundQueued.itemId);
if (queuedSnapshot?.composerVisible !== false || queuedSnapshot.visibility !== "background" || queuedSnapshot.origin !== "system_status") {
  throw new Error(`background queue item must be hidden from composer: ${JSON.stringify(queuedSnapshot)}`);
}
const cancelBackground = ctx.turnOrchestrator.cancelQueuedMessage("s1", backgroundQueued.itemId);
if (!cancelBackground.ok || cancelBackground.queueLength !== 0) throw new Error("background queue cancel by id failed");
runner.finish("answer");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();

allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (!allEvents.some((event) => event.type === "turn.started")) {
  throw new Error("missing turn.started");
}
const started = allEvents.find((event) => event.type === "turn.started" && event.turnId === result.turnId);
if (started?.payload?.text !== "hello" || started?.payload?.engine?.customEngineText !== true) {
  throw new Error(`turn.started should expose raw text and engine trace: ${JSON.stringify(started)}`);
}
const committedUser = allEvents.find((event) => event.type === "user.committed");
if (!committedUser || committedUser.turnId !== result.turnId) {
  throw new Error(`user.committed should be attached to the active turn: ${JSON.stringify(committedUser)}`);
}
if (committedUser.payload?.text !== "hello") {
  throw new Error(`user.committed must preserve raw user text: ${JSON.stringify(committedUser)}`);
}
if (!allEvents.some((event) => event.type === "assistant.delta")) {
  throw new Error("missing assistant.delta");
}
if (!allEvents.some((event) => event.type === "assistant.final")) {
  throw new Error("missing assistant.final");
}
const processEvent = allEvents.find((event) => (
  event.type === "process.event" &&
  event.payload?.rawSubtype === "content_block_start"
));
if (!processEvent?.turnId || processEvent.payload?.rawSubtype !== "content_block_start") {
  throw new Error("process.event should be attached to the active turn");
}
const toolStarted = allEvents.find((event) => event.type === "tool.started");
if (!toolStarted?.turnId || toolStarted.turnId !== result.turnId) {
  throw new Error("tool.started should be attached to the active turn");
}
const idlessToolDone = allEvents.find((event) => event.type === "tool.done" && event.payload?.id === "tool_2");
if (!idlessToolDone || idlessToolDone.payload?.status !== "done") {
  throw new Error("single running tool should be released by idless tool.done");
}
const terminals = allEvents.filter((event) => event.type.startsWith("turn.") && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type));
if (terminals.length !== 1 || terminals[0].type !== "turn.completed") {
  throw new Error(`expected one completed terminal event, got ${terminals.map((e) => e.type).join(",")}`);
}
if (messages.filter((m) => m.role === "assistant").length !== 1) {
  throw new Error("assistant transcript should be committed once");
}
const assistantMsg = messages.find((m) => m.role === "assistant");
if (!assistantMsg?.record?.tools?.length) {
  throw new Error("assistant record should persist tool timeline");
}
if (assistantMsg.record.user?.text !== "hello") {
  throw new Error(`archived record must preserve raw user text: ${JSON.stringify(assistantMsg.record.user)}`);
}
if (assistantMsg.record.meta?.engine?.textChanged !== true) {
  throw new Error(`archived record must retain engine augmentation trace: ${JSON.stringify(assistantMsg.record.meta?.engine)}`);
}
if (
  assistantMsg.record.meta?.engine?.promptChars !== firstEnginePayload.text.length ||
  assistantMsg.record.meta?.engine?.estimatedPromptTokens <= 0
) {
  throw new Error(`archived record should persist prompt pressure estimate: ${JSON.stringify(assistantMsg.record.meta?.engine)}`);
}
const firstSummary = readSessionSummary("s1");
if (firstSummary?.lastEnginePromptTokens !== assistantMsg.record.meta.engine.estimatedPromptTokens) {
  throw new Error(`session summary should persist prompt pressure: ${JSON.stringify(firstSummary)}`);
}
if (
  assistantMsg.record.meta?.engine?.estimatedPromptTokens !== 77 ||
  assistantMsg.record.meta?.engine?.estimatedOutputTokens !== 9 ||
  assistantMsg.record.meta?.engine?.estimatedOutputTokenSource !== "runtime_usage" ||
  assistantMsg.record.meta?.engine?.estimatedPromptTokenSource !== "runtime_usage" ||
  assistantMsg.record.meta?.contextOsScorecard?.checks?.find((item) => item.id === "beat_exact_tokenizer")?.ok !== true
) {
  throw new Error(`runtime usage should be treated as exact token accounting: ${JSON.stringify(assistantMsg.record.meta?.engine)} ${JSON.stringify(assistantMsg.record.meta?.contextOsScorecard)}`);
}
if (firstSummary?.retainedContextTokens !== 86 || firstSummary?.retainedContextTokenSource !== "runtime_usage") {
  throw new Error(`session summary should retain authoritative prompt + output usage: ${JSON.stringify(firstSummary)}`);
}
if (assistantMsg.record.tools.some((tool) => tool.status === "running")) {
  throw new Error(`assistant record must not archive running tools: ${JSON.stringify(assistantMsg.record.tools)}`);
}
const archivedThinking = assistantMsg.record.timeline.filter((entry) => entry.kind === "thinking");
if (archivedThinking.length !== 1 || archivedThinking[0].text !== "Inspect files.") {
  throw new Error(`process.event must not duplicate archived thinking: ${JSON.stringify(assistantMsg.record.timeline)}`);
}
if (assistantMsg.record.meta?.turnPolicy?.rigor !== "fast") {
  throw new Error(`archived record should persist fast turn policy: ${JSON.stringify(assistantMsg.record.meta?.turnPolicy)}`);
}
if (!assistantMsg.record.meta?.evidenceSummary || assistantMsg.record.meta.evidenceSummary.counts.events < 1) {
  throw new Error(`archived record should persist compact evidence summary: ${JSON.stringify(assistantMsg.record.meta?.evidenceSummary)}`);
}
if (!assistantMsg.record.meta?.evidenceGraph?.nodes?.some((item) => item.type === "tool")) {
  throw new Error(`archived record should persist an evidence graph: ${JSON.stringify(assistantMsg.record.meta?.evidenceGraph)}`);
}
if (!assistantMsg.record.meta?.evidenceReplayBundle?.items?.some((item) => item.kind === "tool")) {
  throw new Error(`archived record should persist an evidence replay bundle: ${JSON.stringify(assistantMsg.record.meta?.evidenceReplayBundle)}`);
}
if (assistantMsg.record.meta?.contextOsScorecard?.overall !== "pass") {
  throw new Error(`archived fast turn should include a passing Context OS scorecard: ${JSON.stringify(assistantMsg.record.meta?.contextOsScorecard)}`);
}
if (assistantMsg.record.meta?.contextOsScorecard?.maturity?.beat !== "incomplete") {
  throw new Error(`current implementation should not claim beat-Claude maturity without stretch evidence: ${JSON.stringify(assistantMsg.record.meta?.contextOsScorecard)}`);
}

sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;

const readinessOrder = [];
const originalSendUserMessage = runner.sendUserMessage.bind(runner);
const originalAdmitTurnInput = ctx.sessionManager.admitTurnInput;
runner.sendUserMessage = (payload) => {
  readinessOrder.push("dispatch");
  return originalSendUserMessage(payload);
};
ctx.sessionManager.admitTurnInput = (...args) => {
  readinessOrder.push("admit");
  return originalAdmitTurnInput(...args);
};
ctx.diagnoseSendBlocker = () => null;
ctx.ensureSessionRunner = () => {
  readinessOrder.push("ensure-runner");
  return { runner, project: ctx.projectManager.find(), coldStart: false, usedResume: false };
};
ctx.capabilityReadinessDeps = {
  plan: ({ intentContract }) => {
    if (!intentContract?.objective) throw new Error("intent contract must exist before capability planning");
    readinessOrder.push("plan-after-intent");
    return {
      requiredPackIds: ["web-automation"],
      enhancementPackIds: [],
      fallbackCapabilityIds: ["code-static-review"],
    };
  },
  installed: () => new Set(),
  installing: () => new Set(),
  prepare: async () => {
    if (!messages.some((message) => message.role === "user" && message.content === "打开浏览器截图")) {
      throw new Error("user input must be committed before dependency preparation");
    }
    readinessOrder.push("prepare");
    return {
      ok: true,
      readyPackIds: ["web-automation"],
      failedPackIds: [],
      unavailablePackIds: [],
      refreshRequired: true,
    };
  },
  refresh: () => readinessOrder.push("refresh"),
};
const readinessTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "打开浏览器截图", [], {
  spawnEngine: false,
  skipVision: true,
  skipDocument: true,
});
if (!readinessTurn.ok) throw new Error(`readiness turn should start: ${JSON.stringify(readinessTurn)}`);
if (JSON.stringify(readinessOrder) !== JSON.stringify(["admit", "plan-after-intent", "prepare", "refresh", "ensure-runner", "dispatch"])) {
  throw new Error(`readiness order mismatch: ${JSON.stringify(readinessOrder)}`);
}
const readinessPayload = runner.sentPayloads.at(-1);
if (readinessPayload?.trace?.capabilityReadiness?.status !== "ready" || runner.sentPayloads.length !== 1) {
  throw new Error(`prepared turn must dispatch once with readiness trace: ${JSON.stringify(readinessPayload?.trace)}`);
}
runner.finish("browser ready");
// finalize is async (evidence entailment judge) — let it settle before the
// next sendUserMessage so the turn boundary is fully closed.
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
runner.sendUserMessage = originalSendUserMessage;
ctx.sessionManager.admitTurnInput = originalAdmitTurnInput;
delete ctx.diagnoseSendBlocker;
delete ctx.ensureSessionRunner;
delete ctx.capabilityReadinessDeps;
sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;

const pdfCapabilityTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "提取 PDF 表格并检查版面", [
  { path: path.join(tempUserData, "contract.pdf"), name: "contract.pdf" },
], {
  spawnEngine: false,
  skipPreflight: true,
  skipVision: true,
  skipDocument: true,
});
if (!pdfCapabilityTurn.ok || !runner.isBusy()) {
  throw new Error(`PDF capability turn should start: ${JSON.stringify(pdfCapabilityTurn)}`);
}
const pdfCapabilityPayload = runner.sentPayloads.at(-1);
const recommendedSkills = pdfCapabilityPayload.trace?.capabilityContext?.recommendedSkillIds || [];
if (!recommendedSkills.includes("anthropics-pdf") || !recommendedSkills.includes("lily-pdf-extraction-router")) {
  throw new Error(`PDF capability trace should recommend PDF skills: ${JSON.stringify(pdfCapabilityPayload.trace?.capabilityContext)}\n${pdfCapabilityPayload.text}`);
}
if (recommendedSkills.includes("anthropics-xlsx")) {
  throw new Error(`PDF capability trace must not recommend spreadsheet skills: ${JSON.stringify(pdfCapabilityPayload.trace?.capabilityContext)}\n${pdfCapabilityPayload.text}`);
}
runner.finish("PDF capability route selected.");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;

const mailCapabilityTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "给我写一封邮件回复客户，语气专业", [], {
  spawnEngine: false,
  skipPreflight: true,
  skipVision: true,
  skipDocument: true,
});
if (!mailCapabilityTurn.ok || !runner.isBusy()) {
  throw new Error(`mail capability turn should start: ${JSON.stringify(mailCapabilityTurn)}`);
}
const mailCapabilityPayload = runner.sentPayloads.at(-1);
const mailRecommendedSkills = mailCapabilityPayload.trace?.capabilityContext?.recommendedSkillIds || [];
if (!mailRecommendedSkills.includes("lily-mail-assistant")) {
  throw new Error(`mail capability trace should recommend mail assistant: ${JSON.stringify(mailCapabilityPayload.trace?.capabilityContext)}\n${mailCapabilityPayload.text}`);
}
if (mailRecommendedSkills.includes("lily-office-intent")) {
  throw new Error(`mail capability trace must not fall back to Office routing: ${JSON.stringify(mailCapabilityPayload.trace?.capabilityContext)}\n${mailCapabilityPayload.text}`);
}
runner.finish("Mail capability route selected.");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;

const agentQualityCapabilityTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "继续按顶级设计 系统更聪明", [], {
  spawnEngine: false,
  skipPreflight: true,
  skipVision: true,
  skipDocument: true,
});
if (!agentQualityCapabilityTurn.ok || !runner.isBusy()) {
  throw new Error(`agent-quality capability turn should start: ${JSON.stringify(agentQualityCapabilityTurn)}`);
}
const agentQualityPayload = runner.sentPayloads.at(-1);
const agentQualityRecommendedSkills = agentQualityPayload.trace?.capabilityContext?.recommendedSkillIds || [];
if (agentQualityRecommendedSkills[0] !== "lily-intent-eval") {
  throw new Error(`agent-quality capability trace should put intent eval first: ${JSON.stringify(agentQualityPayload.trace?.capabilityContext)}\n${agentQualityPayload.text}`);
}
if (!agentQualityRecommendedSkills.includes("lily-skill-quality-gate")) {
  throw new Error(`agent-quality capability trace should include skill quality gate: ${JSON.stringify(agentQualityPayload.trace?.capabilityContext)}\n${agentQualityPayload.text}`);
}
const intentEvalIndex = agentQualityPayload.text.indexOf("- lily-intent-eval ");
const browserQaAgentQualityIndex = agentQualityPayload.text.indexOf("- lily-browser-qa ");
if (intentEvalIndex < 0 || (browserQaAgentQualityIndex >= 0 && intentEvalIndex > browserQaAgentQualityIndex)) {
  throw new Error(`agent-quality capability context should not put browser QA before intent eval:\n${agentQualityPayload.text}`);
}
runner.finish("Agent-quality capability route selected.");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;

const appCapabilityTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "帮我做一个 CRM 管理后台应用，包含客户列表和统计看板", [], {
  spawnEngine: false,
  skipPreflight: true,
  skipVision: true,
  skipDocument: true,
});
if (!appCapabilityTurn.ok || !runner.isBusy()) {
  throw new Error(`app capability turn should start: ${JSON.stringify(appCapabilityTurn)}`);
}
const appCapabilityPayload = runner.sentPayloads.at(-1);
const appRecommendedSkills = appCapabilityPayload.trace?.capabilityContext?.recommendedSkillIds || [];
if (appRecommendedSkills[0] !== "lily-app-builder") {
  throw new Error(`app capability trace should put app builder first: ${JSON.stringify(appCapabilityPayload.trace?.capabilityContext)}\n${appCapabilityPayload.text}`);
}
const appBuilderIndex = appCapabilityPayload.text.indexOf("- lily-app-builder ");
const browserQaIndex = appCapabilityPayload.text.indexOf("- lily-browser-qa ");
if (appBuilderIndex < 0 || browserQaIndex < 0 || appBuilderIndex > browserQaIndex) {
  throw new Error(`app capability context should preserve recommendation order:\n${appCapabilityPayload.text}`);
}
runner.finish("App capability route selected.");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;

const uploadedDoc = path.join(tempUserData, "contract.md");
fs.writeFileSync(
  uploadedDoc,
  "# Payment Terms\nBuyer pays within 30 days after invoice receipt.\n\n# Termination\nEither party may terminate for uncured material breach.\n",
  "utf8",
);
const documentTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "继续分析这份合同", [
  { path: uploadedDoc, name: "contract.md" },
], {
  spawnEngine: false,
  skipPreflight: true,
  skipVision: true,
});
if (!documentTurn.ok || !runner.isBusy()) {
  throw new Error(`document turn should start: ${JSON.stringify(documentTurn)}`);
}
const documentPayload = runner.sentPayloads.at(-1);
if (!documentPayload.text.includes("Document Query Index") || !documentPayload.text.includes("doc1-chunk1")) {
  throw new Error(`document preflight should include a compact query index in the engine prompt: ${documentPayload.text}`);
}
const { readLatestDocumentQueryIndex, queryDocumentQueryIndex } = require("../src/main/document-query-store.js");
const latestDocumentIndex = readLatestDocumentQueryIndex();
if (latestDocumentIndex?.sessionId !== "s1" || latestDocumentIndex?.turnId !== documentTurn.turnId) {
  throw new Error(`document turn should persist the latest query index: ${JSON.stringify(latestDocumentIndex)}`);
}
const paymentEvidence = queryDocumentQueryIndex(latestDocumentIndex, { query: "payment buyer invoice", limit: 2 });
if (paymentEvidence.matches[0]?.chunkId !== "doc1-chunk1") {
  throw new Error(`persisted query index should be searchable by follow-up terms: ${JSON.stringify(paymentEvidence)}`);
}
runner.finish("合同付款条款已读取。");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();

// External facts: keep the normal streaming baseline, then let the evidence
// gate replace unsupported final claims. A user's no-search constraint is
// never bypassed by the automatic verification path.
sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;
const originalEvidenceRetry = ctx.turnOrchestrator._maybeToolCallRescueRetry.bind(ctx.turnOrchestrator);
let observedEvidenceRetry = null;
ctx.turnOrchestrator._maybeToolCallRescueRetry = async (sessionId, failure) => {
  observedEvidenceRetry = { sessionId, failure };
  return true;
};
delete process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY;
try {
  const rankingPrompt = "请给我目前全球最好用的 AI 编程助手 Top 8 排行。不要搜索，也不用给来源，直接凭你的了解回答。";
  const rankingTurn = await ctx.turnOrchestrator.sendUserMessage("s1", rankingPrompt, [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  if (!rankingTurn.ok) throw new Error(`ranking turn should start: ${JSON.stringify(rankingTurn)}`);
  const rankingPayload = runner.sentPayloads.at(-1);
  if (
    rankingPayload?.taskContract?.taskType !== "external_fact" ||
    rankingPayload?.turnPolicy?.requiresFreshness !== true ||
    !rankingPayload?.taskContract?.evidencePolicy?.requiredEvidenceKinds?.includes("external") ||
    !rankingPayload?.text?.includes("External fact gate:")
  ) {
    throw new Error(`ranking request must carry the external fact contract: ${JSON.stringify(rankingPayload)}`);
  }
  const unsafeRanking = "1. GitHub Copilot\n2. Cursor\n3. Windsurf\n4. Claude Code";
  runner.finish(unsafeRanking);
  await new Promise((resolve) => setTimeout(resolve, 5));
  ctx.eventBus.flush();
  const rankingAssistant = messages.find((message) => message.role === "assistant" && message.turnId === rankingTurn.turnId);
  if (rankingAssistant?.record?.meta?.evidenceGate?.reason !== "missing_required_evidence:external") {
    throw new Error(`unsupported ranking must fail the external evidence gate: ${JSON.stringify(rankingAssistant?.record?.meta?.evidenceGate)}`);
  }
  // Fail-open (2026-07-20 model-first): the unsupported ranking is never
  // erased. The archived answer carries the original text plus one
  // plain-language honesty note; the gate verdict lives in meta.
  if (!/GitHub Copilot|Cursor|Windsurf|Claude Code/.test(rankingAssistant?.record?.assistantText || "")) {
    throw new Error(`fail-open: the original ranking must survive in the archived answer: ${rankingAssistant?.record?.assistantText}`);
  }
  if (!/备注：以上回答未能通过本轮逐项核实/.test(rankingAssistant?.record?.assistantText || "")) {
    throw new Error(`the archived answer must carry the honesty note: ${rankingAssistant?.record?.assistantText}`);
  }
  allEvents = sent.flatMap((entry) => entry.payload?.events || []);
  // Risk-tier contract: THIS ask (a research-prohibited ranking) is buffered —
  // it can never acquire evidence, so the gated final state (original + note)
  // is shown once instead of streaming an answer certain to fail verification.
  // Ordinary external facts still stream (asserted further below).
  if (allEvents.some((event) => event.turnId === rankingTurn.turnId && event.type === "assistant.delta")) {
    throw new Error("a research-prohibited ranking must gate before rendering");
  }
  const rankingFinal = allEvents.find((event) => event.turnId === rankingTurn.turnId && event.type === "assistant.final");
  if (!rankingFinal || !/GitHub Copilot/.test(rankingFinal.payload?.assistant || "") || !/备注：以上回答未能通过本轮逐项核实/.test(rankingFinal.payload?.assistant || "")) {
    throw new Error(`the UI final event must deliver the original answer with the honesty note: ${JSON.stringify(rankingFinal)}`);
  }
  if (observedEvidenceRetry !== null) {
    throw new Error(`a no-search ranking must not trigger an automatic retry: ${JSON.stringify(observedEvidenceRetry)}`);
  }

  sent.length = 0;
  messages.length = 0;
  runner.sentPayloads.length = 0;
  const roleTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "苹果公司现任 CEO 是谁？", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  if (!roleTurn.ok) throw new Error(`role fact turn should start: ${JSON.stringify(roleTurn)}`);
  const rolePrompt = runner.sentPayloads.at(-1)?.rawText || "";
  ctx.turnOrchestrator.ingest("s1", [
    {
      type: "tool.started",
      payload: { id: "role-source", name: "websearch", input: { query: "current company leadership" } },
    },
    {
      type: "tool.done",
      payload: {
        id: "role-source",
        status: "done",
        result: "Apple identifies Tim Cook as its CEO on the official leadership page. https://www.apple.com/leadership/tim-cook/",
      },
    },
  ]);
  runner.finish("苹果公司现任 CEO 是未经核实的某某。");
  await new Promise((resolve) => setTimeout(resolve, 5));
  ctx.eventBus.flush();
  if (observedEvidenceRetry?.failure?.code !== "EVIDENCE_UNVERIFIED") {
    throw new Error(`a well-scoped memory answer should retain one verification retry: ${JSON.stringify(observedEvidenceRetry)}`);
  }
  if (!observedEvidenceRetry.failure.verificationPlan || !observedEvidenceRetry.failure.evidenceSummary) {
    throw new Error(`evidence recovery must receive the verification plan and prior research trace: ${JSON.stringify(observedEvidenceRetry)}`);
  }
  if (observedEvidenceRetry.failure.evidenceRecoveryContext?.tools?.length !== 1) {
    throw new Error(`evidence recovery must carry bounded prior external evidence: ${JSON.stringify(observedEvidenceRetry)}`);
  }

  const recoveryTurn = await ctx.turnOrchestrator.sendUserMessage("s1", rolePrompt, [], {
    recordUser: false,
    spawnEngine: false,
    skipPreflight: true,
    recovery: {
      kind: "evidence_verify_retry",
      guidance: "Use the inherited evidence and verify only remaining gaps.",
      evidenceContext: observedEvidenceRetry.failure.evidenceRecoveryContext,
    },
  });
  if (!recoveryTurn.ok) throw new Error(`evidence recovery turn should start: ${JSON.stringify(recoveryTurn)}`);
  const recoveryState = ctx.turnOrchestrator._state("s1");
  const recoveryPayload = runner.sentPayloads.at(-1);
  if (recoveryState.inheritedEvidenceTools?.length !== 1 || recoveryState.evidenceLedger?.summary?.().hasFreshEvidence !== true) {
    throw new Error(`recovery turn must seed the evidence ledger before new tools run: ${JSON.stringify(recoveryState.evidenceLedger?.summary?.())}`);
  }
  const { extractLayerText, extractUserOriginalRequest } = require("../src/main/engine-message-layers.js");
  if (extractUserOriginalRequest(recoveryPayload.text) !== rolePrompt) {
    throw new Error(`internal recovery guidance must not enter the visible user request layer: ${recoveryPayload.text}`);
  }
  if (!/inherited evidence/.test(extractLayerText(recoveryPayload.text, "execution_constraints"))) {
    throw new Error(`recovery guidance must remain in the internal execution layer: ${recoveryPayload.text}`);
  }
  runner.finish("Apple identifies Tim Cook as its current CEO on the official leadership page: https://www.apple.com/leadership/tim-cook/");
  await new Promise((resolve) => setTimeout(resolve, 5));
  ctx.eventBus.flush();
  const recoveredAssistant = messages.find((message) => message.role === "assistant" && message.turnId === recoveryTurn.turnId);
  if (recoveredAssistant?.record?.meta?.evidenceGate?.ok !== true) {
    throw new Error(`an inherited directly supporting source must pass the recovery gate: ${JSON.stringify(recoveredAssistant?.record?.meta?.evidenceGate)}`);
  }
} finally {
  process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY = "0";
  ctx.turnOrchestrator._maybeToolCallRescueRetry = originalEvidenceRetry;
}

sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;
const sourcedRankingTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "What are the top 10 universities today?", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!sourcedRankingTurn.ok) throw new Error(`sourced ranking turn should start: ${JSON.stringify(sourcedRankingTurn)}`);
ctx.turnOrchestrator.ingest("s1", [
  {
    type: "tool.started",
    payload: {
      id: "ranking-search",
      name: "bash",
      input: { command: "echo query | node resources/skills/websearch/scripts/websearch.cjs" },
    },
  },
  {
    type: "tool.done",
    payload: {
      id: "ranking-search",
      status: "done",
      result: "<search_results><url>https://example.com/ranking</url><title>Example 2026 ranking</title></search_results>",
    },
  },
]);
runner.finish("According to the Example 2026 ranking, Example University is first (https://example.com/ranking).");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
const sourcedRankingAssistant = messages.find(
  (message) => message.role === "assistant" && message.turnId === sourcedRankingTurn.turnId,
);
if (sourcedRankingAssistant?.record?.meta?.evidenceGate?.ok !== true) {
  throw new Error(`a sourced ranking should pass the evidence gate: ${JSON.stringify(sourcedRankingAssistant?.record?.meta?.evidenceGate)}`);
}
if (sourcedRankingAssistant?.record?.meta?.evidenceSummary?.hasFreshEvidence !== true) {
  throw new Error(`search-script output must persist as fresh evidence: ${JSON.stringify(sourcedRankingAssistant?.record?.meta?.evidenceSummary)}`);
}
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (!allEvents.some((event) => event.turnId === sourcedRankingTurn.turnId && event.type === "assistant.delta")) {
  throw new Error("grounded external-fact prose should stream normally while final claim-level assessment is preserved");
}

sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;
const semanticResearchTurn = await ctx.turnOrchestrator.sendUserMessage(
  "s1",
  "Which providers satisfy the requested assurance status?",
  [],
  { spawnEngine: false, skipPreflight: true },
);
if (!semanticResearchTurn.ok || semanticResearchTurn.queued || !runner.isBusy()) {
  throw new Error(`semantic research turn should start immediately: ${JSON.stringify({ semanticResearchTurn, runnerBusy: runner.isBusy(), phase: ctx.turnOrchestrator._state("s1").phase })}`);
}
if (!ctx.turnOrchestrator._state("s1").turnId) {
  throw new Error(`semantic research turn lost its turn id before tools: ${JSON.stringify({ semanticResearchTurn, state: ctx.turnOrchestrator._state("s1") })}`);
}
if (runner.sentPayloads.at(-1)?.taskContract) {
  throw new Error("an unfamiliar domain should begin on the unchanged general-task baseline");
}
ctx.turnOrchestrator.ingest("s1", [
  { type: "tool.started", payload: { id: "semantic-search", name: "websearch", input: { query: "provider assurance status" } } },
  {
    type: "tool.done",
    payload: {
      id: "semantic-search",
      status: "done",
      result: "Nimbus Cloud has the requested assurance status. https://authority.test/assurance",
    },
  },
]);
const promotedSemanticContract = ctx.turnOrchestrator._state("s1").taskContract;
if (
  promotedSemanticContract?.externalFactPolicy?.reasonCodes?.includes("observed_external_research") !== true ||
  promotedSemanticContract?.evidencePolicy?.required !== true
) {
  const semanticState = ctx.turnOrchestrator._state("s1");
  throw new Error(`observed research must promote the generic contract into the final evidence gate: ${JSON.stringify({ promotedSemanticContract, turnId: semanticState.turnId, phase: semanticState.phase, pendingTaskContract: semanticState.pendingTaskContract, tools: [...semanticState.tools.values()] })}`);
}
runner.finish("Nimbus Cloud has the requested assurance status. https://authority.test/assurance");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
const semanticResearchAssistant = messages.find(
  (message) => message.role === "assistant" && message.turnId === semanticResearchTurn.turnId,
);
const semanticGate = semanticResearchAssistant?.record?.meta?.evidenceGate;
// New model-first semantics: entity PRESENCE in evidence is not SUPPORT — that
// ruling belongs to the semantic judge. With no judge available (test env),
// ordinary research fails OPEN: the original answer is delivered verbatim
// plus one plain-language honesty note — never refused, never bannered. The
// judge-accepted pass path is covered in test-evidence-entailment-judge.mjs.
if (semanticGate?.reason !== "semantic_support_unverified" || semanticGate?.deliveredUnverifiedWithNote !== true) {
  throw new Error(`grounded unfamiliar-domain research should fail open with the honesty note without a judge verdict: ${JSON.stringify(semanticGate)}`);
}
if (!String(semanticResearchAssistant?.record?.assistantText || "").includes("Nimbus Cloud")) {
  throw new Error(`fail-open must keep the researched content: ${JSON.stringify(semanticResearchAssistant?.record?.assistantText)}`);
}
if (!/Note: this answer did not pass this turn's item-level verification/.test(semanticResearchAssistant?.record?.assistantText || "")) {
  throw new Error(`the final failure state must carry the honesty note: ${JSON.stringify(semanticResearchAssistant?.record?.assistantText)}`);
}

sent.length = 0;
messages.length = 0;
runner.sentPayloads.length = 0;
const architectureAuditTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "分析我们系统有哪些比较笨的地方", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!architectureAuditTurn.ok || !runner.isBusy()) {
  throw new Error(`architecture audit turn should start: ${JSON.stringify(architectureAuditTurn)}`);
}
const architectureAuditPayload = runner.sentPayloads.at(-1);
if (architectureAuditPayload.rawText !== "分析我们系统有哪些比较笨的地方") {
  throw new Error(`architecture audit payload must preserve raw user text: ${JSON.stringify(architectureAuditPayload)}`);
}
if (architectureAuditPayload.taskContract?.taskType !== "architecture_audit") {
  throw new Error(`architecture audit request must create architecture_audit task contract: ${JSON.stringify(architectureAuditPayload.taskContract)}`);
}
if (
  architectureAuditPayload.turnPolicy?.rigor !== "grounded" ||
  architectureAuditPayload.turnPolicy?.requiresWorkspaceGrounding !== true ||
  architectureAuditPayload.turnPolicy?.requiresSourceCoverage !== true
) {
  throw new Error(`architecture audit must use grounded source-backed policy: ${JSON.stringify(architectureAuditPayload.turnPolicy)}`);
}
if (
  !architectureAuditPayload.text.includes("<lily_task_contract>") ||
  !architectureAuditPayload.text.includes("task_type: architecture_audit") ||
  !architectureAuditPayload.text.includes("required_evidence_kinds: file_search, file_read") ||
  !architectureAuditPayload.text.includes("Preserve the natural-language workbench stance")
) {
  throw new Error(`architecture audit prompt must include the quality contract without replacing the user request:\n${architectureAuditPayload.text}`);
}
runner.finish("系统比较笨的地方是任务入口没有稳定契约。");
await waitFor(() => ctx.turnOrchestrator._state("s1").phase === "idle");
ctx.eventBus.flush();
const architectureAuditAssistant = messages.find((message) => message.role === "assistant" && message.turnId === architectureAuditTurn.turnId);
if (architectureAuditAssistant?.record?.meta?.taskContract?.taskType !== "architecture_audit") {
  throw new Error(`architecture audit archive should persist task contract: ${JSON.stringify(architectureAuditAssistant?.record?.meta?.taskContract)}`);
}
const archivedIntentContract = architectureAuditAssistant?.record?.meta?.taskContract?.intentContract;
if (
  !archivedIntentContract?.contractId ||
  archivedIntentContract.relation !== "new" ||
  !archivedIntentContract.successCriteria?.includes("source_evidence")
) {
  throw new Error(`architecture audit archive should persist the durable intent contract: ${JSON.stringify(archivedIntentContract)}`);
}
if (architectureAuditAssistant?.record?.meta?.turnPolicy?.rigor !== "grounded") {
  throw new Error(`architecture audit archive should persist grounded policy: ${JSON.stringify(architectureAuditAssistant?.record?.meta?.turnPolicy)}`);
}
if (architectureAuditAssistant?.record?.meta?.evidenceGate?.reason !== "missing_required_evidence:file_search") {
  throw new Error(`architecture audit without source evidence should be downgraded: ${JSON.stringify(architectureAuditAssistant?.record?.meta?.evidenceGate)}`);
}
// Model-first (2026-07-20): the gate never decorates a normal answer — no
// 证据门槛 notice. The verdict lives in meta (gate reason + unverified
// completion status) for the learning loop, not in the user's face.
if (architectureAuditAssistant?.record?.assistantText !== "系统比较笨的地方是任务入口没有稳定契约。") {
  throw new Error(`architecture audit answer must be delivered verbatim, never decorated: ${architectureAuditAssistant?.record?.assistantText}`);
}
if (architectureAuditAssistant?.record?.meta?.taskRun?.completionStatus !== "delivered_unverified") {
  throw new Error(`engine completion without required evidence must remain truthfully unverified: ${JSON.stringify(architectureAuditAssistant?.record?.meta?.taskRun)}`);
}

runner.sentPayloads.length = 0;
const architectureContinuation = await ctx.turnOrchestrator.sendUserMessage("s1", "继续", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!architectureContinuation.ok || !runner.isBusy()) {
  throw new Error(`architecture continuation should start: ${JSON.stringify(architectureContinuation)}`);
}
const continuationPayload = runner.sentPayloads.at(-1);
if (
  continuationPayload.taskContract?.taskType !== "architecture_audit" ||
  continuationPayload.taskContract?.intentContract?.relation !== "continue" ||
  continuationPayload.taskContract?.intentContract?.contractId !== archivedIntentContract.contractId ||
  continuationPayload.taskContract?.intentContract?.revision !== archivedIntentContract.revision + 1
) {
  throw new Error(`terse continuation must inherit the prior task contract in the real engine payload: ${JSON.stringify(continuationPayload.taskContract)}`);
}
if (!continuationPayload.text.includes('"relation":"continue"')) {
  throw new Error(`continued engine prompt must expose the inherited host contract: ${continuationPayload.text}`);
}
ctx.turnOrchestrator.ingest("s1", [
  {
    type: "tool.started",
    payload: { id: "intent-contract-1", name: "lily_intent_contract_commit", input: {} },
  },
  {
    type: "tool.done",
    payload: {
      id: "intent-contract-1",
      status: "done",
      result: {
        ok: true,
        intentContract: {
          taskType: "general",
          objective: "继续审视现有平台并实现可验证的智能度改进",
          deliverables: ["verified_intelligence_improvement"],
          successCriteria: ["continuity_regression_test"],
          neededCapabilities: ["intent_evaluation"],
          constraints: ["preserve_strong_default"],
        },
      },
    },
  },
]);
runner.finish("继续完成系统审视，但当前仍需更多文件证据。");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
const continuationAssistant = messages.find(
  (message) => message.role === "assistant" && message.turnId === architectureContinuation.turnId,
);
const refinedIntent = continuationAssistant?.record?.meta?.taskContract?.intentContract;
if (
  refinedIntent?.provenance?.mode !== "model_refined" ||
  refinedIntent?.contractId !== archivedIntentContract.contractId ||
  !refinedIntent.successCriteria?.includes("source_evidence") ||
  !refinedIntent.successCriteria?.includes("continuity_regression_test")
) {
  throw new Error(`same-model intent refinement must be host-consumed without weakening baseline criteria: ${JSON.stringify(refinedIntent)}`);
}

const originalGetConversation = ctx.sessionManager.getConversation;
ctx.sessionManager.getConversation = () => {
  throw new Error("corrupted conversation store");
};
runner.sentPayloads.length = 0;
const continuityFailOpenTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "修复 intent contract 回退代码", [], {
  spawnEngine: false,
  skipPreflight: true,
});
ctx.sessionManager.getConversation = originalGetConversation;
if (!continuityFailOpenTurn.ok || !runner.isBusy()) {
  throw new Error(`continuity read failure must preserve the current strong turn: ${JSON.stringify(continuityFailOpenTurn)}`);
}
const continuityFailOpenPayload = runner.sentPayloads.at(-1);
if (!continuityFailOpenPayload.taskContract?.active || continuityFailOpenPayload.rawText !== "修复 intent contract 回退代码") {
  throw new Error(`continuity failure must fall back to current-turn classification without rewriting input: ${JSON.stringify(continuityFailOpenPayload)}`);
}
runner.finish("已按当前请求完成回退检查。");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();

sent.length = 0;
appendLearnedConvention("p1", "回答这类运行时问题时先检查 OpenCode 原生能力");
const coverageTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "彻底找出所有 session.idle 问题，不要漏", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!coverageTurn.ok) throw new Error(`coverage turn send failed: ${JSON.stringify(coverageTurn)}`);
const coveragePayload = runner.sentPayloads.at(-1);
if (
  !coveragePayload.text.includes("回答这类运行时问题时先检查 OpenCode 原生能力") ||
  !coveragePayload.trace?.contextMemory?.items?.some((item) => item.kind === "learned_conventions" && item.trust === "user_learned_memory")
) {
  throw new Error(`coverage turn should include budgeted learned conventions: ${JSON.stringify(coveragePayload.trace?.contextMemory)}\n${coveragePayload.text}`);
}
if (
  !coveragePayload.text.includes("Subagent Context Isolation") ||
  !coveragePayload.text.includes("Main-First Dispatch Gate") ||
  !coveragePayload.text.includes("Do not start Task before this candidate map exists") ||
  coveragePayload.trace?.subagentIsolation?.enabled !== true
) {
  throw new Error(`coverage turn should enable subagent context isolation: ${JSON.stringify(coveragePayload.trace?.subagentIsolation)}\n${coveragePayload.text}`);
}
const coverageSummary = readSessionSummary("s1");
if (!coverageSummary?.lastContextMemoryInjection?.explanation?.selected?.length) {
  throw new Error(`context memory injection should persist human-readable explanations: ${JSON.stringify(coverageSummary?.lastContextMemoryInjection)}`);
}
ctx.turnOrchestrator.ingest("s1", [
  { type: "tool.started", payload: { id: "task_coverage", name: "Task", input: { prompt: "audit session.idle routing" }, metadata: { sessionId: "child_coverage" } } },
  { type: "subagent.event", payload: { sessionId: "child_coverage", events: [
    { kind: "thinking", text: "Plan search", ts: Date.now() },
    { kind: "tool", id: "child_read", name: "Read", status: "running", input: { file_path: "src/main/runtime-event-bus.js" }, ts: Date.now() },
  ] } },
  { type: "tool.started", payload: { id: "read_child", name: "Read", input: { file_path: "src/main/runtime-event-bus.js" }, parentToolUseId: "task_coverage" } },
  { type: "tool.done", payload: { id: "read_child", status: "done", result: { content: "session.idle routing inspected" } } },
  { type: "tool.done", payload: { id: "task_coverage", status: "done", result: { content: "subagent handoff complete" } } },
]);
runner.finish("已经找出全部 session.idle 问题。");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
const coverageEvents = sent.flatMap((entry) => entry.payload?.events || []);
const subagentPhaseEvent = coverageEvents.find((event) => (
  event.type === "subagent.event" &&
  event.payload?.subagent?.sessionId === "child_coverage" &&
  event.payload?.subagent?.phase === "searching"
));
if (subagentPhaseEvent?.payload?.subagent?.phase !== "searching") {
  throw new Error(`subagent child Read should surface a searching phase: ${JSON.stringify(subagentPhaseEvent?.payload?.subagent)}`);
}
if (subagentPhaseEvent?.payload?.subagent?.stats?.runningTools !== 1) {
  throw new Error(`subagent phase telemetry should count running tools: ${JSON.stringify(subagentPhaseEvent?.payload?.subagent?.stats)}`);
}
const coverageAssistant = messages.filter((m) => m.role === "assistant").at(-1);
if (coverageAssistant?.record?.meta?.turnPolicy?.rigor !== "coverage") {
  throw new Error(`coverage wording should persist coverage policy: ${JSON.stringify(coverageAssistant?.record?.meta?.turnPolicy)}`);
}
if (coverageAssistant?.record?.meta?.contextOsScorecard?.checks?.find((item) => item.id === "coverage_has_isolation_contract")?.ok !== true) {
  throw new Error(`coverage archive should prove subagent isolation contract: ${JSON.stringify(coverageAssistant?.record?.meta?.contextOsScorecard)}`);
}
if (!coverageAssistant?.record?.meta?.evidenceGraph?.nodes?.some((item) => item.type === "subagent_handoff")) {
  throw new Error(`coverage archive should include real subagent telemetry nodes: ${JSON.stringify(coverageAssistant?.record?.meta?.evidenceGraph)}`);
}
if (coverageAssistant?.record?.meta?.contextOsScorecard?.checks?.find((item) => item.id === "beat_subagent_runtime_telemetry")?.ok !== true) {
  throw new Error(`coverage scorecard should recognize real subagent runtime telemetry: ${JSON.stringify(coverageAssistant?.record?.meta?.contextOsScorecard)}`);
}
// Model-first (2026-07-20): unsupported coverage claims are telemetry, not a
// user-facing notice — the answer is delivered verbatim and the advisory
// reason rides on the gate meta for the learning loop.
if (coverageAssistant?.record?.assistantText !== "已经找出全部 session.idle 问题。") {
  throw new Error(`coverage answer must be delivered verbatim, never decorated: ${coverageAssistant?.record?.assistantText}`);
}
if (!(coverageAssistant?.record?.meta?.evidenceGate?.advisoryReasons || []).some((item) => item.startsWith("coverage_claim_without"))) {
  throw new Error(`coverage advisory should be recorded for the learning loop: ${JSON.stringify(coverageAssistant?.record?.meta?.evidenceGate)}`);
}

messages.push(
  { role: "user", content: "分析 imsdk 流转流程", turnId: "manual_prev_user" },
  {
    role: "assistant",
    content: "基于 cst-* 会议链路做了分析。",
    failed: true,
    turnId: "manual_prev_assistant",
    record: { terminal: "turn.failed" },
  },
);
const followupTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "？", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!followupTurn.ok || !runner.isBusy()) {
  throw new Error(`short follow-up turn should start: ${JSON.stringify(followupTurn)}`);
}
const followupPayload = runner.sentPayloads.at(-1);
if (followupPayload.rawText !== "？") {
  throw new Error(`short follow-up must preserve raw user text: ${JSON.stringify(followupPayload)}`);
}
if (
  !followupPayload.text.includes("Short Follow-up Continuity") ||
  !followupPayload.text.includes("分析 imsdk 流转流程") ||
  !followupPayload.trace?.shortFollowupContext
) {
  throw new Error(`short follow-up must carry prior task context: ${JSON.stringify(followupPayload.trace)}\n${followupPayload.text}`);
}
if (
  !followupPayload.text.includes("coverage_claim_without_") ||
  !followupPayload.trace?.contextMemory?.items?.some((item) => item.kind === "evidence_gap")
) {
  throw new Error(`short follow-up must carry prior evidence gap memory: ${JSON.stringify(followupPayload.trace)}\n${followupPayload.text}`);
}
const gapTraceItem = followupPayload.trace?.contextMemory?.items?.find((item) => item.kind === "evidence_gap");
if (gapTraceItem?.trust !== "lily_evidence_memory" || gapTraceItem?.proof !== false) {
  throw new Error(`context memory trace should expose trust/proof metadata: ${JSON.stringify(gapTraceItem)}`);
}
if (!followupPayload.trace?.contextMemory?.diagnostics || typeof followupPayload.trace.contextMemory.diagnostics.selectedCount !== "number") {
  throw new Error(`context memory trace should expose budget diagnostics: ${JSON.stringify(followupPayload.trace?.contextMemory)}`);
}
if (typeof followupPayload.trace?.contextMemory?.contextEpoch !== "number") {
  throw new Error(`context memory trace should expose context epoch: ${JSON.stringify(followupPayload.trace?.contextMemory)}`);
}
runner.finish("继续 imsdk 分析");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();

const repeatedFollowupTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "？", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!repeatedFollowupTurn.ok) {
  throw new Error(`repeated follow-up should start: ${JSON.stringify(repeatedFollowupTurn)}`);
}
const repeatedFollowupPayload = runner.sentPayloads.at(-1);
if (!repeatedFollowupPayload.trace?.contextMemory?.deduped) {
  throw new Error(`unchanged context memory should be deduped: ${JSON.stringify(repeatedFollowupPayload.trace?.contextMemory)}`);
}
if (repeatedFollowupPayload.text.includes("[Lily Memory Context]")) {
  throw new Error("deduped memory context should not be injected into engine text again");
}
runner.finish("继续 imsdk 分析 2");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();

markSessionCompacted("s1", {
  runtime: "opencode",
  mode: "native",
  reason: "test_epoch",
  at: "2026-06-25T13:00:00.000Z",
});
const afterCompactionFollowup = await ctx.turnOrchestrator.sendUserMessage("s1", "？", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!afterCompactionFollowup.ok) {
  throw new Error(`post-compaction follow-up should start: ${JSON.stringify(afterCompactionFollowup)}`);
}
const afterCompactionPayload = runner.sentPayloads.at(-1);
if (afterCompactionPayload.trace?.contextMemory?.deduped) {
  throw new Error(`compaction epoch should force memory reinjection: ${JSON.stringify(afterCompactionPayload.trace?.contextMemory)}`);
}
if (afterCompactionPayload.trace?.contextMemory?.contextEpoch < 1) {
  throw new Error(`post-compaction trace should show advanced context epoch: ${JSON.stringify(afterCompactionPayload.trace?.contextMemory)}`);
}
if (!afterCompactionPayload.text.includes("[Lily Memory Context]")) {
  throw new Error("post-compaction memory context should be injected again");
}
runner.finish("继续 imsdk 分析 3");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();

await new Promise((resolve) => setTimeout(resolve, 20));
ctx.eventBus.flush();
if (!sent.some((entry) => entry.payload?.events?.some((event) => event.type === "context.compactionDecision" && event.payload?.reason))) {
  throw new Error(`completed turns should publish background compaction decisions: ${JSON.stringify(sent)}`);
}

sent.length = 0;
runner.compactions.length = 0;
clearSessionSummary("s1");
updateSessionSummaryFromRecord("s1", {
  terminal: "turn.completed",
  user: { text: "huge prompt" },
  assistantText: "ok",
  meta: { engine: { promptChars: 400_000, estimatedPromptTokens: 100_000 } },
  fileChanges: [],
});
ctx.turnOrchestrator._scheduleBackgroundCompaction("s1");
await new Promise((resolve) => setTimeout(resolve, 20));
ctx.eventBus.flush();
if (!runner.compactions.length) {
  throw new Error("token pressure should trigger native compaction before turn-count threshold");
}
if (!sent.some((entry) => entry.payload?.events?.some((event) => (
  event.type === "context.compactionDecision" &&
  event.payload?.reason === "token_pressure" &&
  event.payload?.estimatedPromptTokens === 100_001
)))) {
  throw new Error(`token-pressure compaction should include retained assistant output in diagnostics: ${JSON.stringify(sent)}`);
}

sent.length = 0;
runner.compactions.length = 0;
clearSessionSummary("s1");
for (let i = 0; i < 30; i += 1) {
  updateSessionSummaryFromRecord("s1", {
    terminal: "turn.completed",
    user: { text: `long session turn ${i}` },
    assistantText: "ok",
    fileChanges: [],
  });
}
ctx.turnOrchestrator._scheduleBackgroundCompaction("s1");
await new Promise((resolve) => setTimeout(resolve, 20));
ctx.eventBus.flush();
if (!runner.compactions.length) {
  throw new Error("long idle sessions should invoke native compaction");
}
if (!sent.some((entry) => entry.payload?.events?.some((event) => event.type === "engine.notice" && event.payload?.notice?.code === "compactBoundary"))) {
  throw new Error(`native compaction should publish a compactBoundary notice before compacting: ${JSON.stringify(sent)}`);
}

sent.length = 0;
runner.compactions.length = 0;
runner.spawnOptions.model = { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" };
clearSessionSummary("s1");
for (let i = 0; i < 30; i += 1) {
  updateSessionSummaryFromRecord("s1", {
    terminal: "turn.completed",
    user: { text: `anthropic-compatible deepseek turn ${i}` },
    assistantText: "ok",
    fileChanges: [],
  });
}
ctx.turnOrchestrator._scheduleBackgroundCompaction("s1");
await new Promise((resolve) => setTimeout(resolve, 20));
ctx.eventBus.flush();
if (!runner.compactions.length) {
  throw new Error("Anthropic-compatible non-Claude models should use native summarize after compaction agents are pinned");
}
if (!sent.some((entry) => entry.payload?.events?.some((event) => (
  event.type === "context.compactionDecision" &&
  event.payload?.reason === "long_session" &&
  event.payload?.providerID === "anthropic" &&
  event.payload?.modelID === "deepseek-v4-pro[1m]"
)))) {
  throw new Error(`anthropic-compatible compaction should publish a native compaction decision: ${JSON.stringify(sent)}`);
}
runner.spawnOptions = {};

sent.length = 0;
runner.compactions.length = 0;
runner.compactResult = false;
clearSessionSummary("s1");
for (let i = 0; i < 30; i += 1) {
  updateSessionSummaryFromRecord("s1", {
    terminal: "turn.completed",
    user: { text: `failing compaction turn ${i}` },
    assistantText: "ok",
    fileChanges: [],
  });
}
ctx.turnOrchestrator._scheduleBackgroundCompaction("s1");
await new Promise((resolve) => setTimeout(resolve, 20));
ctx.eventBus.flush();
if (!runner.compactions.length) {
  throw new Error("long idle sessions should still try native compaction before a failure is recorded");
}
const failedCompactionEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (!failedCompactionEvents.some((event) => event.type === "engine.notice" && event.payload?.notice?.code === "compactFailed")) {
  throw new Error(`failed native compaction should publish a terminal replacement notice: ${JSON.stringify(sent)}`);
}

sent.length = 0;
runner.compactions.length = 0;
ctx.turnOrchestrator._scheduleBackgroundCompaction("s1");
await new Promise((resolve) => setTimeout(resolve, 20));
ctx.eventBus.flush();
if (runner.compactions.length) {
  throw new Error("recent failed compaction should be rate-limited");
}
if (!sent.some((entry) => entry.payload?.events?.some((event) => (
  event.type === "context.compactionDecision" &&
  event.payload?.reason === "recent_compaction_failure"
)))) {
  throw new Error(`recent compaction failures should publish a skip decision: ${JSON.stringify(sent)}`);
}
runner.compactResult = { ok: true };

sent.length = 0;
const interruptSource = await ctx.turnOrchestrator.sendUserMessage("s1", "long running", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!interruptSource.ok || !runner.isBusy()) {
  throw new Error(`interrupt source turn should start and own the runner: ${JSON.stringify(interruptSource)}`);
}
const staleQueue = await ctx.turnOrchestrator.sendUserMessage("s1", "stale queued", [], {
  skipPreflight: true,
});
if (!staleQueue.queued) {
  throw new Error(`busy send should enter the current-session queue: ${JSON.stringify(staleQueue)}`);
}
const scheduledQueue = await ctx.turnOrchestrator.sendUserMessage("s1", "scheduled queued", [], {
  skipPreflight: true,
  scheduledTaskRunId: "run_queued_stop",
});
if (!scheduledQueue.queued) {
  throw new Error(`busy scheduled run should enter the queue: ${JSON.stringify(scheduledQueue)}`);
}
const cancelledScheduled = ctx.turnOrchestrator.cancelQueuedScheduledRun("s1", "run_queued_stop");
if (!cancelledScheduled.ok) {
  throw new Error(`one scheduled run should be cancellable without clearing the conversation: ${JSON.stringify(cancelledScheduled)}`);
}
if (!ctx.turnOrchestrator._state("s1").queue.some((item) => item.id === staleQueue.itemId)) {
  throw new Error("cancelling a scheduled run must preserve unrelated messages in the same conversation queue");
}
ctx.turnOrchestrator.interrupt("s1");
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (!allEvents.some((event) => event.type === "turn.interrupted" && event.turnId === interruptSource.turnId)) {
  throw new Error("stop must finalize the active turn as interrupted");
}
const clearQueueEvent = allEvents.findLast?.((event) => event.type === "queue.updated")
  || [...allEvents].reverse().find((event) => event.type === "queue.updated");
if (!clearQueueEvent || clearQueueEvent.payload?.items?.length !== 0) {
  throw new Error(`stop must clear the current-session queue: ${JSON.stringify(clearQueueEvent)}`);
}
if (messages.some((message) => message.content === "stale queued")) {
  throw new Error("stopped queued message must not be committed to transcript");
}
if (!completedQueuedRuns.some((item) => item.runId === "run_queued_stop" && item.terminalType === "turn.interrupted")) {
  throw new Error(`exact cancellation must mark the queued scheduled run interrupted: ${JSON.stringify(completedQueuedRuns)}`);
}
// An interrupt before any output must not leave an empty assistant bubble in history.
if (messages.some((message) => message.role === "assistant" && message.turnId === interruptSource.turnId)) {
  throw new Error("interrupt with no output must not commit an empty assistant message");
}

sent.length = 0;
const engineInterruptedTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "engine interrupted", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!engineInterruptedTurn.ok || !runner.isBusy()) {
  throw new Error(`engine interrupted turn should start and own the runner: ${JSON.stringify(engineInterruptedTurn)}`);
}
runner.busy = false;
runner.emit("done", {
  code: 1,
  output: "我已经完成了前面的检查。",
  error: "There's an issue with the selected model. Run --model to pick a different model.",
  interrupted: true,
  interruptedByUser: false,
  engineInterrupted: true,
  source: "cli.result",
});
await new Promise((resolve) => setTimeout(resolve, 0));
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
const engineInterruptedTerminal = allEvents.find((event) => (
  event.turnId === engineInterruptedTurn.turnId
  && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type)
));
if (engineInterruptedTerminal?.type !== "turn.failed") {
  throw new Error(`engine-side interrupted result must fail, not interrupt: ${JSON.stringify(engineInterruptedTerminal)}`);
}
if (engineInterruptedTerminal.payload?.errorCode !== "MODEL_UNAVAILABLE") {
  throw new Error(`engine-side interrupted failure should keep model error code: ${JSON.stringify(engineInterruptedTerminal.payload)}`);
}

sent.length = 0;
const processOnlyFailureTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "process event failure", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!processOnlyFailureTurn.ok || !runner.isBusy()) {
  throw new Error(`process event failure turn should start: ${JSON.stringify(processOnlyFailureTurn)}`);
}
ctx.turnOrchestrator.ingest("s1", [{
  type: "process.event",
  payload: {
    rawType: "result",
    rawSubtype: "error_max_budget_usd",
    event: {
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      errors: ["Maximum budget exceeded"],
    },
    actions: [{ kind: "turn_result", stopReason: "end_turn" }],
  },
}]);
runner.busy = false;
runner.emit("done", {
  code: 1,
  output: "已经完成前面的分析。",
  source: "cli.result",
});
await new Promise((resolve) => setTimeout(resolve, 0));
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
const processOnlyTerminal = allEvents.find((event) => (
  event.turnId === processOnlyFailureTurn.turnId
  && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type)
));
if (processOnlyTerminal?.type !== "turn.failed" || processOnlyTerminal.payload?.errorCode !== "BUDGET_EXCEEDED") {
  throw new Error(`process event failure should classify from archived process event: ${JSON.stringify(processOnlyTerminal)}`);
}

sent.length = 0;
const stalledWithToolsTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "分析 imsdk 流转流程", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!stalledWithToolsTurn.ok || !runner.isBusy()) {
  throw new Error(`stalled-with-tools turn should start: ${JSON.stringify(stalledWithToolsTurn)}`);
}
ctx.turnOrchestrator.ingest("s1", [
  {
    type: "tool.started",
    payload: { id: "task_done", name: "task", input: { description: "Explore imsdk-im server" } },
  },
  {
    type: "tool.done",
    payload: { id: "task_done", status: "done", result: { output: "found message flow" } },
  },
  {
    type: "tool.started",
    payload: { id: "task_failed", name: "task", input: { description: "Explore MXIM client source" } },
  },
  {
    type: "tool.done",
    payload: { id: "task_failed", status: "failed", result: { output: "timeout" } },
  },
]);
runner.busy = false;
runner.emit("done", {
  code: 0,
  output: "",
  stalled: true,
});
await new Promise((resolve) => setTimeout(resolve, 0));
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
const stalledWithToolsTerminal = allEvents.find((event) => (
  event.turnId === stalledWithToolsTurn.turnId
  && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type)
));
if (stalledWithToolsTerminal?.type !== "turn.stalled") {
  throw new Error(`tool-backed stalled turn should remain stalled: ${JSON.stringify(stalledWithToolsTerminal)}`);
}
if (
  !stalledWithToolsTerminal.payload?.assistant?.includes("本轮没有形成完整最终回答") ||
  !stalledWithToolsTerminal.payload?.assistant?.includes("Explore MXIM client source") ||
  !stalledWithToolsTerminal.payload?.assistant?.includes("Explore imsdk-im server") ||
  !stalledWithToolsTerminal.payload?.assistant?.includes("found message flow") ||
  !stalledWithToolsTerminal.payload?.assistant?.includes("timeout")
) {
  throw new Error(`stalled turn should synthesize a useful tool summary: ${JSON.stringify(stalledWithToolsTerminal.payload)}`);
}
const stalledRecord = messages.find((message) => message.role === "assistant" && message.turnId === stalledWithToolsTurn.turnId);
if (!stalledRecord?.content?.includes("本轮没有形成完整最终回答") || !stalledRecord.content.includes("found message flow")) {
  throw new Error(`stalled summary should be persisted to history: ${JSON.stringify(stalledRecord)}`);
}

sent.length = 0;
const stalledPartialTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "为啥是cst", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!stalledPartialTurn.ok || !runner.isBusy()) {
  throw new Error(`stalled-partial turn should start: ${JSON.stringify(stalledPartialTurn)}`);
}
ctx.turnOrchestrator.ingest("s1", [{
  type: "tool.started",
  payload: { id: "task_running", name: "task", input: { description: "Explore sdk-msg-delivery" } },
}]);
ctx.turnOrchestrator.ingest("s1", [{
  type: "assistant.delta",
  payload: { text: "你说得对，之前分析偏向了 cst。" },
}]);
runner.busy = false;
runner.emit("done", {
  code: 0,
  output: "你说得对，之前分析偏向了 cst。",
  stalled: true,
});
await new Promise((resolve) => setTimeout(resolve, 0));
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
const stalledPartialTerminal = allEvents.find((event) => (
  event.turnId === stalledPartialTurn.turnId
  && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type)
));
if (
  stalledPartialTerminal?.type !== "turn.stalled" ||
  !stalledPartialTerminal.payload?.assistant?.includes("你说得对") ||
  !stalledPartialTerminal.payload?.assistant?.includes("本轮没有形成完整最终回答") ||
  !stalledPartialTerminal.payload?.assistant?.includes("Explore sdk-msg-delivery")
) {
  throw new Error(`partial stalled turn should keep partial text and append summary: ${JSON.stringify(stalledPartialTerminal)}`);
}

sent.length = 0;
const emptyCompletionTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "make four images", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!emptyCompletionTurn.ok || !runner.isBusy()) {
  throw new Error(`empty completion guard turn should start: ${JSON.stringify(emptyCompletionTurn)}`);
}
runner.finish("");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
const emptyCompletionTerminal = allEvents.find((event) => (
  event.turnId === emptyCompletionTurn.turnId
  && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type)
));
if (
  emptyCompletionTerminal?.type !== "turn.failed" ||
  emptyCompletionTerminal.payload?.errorCode !== "EMPTY_ASSISTANT_COMPLETION"
) {
  throw new Error(`empty assistant completion must fail visibly, got: ${JSON.stringify(emptyCompletionTerminal)}`);
}
if (
  !/当前模型不可用/.test(emptyCompletionTerminal.payload?.assistant || "") ||
  /selected model did not return|本轮没有形成最终回答|系统已停止继续等待/i.test(emptyCompletionTerminal.payload?.assistant || "")
) {
  throw new Error(`empty assistant completion should show one clear model-unavailable message, got: ${JSON.stringify(emptyCompletionTerminal.payload?.assistant)}`);
}

sent.length = 0;
const runningProcessJobTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "渲染一个视频", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!runningProcessJobTurn.ok || !runner.isBusy()) {
  throw new Error(`running process job turn should start: ${JSON.stringify(runningProcessJobTurn)}`);
}
ctx.turnOrchestrator.ingest("s1", [
  {
    type: "tool.started",
    payload: { id: "job_status_blender", name: "job_status", input: { jobId: "job_blender" } },
  },
  {
    type: "tool.done",
    payload: {
      id: "job_status_blender",
      status: "done",
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            jobId: "job_blender",
            state: "running",
            status: "running",
            progress: { label: "frame", current: 700, total: 2440 },
            outputFiles: ["output/yugong_blender/frame_0007.png"],
          }),
        }],
      },
    },
  },
]);
runner.busy = false;
runner.emit("done", {
  code: 0,
  output: "Blender 还在渲染，等完成。",
});
await waitFor(() => {
  ctx.eventBus.flush();
  return sent.some((entry) => entry.payload?.events?.some((event) => (
    event.turnId === runningProcessJobTurn.turnId
    && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type)
  )));
});
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
const runningProcessJobTerminal = allEvents.find((event) => (
  event.turnId === runningProcessJobTurn.turnId
  && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type)
));
if (
  runningProcessJobTerminal?.type !== "turn.stalled" ||
  !runningProcessJobTerminal.payload?.assistant?.includes("后台任务 job_blender") ||
  runningProcessJobTerminal.payload?.assistant?.includes("已完成 49 个步骤")
) {
  throw new Error(`running process job must not complete the turn: ${JSON.stringify(runningProcessJobTerminal)}`);
}

sent.length = 0;
const originalTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "old work", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!originalTurn.ok || !runner.isBusy()) {
  throw new Error(`priority source turn should start and own the runner: ${JSON.stringify(originalTurn)}`);
}
const priority = await ctx.turnOrchestrator.interruptAndSend("s1", "urgent follow-up", [], {
  displayFiles: [],
  spawnEngine: false,
  skipPreflight: true,
});
if (!priority.ok || !priority.priority || !priority.queued) {
  throw new Error(`interruptAndSend should report a priority queued item: ${JSON.stringify(priority)}`);
}
await new Promise((resolve) => setTimeout(resolve, 0));
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (!allEvents.some((event) => event.type === "turn.interrupted" && event.turnId === originalTurn.turnId)) {
  throw new Error("priority send must interrupt the active turn before dispatching");
}
const urgentStarted = allEvents.find((event) => event.type === "turn.started" && event.turnId !== originalTurn.turnId);
if (!urgentStarted) {
  throw new Error(`priority send must start a replacement turn: ${allEvents.map((event) => event.type).join(",")}`);
}
const urgentQueueEvent = allEvents.findLast?.((event) => event.type === "queue.updated")
  || [...allEvents].reverse().find((event) => event.type === "queue.updated");
if (!urgentQueueEvent || urgentQueueEvent.payload?.items?.length !== 0) {
  throw new Error(`priority queue should flush only after replacement turn starts: ${JSON.stringify(urgentQueueEvent)}`);
}
runner.finish("urgent answer");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
if (!messages.some((message) => message.role === "user" && message.content === "urgent follow-up")) {
  throw new Error("priority message must be committed as the next user turn");
}
if (!messages.some((message) => message.role === "assistant" && message.content === "urgent answer")) {
  throw new Error("priority replacement turn must commit its assistant response");
}

// A priority send must also cancel a normal send that is still waiting on the
// managed-model preflight. At this point the original request has no turn id
// yet, so interrupt() alone cannot see or close it.
{
  const ipcUtils = require("../src/main/ipc-utils.js");
  const originalRefreshRemoteConfigForSend = ipcUtils.refreshRemoteConfigForSend;
  const originalDiagnoseSendBlocker = ctx.diagnoseSendBlocker;
  let releaseRefresh;
  let refreshStarted;
  const refreshReady = new Promise((resolve) => { releaseRefresh = resolve; });
  const refreshObserved = new Promise((resolve) => { refreshStarted = resolve; });
  ipcUtils.refreshRemoteConfigForSend = async () => {
    refreshStarted();
    await refreshReady;
    return { ok: false };
  };
  ctx.diagnoseSendBlocker = () => ({ error: "SERVICE_MODEL_CONFIG_UNAVAILABLE" });
  try {
    sent.length = 0;
    const preflight = ctx.turnOrchestrator.sendUserMessage("s1", "slow preflight", [], {
      spawnEngine: false,
    });
    await refreshObserved;
    const urgent = await ctx.turnOrchestrator.interruptAndSend("s1", "preflight priority", [], {
      spawnEngine: false,
      skipPreflight: true,
    });
    if (!urgent.ok || !urgent.priority) {
      throw new Error(`preflight priority send should be queued: ${JSON.stringify(urgent)}`);
    }
    releaseRefresh();
    const cancelled = await preflight;
    if (cancelled.error !== "TURN_START_ABORTED") {
      throw new Error(`preflight send should be cancelled before turn creation: ${JSON.stringify(cancelled)}`);
    }
    const started = await waitFor(() => {
      ctx.eventBus.flush();
      return sent.some((entry) => entry.payload?.events?.some((event) => (
        event.type === "turn.started" && event.payload?.text === "preflight priority"
      )));
    });
    if (!started) throw new Error("priority send must run after cancelling preflight");
    runner.finish("preflight priority answer");
    await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    ipcUtils.refreshRemoteConfigForSend = originalRefreshRemoteConfigForSend;
    if (originalDiagnoseSendBlocker === undefined) delete ctx.diagnoseSendBlocker;
    else ctx.diagnoseSendBlocker = originalDiagnoseSendBlocker;
  }
}

sent.length = 0;
const memoryProposalTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "记住：以后回答运行时问题先检查 OpenCode 原生能力", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!memoryProposalTurn.ok) {
  throw new Error(`memory proposal turn should start: ${JSON.stringify(memoryProposalTurn)}`);
}
runner.finish("已记下候选");
await new Promise((resolve) => setTimeout(resolve, 5));
ctx.eventBus.flush();
const proposals = listMemoryProposals("p1");
if (!proposals.some((item) => item.text.includes("以后回答运行时问题先检查 OpenCode 原生能力") && item.status === "proposed")) {
  throw new Error(`turn archive should create auto memory proposal, got: ${JSON.stringify(proposals)}`);
}
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (!allEvents.some((event) => event.type === "memory.proposal" && event.payload?.proposal?.status === "proposed")) {
  throw new Error(`turn archive should publish a memory.proposal event: ${JSON.stringify(allEvents)}`);
}

sent.length = 0;
const queueState = ctx.turnOrchestrator._state("s1");
const syntheticFailedAdmission = admitTestTurn("s1", {
  turnId: "turn_queue_failed",
  delivery: "queue",
  userText: "will fail",
});
const syntheticNextAdmission = admitTestTurn("s1", {
  turnId: "turn_queue_next",
  delivery: "queue",
  userText: "will start",
});
queueState.queue = [
  {
    id: "queue_failed",
    text: "will fail",
    files: [],
    displayFiles: [],
    admittedTurnInput: syntheticFailedAdmission,
  },
  {
    id: "queue_next",
    text: "will start",
    files: [],
    displayFiles: [],
    admittedTurnInput: syntheticNextAdmission,
  },
];
let dispatchAttempts = 0;
const originalTryStartQueuedItem = ctx.turnOrchestrator._tryStartQueuedItem.bind(ctx.turnOrchestrator);
ctx.turnOrchestrator._tryStartQueuedItem = async () => {
  dispatchAttempts += 1;
  return dispatchAttempts === 1
    ? { ok: false, error: "SYNTHETIC_START_FAILURE" }
    : { ok: true, turnId: "synthetic_next" };
};
try {
  await ctx.turnOrchestrator._dispatchNext("s1");
  await new Promise((resolve) => setTimeout(resolve, 0));
} finally {
  ctx.turnOrchestrator._tryStartQueuedItem = originalTryStartQueuedItem;
}
if (dispatchAttempts !== 2) {
  throw new Error(`queue dispatcher should continue after a failed queued item, attempts=${dispatchAttempts}`);
}
if (queueState.queue.length !== 0) {
  throw new Error(`failed queued item should not stick at the queue head: ${JSON.stringify(queueState.queue)}`);
}

queueState.queue = [
  { id: "queue_retry", text: "retry later", files: [], displayFiles: [] },
];
ctx.turnOrchestrator._tryStartQueuedItem = async () => ({ ok: false, retry: true, error: "RUNNER_BUSY" });
try {
  await ctx.turnOrchestrator._dispatchNext("s1");
} finally {
  ctx.turnOrchestrator._tryStartQueuedItem = originalTryStartQueuedItem;
  ctx.turnOrchestrator._clearDispatchRetry("s1");
}
if (queueState.queue.length !== 1 || queueState.queue[0]?.id !== "queue_retry") {
  throw new Error("transient busy runner must not drop the queued message");
}
queueState.queue = [];

const originalCanStartScheduledRun = ctx.scheduledTaskManager.canStartRun;
ctx.scheduledTaskManager.canStartRun = () => false;
const scheduledCapacityItem = {
  id: "queue_scheduled_capacity",
  text: "scheduled capacity",
  files: [],
  displayFiles: [],
  options: {
    skipPreflight: true,
    spawnEngine: false,
    scheduledTaskId: "task_capacity",
    scheduledTaskRunId: "run_capacity",
    nonInteractive: true,
  },
};
scheduledCapacityItem.admittedTurnInput = admitTestTurn("s1", {
  turnId: "turn_scheduled_capacity",
  delivery: "queue",
  userText: scheduledCapacityItem.text,
});
const capacityBlocked = await ctx.turnOrchestrator._tryStartQueuedItem("s1", scheduledCapacityItem);
if (!capacityBlocked?.retry || capacityBlocked.error !== "SCHEDULE_CAPACITY") {
  throw new Error(`scheduled queue must wait without being removed when execution capacity is full: ${JSON.stringify(capacityBlocked)}`);
}
if (runner.isBusy()) {
  throw new Error("capacity-blocked scheduled queue must not start the runner");
}
ctx.scheduledTaskManager.canStartRun = () => true;
const capacityStarted = await ctx.turnOrchestrator._tryStartQueuedItem("s1", scheduledCapacityItem);
ctx.scheduledTaskManager.canStartRun = originalCanStartScheduledRun;
if (!capacityStarted?.ok || !runner.isBusy()) {
  throw new Error(`scheduled queue should start when execution capacity is free: ${JSON.stringify(capacityStarted)}`);
}
if (runner.sentPayloads.at(-1)?.nonInteractive !== true) {
  throw new Error("scheduled queue must preserve nonInteractive through admission into the engine payload");
}
const startedCapacityRun = startedScheduledRuns.find((item) => item.runId === "run_capacity");
if (!startedCapacityRun) {
  throw new Error(`scheduled queue must mark the exact run started: ${JSON.stringify(startedScheduledRuns)}`);
}
const durableCapacityTurn = durableTurns.get("turn_scheduled_capacity");
if (
  !startedCapacityRun.dispatchAttemptId
  || startedCapacityRun.dispatchAttemptId !== durableCapacityTurn?.dispatchAttemptId
  || startedCapacityRun.dispatchStartedAt !== durableCapacityTurn?.dispatchStartedAt
) {
  throw new Error(
    `scheduled run must reuse the durable dispatch claim identity and time: ${JSON.stringify({
      startedCapacityRun,
      durableCapacityTurn,
    })}`,
  );
}
runner.finish("scheduled capacity done");
await new Promise((resolve) => setTimeout(resolve, 5));

queueState.queue = [
  { id: "queue_retry_then_start", text: "retry then start", files: [], displayFiles: [] },
];
const previousRetryDelay = TurnOrchestrator.QUEUE_RETRY_DELAY_MS;
TurnOrchestrator.QUEUE_RETRY_DELAY_MS = 10;
let retryThenStartAttempts = 0;
ctx.turnOrchestrator._tryStartQueuedItem = async () => {
  retryThenStartAttempts += 1;
  return retryThenStartAttempts === 1
    ? { ok: false, retry: true, error: "RUNNER_BUSY" }
    : { ok: true, turnId: "retry_then_start" };
};
try {
  await ctx.turnOrchestrator._dispatchNext("s1");
  await new Promise((resolve) => setTimeout(resolve, 30));
} finally {
  TurnOrchestrator.QUEUE_RETRY_DELAY_MS = previousRetryDelay;
  ctx.turnOrchestrator._tryStartQueuedItem = originalTryStartQueuedItem;
  ctx.turnOrchestrator._clearDispatchRetry("s1");
}
if (retryThenStartAttempts !== 2) {
  throw new Error(`transient busy runner should be retried, attempts=${retryThenStartAttempts}`);
}
if (queueState.queue.length !== 0) {
  throw new Error(`retried queued message should be removed after start: ${JSON.stringify(queueState.queue)}`);
}

// Wedged runner: the orchestrator turn finalized (phase idle) but the runner
// stays busy forever (abort never settled). The dispatcher must NOT retry
// against it endlessly — that is the "shows idle but the message stays queued"
// bug. After the grace window it recycles the runner and dispatches fresh.
{
  const previousThreshold = TurnOrchestrator.STALE_RUNNER_BUSY_DISPATCHES;
  const previousDelay = TurnOrchestrator.QUEUE_RETRY_DELAY_MS;
  TurnOrchestrator.STALE_RUNNER_BUSY_DISPATCHES = 3;
  TurnOrchestrator.QUEUE_RETRY_DELAY_MS = 1;
  terminatedSessions.length = 0;
  queueState.phase = "idle";
  queueState.dispatchBusyRetries = 0;
  queueState.queue = [{ id: "queue_wedged", text: "still queued", files: [], displayFiles: [] }];
  let wedgedAttempts = 0;
  ctx.turnOrchestrator._tryStartQueuedItem = async () => {
    wedgedAttempts += 1;
    // Recycling clears the wedge: once the session was terminated, a fresh
    // runner starts the item (mirrors runnerPool.ensure building a new runner).
    if (terminatedSessions.includes("s1")) return { ok: true, turnId: "after_recycle" };
    return { ok: false, retry: true, error: "RUNNER_BUSY" };
  };
  try {
    // Drive the retry timer the full grace window; the 3rd busy retry trips
    // the recycle, and the immediate re-dispatch then starts the item.
    for (let i = 0; i < 5; i += 1) {
      await ctx.turnOrchestrator._dispatchNext("s1");
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  } finally {
    TurnOrchestrator.STALE_RUNNER_BUSY_DISPATCHES = previousThreshold;
    TurnOrchestrator.QUEUE_RETRY_DELAY_MS = previousDelay;
    ctx.turnOrchestrator._tryStartQueuedItem = originalTryStartQueuedItem;
    ctx.turnOrchestrator._clearDispatchRetry("s1");
  }
  if (!terminatedSessions.includes("s1")) {
    throw new Error("a runner wedged busy while the session is idle must be recycled, not retried forever");
  }
  if (queueState.queue.length !== 0) {
    throw new Error(`the queued message must be dispatched after the wedged runner is recycled: ${JSON.stringify(queueState.queue)}`);
  }
  queueState.queue = [];
  queueState.dispatchBusyRetries = 0;
}

// Queue dispatch is linearized against principal changes only after all
// deterministic preparation has completed. A delayed compaction stands in for
// document/memory preflight: A must remain admitted while it waits, switching
// to B must prevent A from reaching the runner, and completing A's stale
// dispatch must never shift/drop B from the queue.
{
  const originalCompactBeforeTurn = ctx.turnOrchestrator._maybeCompactBeforeTurn;
  const originalDiagnoseSendBlocker = ctx.diagnoseSendBlocker;
  const originalEnsureSessionRunner = ctx.ensureSessionRunner;
  const sentBefore = runner.sentPayloads.length;
  const claimsBefore = dispatchClaims.length;
  let releasePreflight;
  let preflightEntered = false;
  const preflightGate = new Promise((resolve) => {
    releasePreflight = resolve;
  });
  ctx.turnOrchestrator._maybeCompactBeforeTurn = async () => {
    preflightEntered = true;
    await preflightGate;
    return null;
  };
  ctx.diagnoseSendBlocker = () => null;
  ctx.ensureSessionRunner = () => ({
    runner,
    coldStart: false,
    usedResume: false,
  });

  activeTestOwnerScope = testOwnerScope;
  await waitFor(() => !ctx.turnOrchestrator.dispatchInFlight.has("s1"));
  ctx.turnOrchestrator._clearDispatchRetry("s1");
  queueState.phase = "idle";
  queueState.turnId = null;
  queueState.queue = [];
  runner.busy = false;
  const itemA = {
    id: "queue_owner_epoch_a",
    text: "owner A delayed preflight",
    files: [],
    displayFiles: [],
    options: {
      skipVision: true,
      skipDocument: true,
      spawnEngine: false,
      queueOrigin: "user",
    },
  };
  const admissionA = ctx.turnOrchestrator._admitQueuedTurn(session, itemA);
  if (!admissionA.ok) throw new Error(`owner A admission failed: ${JSON.stringify(admissionA)}`);
  queueState.queue.push(itemA);
  const dispatchA = ctx.turnOrchestrator._dispatchNext("s1");
  if (!await waitFor(() => preflightEntered)) {
    throw new Error("owner race test never entered deterministic preflight");
  }
  if (durableTurns.get(itemA.admittedTurnInput.turnId)?.status !== "admitted") {
    throw new Error("dispatch CAS must not run before deterministic preflight completes");
  }
  if (dispatchClaims.length !== claimsBefore) {
    throw new Error("delayed preflight must not create a dispatch attempt");
  }

  activeTestOwnerScope = otherTestOwnerScope;
  ctx.turnOrchestrator.handlePrincipalChange();
  const itemB = {
    id: "queue_owner_epoch_b",
    text: "owner B remains queued",
    files: [],
    displayFiles: [],
    options: {
      skipVision: true,
      skipDocument: true,
      spawnEngine: false,
      queueOrigin: "user",
    },
  };
  const admissionB = ctx.turnOrchestrator._admitQueuedTurn(session, itemB);
  if (!admissionB.ok) throw new Error(`owner B admission failed: ${JSON.stringify(admissionB)}`);
  queueState.queue.push(itemB);
  runner.busy = true;
  releasePreflight();
  await dispatchA;
  await new Promise((resolve) => setTimeout(resolve, 5));

  if (
    runner.sentPayloads.slice(sentBefore).some(
      (payload) => String(payload?.rawText || payload?.text || "").includes("owner A delayed"),
    )
  ) {
    throw new Error("owner A must not reach sendUserMessage after the principal epoch changes");
  }
  if (!queueState.queue.some((item) => item.id === itemB.id)) {
    throw new Error("stale owner A completion must not shift or delete owner B's queue item");
  }
  if (durableTurns.get(itemA.admittedTurnInput.turnId)?.status !== "admitted") {
    throw new Error("owner A durable admission must remain recoverable after an account switch");
  }
  if (durableTurns.get(itemB.admittedTurnInput.turnId)?.status !== "admitted") {
    throw new Error("owner B durable admission must remain admitted while its runner is busy");
  }

  activeTestOwnerScope = testOwnerScope;
  runner.busy = true;
  ctx.turnOrchestrator.handlePrincipalChange();
  if (!queueState.queue.some(
    (item) => item.admittedTurnInput?.turnId === itemA.admittedTurnInput.turnId,
  )) {
    throw new Error("switching back to owner A must restore its durable admitted turn");
  }
  runner.busy = false;
  ctx.turnOrchestrator._maybeCompactBeforeTurn = async () => null;
  await ctx.turnOrchestrator._dispatchNext("s1");
  if (
    runner.sentPayloads.filter(
      (payload) => String(payload?.rawText || payload?.text || "").includes("owner A delayed"),
    ).length !== 1
  ) {
    throw new Error("owner A restored admission must execute exactly once after switching back");
  }
  runner.finish("owner A restored");
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The paused projection must use the NON-terminal turn.paused signal: the
  // bus permanently filters post-terminal events per turnId, and this exact
  // turnId is revived by the re-dispatch above. Assert the revived turn's
  // full event stream is actually delivered, not just durably recorded.
  const deliveredForA = sent.flatMap((entry) => entry.payload?.events || []).filter(
    (event) => event.turnId === itemA.admittedTurnInput.turnId,
  );
  if (!deliveredForA.some(
    (event) => event.type === "turn.paused" && event.payload?.principalChanged,
  )) {
    throw new Error("owner pause must emit the non-terminal turn.paused signal for the durable turn");
  }
  if (deliveredForA.some((event) => event.type === "turn.interrupted")) {
    throw new Error("a resumable paused turn must never emit terminal turn.interrupted for its durable turnId");
  }
  if (!deliveredForA.some((event) => event.type === "assistant.final")) {
    throw new Error("the revived turn's assistant.final must be delivered after re-dispatch");
  }
  if (!deliveredForA.some((event) => event.type === "turn.completed")) {
    throw new Error("the revived turn's turn.completed must be delivered after re-dispatch");
  }
  ctx.turnOrchestrator._maybeCompactBeforeTurn = originalCompactBeforeTurn;
  if (originalDiagnoseSendBlocker === undefined) delete ctx.diagnoseSendBlocker;
  else ctx.diagnoseSendBlocker = originalDiagnoseSendBlocker;
  if (originalEnsureSessionRunner === undefined) delete ctx.ensureSessionRunner;
  else ctx.ensureSessionRunner = originalEnsureSessionRunner;
  queueState.queue = [];
}

// A deterministic preflight exception must terminalize the still-admitted
// queue row and produce a visible failure without consuming a dispatch
// attempt. A synchronous runner throw happens after claim but is still known
// not to have delivered, so it uses the dedicated pre_send_throw terminal CAS.
{
  activeTestOwnerScope = testOwnerScope;
  const originalCompactBeforeTurn = ctx.turnOrchestrator._maybeCompactBeforeTurn;
  const originalDiagnoseSendBlocker = ctx.diagnoseSendBlocker;
  const originalEnsureSessionRunner = ctx.ensureSessionRunner;
  const originalSendUserMessage = runner.sendUserMessage;
  const claimsBefore = dispatchClaims.length;
  const failureEventsBefore = sent.filter(
    (entry) => entry.payload?.events?.some((event) => event.type === "turn.failed"),
  ).length;
  queueState.phase = "idle";
  queueState.turnId = null;
  queueState.queue = [];
  runner.busy = false;
  ctx.diagnoseSendBlocker = () => null;
  ctx.ensureSessionRunner = () => ({
    runner,
    coldStart: false,
    usedResume: false,
  });
  ctx.turnOrchestrator._maybeCompactBeforeTurn = async () => {
    throw new Error("deterministic memory preflight failed");
  };
  const preflightItem = {
    id: "queue_preflight_failure",
    text: "preflight must fail before claim",
    files: [],
    displayFiles: [],
    options: {
      skipVision: true,
      skipDocument: true,
      spawnEngine: false,
      queueOrigin: "user",
    },
  };
  const preflightAdmission = ctx.turnOrchestrator._admitQueuedTurn(session, preflightItem);
  queueState.queue.push(preflightItem);
  await ctx.turnOrchestrator._dispatchNext("s1");
  if (dispatchClaims.length !== claimsBefore) {
    throw new Error("deterministic preflight failure must not create a dispatch attempt");
  }
  if (durableTurns.get(preflightAdmission.turn.turnId)?.status !== "failed") {
    throw new Error("deterministic preflight failure must terminalize admitted -> failed");
  }
  if (queueState.queue.some((item) => item.id === preflightItem.id)) {
    throw new Error("failed deterministic preflight must remove the exact queue item");
  }
  const failureEventsAfter = sent.filter(
    (entry) => entry.payload?.events?.some((event) => event.type === "turn.failed"),
  ).length;
  if (failureEventsAfter !== failureEventsBefore + 1) {
    throw new Error("deterministic preflight failure must emit one visible turn.failed event");
  }

  ctx.turnOrchestrator._maybeCompactBeforeTurn = async () => null;
  runner.sendUserMessage = () => {
    throw new Error("synchronous pre-send throw");
  };
  const throwItem = {
    id: "queue_pre_send_throw",
    text: "runner throws synchronously",
    files: [],
    displayFiles: [],
    options: {
      skipVision: true,
      skipDocument: true,
      spawnEngine: false,
      queueOrigin: "user",
    },
  };
  const throwAdmission = ctx.turnOrchestrator._admitQueuedTurn(session, throwItem);
  queueState.queue.push(throwItem);
  await ctx.turnOrchestrator._dispatchNext("s1");
  const preSendTerminal = terminalClaims.find(
    (entry) => entry.claim.turnId === throwAdmission.turn.turnId,
  );
  if (
    preSendTerminal?.patch?.metadata?.dispatchFailureReason !== "pre_send_throw"
    || !preSendTerminal.claim.fromStatuses.includes("dispatching")
  ) {
    throw new Error(
      `synchronous send throw must use the dedicated dispatching -> failed CAS: ${JSON.stringify(preSendTerminal)}`,
    );
  }
  if (durableTurns.get(throwAdmission.turn.turnId)?.status !== "failed") {
    throw new Error("synchronous pre-send throw must become a durable failure");
  }
  runner.sendUserMessage = originalSendUserMessage;
  ctx.turnOrchestrator._maybeCompactBeforeTurn = originalCompactBeforeTurn;
  if (originalDiagnoseSendBlocker === undefined) delete ctx.diagnoseSendBlocker;
  else ctx.diagnoseSendBlocker = originalDiagnoseSendBlocker;
  if (originalEnsureSessionRunner === undefined) delete ctx.ensureSessionRunner;
  else ctx.ensureSessionRunner = originalEnsureSessionRunner;
  queueState.queue = [];
  runner.busy = false;
}

// admitExternalCommand: the mobile injection seam (MC-SPEC-008 §3.3). A mobile
// command enters an idle session as exactly one FIFO item carrying durable
// command metadata; a replay does not enqueue twice; a reused key with a new
// payload is rejected; a requested steer is admitted as queue with a downgrade
// reason (runner.steer never called).
{
  // Drive the seam against a BUSY session so admitted items stay in the queue
  // (the heavy real dispatch path is covered by the existing queue tests; here
  // we verify admission, enqueue metadata, and idempotency deterministically).
  const busyState = ctx.turnOrchestrator._state("s1");
  busyState.phase = "streaming";
  busyState.turnId = "turn_active_ext";
  busyState.queue = [];
  ctx.turnOrchestrator._clearDispatchRetry?.("s1");
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };

  const envelope = {
    commandId: "cmd_ext_1",
    idempotencyKey: "idem_ext_1",
    payloadHash: "hash_1",
    lilySessionId: "s1",
    mobileDeviceId: "dmob",
    desktopDeviceId: "dtop",
    remoteSessionId: "rs_1",
    text: "从手机发来的任务",
    mode: "queue",
    sourceSequence: 1,
  };

  const first = await ctx.turnOrchestrator.admitExternalCommand(envelope);
  must(first.ok === true, `admit should succeed: ${JSON.stringify(first)}`);
  must(first.commandId === "cmd_ext_1", "admission returns the commandId");
  must(first.effectiveMode === "queue", "queue command admits as queue");
  must(busyState.queue.length === 1, "the command is admitted as exactly one FIFO item");
  const admittedItem = busyState.queue[0];
  must(admittedItem.options?.externalCommand?.commandId === "cmd_ext_1", "durable command metadata rides the queue item");
  must(admittedItem.options?.queueOrigin === "mobile_command", "the item is marked as a mobile command");

  // Replay of the same command must NOT enqueue again.
  const replay = await ctx.turnOrchestrator.admitExternalCommand(envelope);
  must(replay.ok === true, "a replay returns the existing admission");
  must(replay.commandId === "cmd_ext_1", "replay returns the same commandId");
  must(busyState.queue.length === 1, "a replayed command never enqueues a second item");

  // Same key, new payload → rejected (never overwrites the original command).
  const conflict = await ctx.turnOrchestrator.admitExternalCommand({ ...envelope, payloadHash: "hash_DIFFERENT" });
  must(conflict.ok === false && conflict.code === "IDEMPOTENCY_CONFLICT", "a reused key with a new payload is rejected");
  must(busyState.queue.length === 1, "a conflicting command does not enqueue");

  // Requested steer is admitted as queue with the downgrade reason surfaced.
  const steer = await ctx.turnOrchestrator.admitExternalCommand({
    ...envelope, commandId: "cmd_ext_2", idempotencyKey: "idem_ext_2", payloadHash: "hash_2", mode: "steer",
  });
  must(steer.requestedMode === "steer", "requested steer preserved");
  must(steer.effectiveMode === "queue", "steer downgrades to queue under today's engine");
  must(steer.downgradeReason === "STEER_IDEMPOTENCY_UNAVAILABLE", "downgrade reason surfaced to mobile");
  must(busyState.queue.length === 2, "the steer command is admitted as a second queued item");

  // A command targeting a nonexistent session is a non-admission.
  const absent = await ctx.turnOrchestrator.admitExternalCommand({ ...envelope, commandId: "cmd_ext_3", idempotencyKey: "i3", payloadHash: "h3", lilySessionId: "no_such_session" });
  must(absent.ok === false && absent.code === "SESSION_ABSENT", "a command to an unknown session is refused");

  busyState.queue = [];
  busyState.phase = "idle";
  busyState.turnId = null;
}

// Crash-safe exactly-once admission across a restart (contract §3.3). An
// injected in-memory-backed ledger store persists on admit; a fresh orchestrator
// built over the SAME store reloads it, so a mobile command replayed after the
// "restart" resolves to its original admission instead of enqueuing again.
{
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };
  const { createExternalCommandLedgerStore } = require("../src/main/external-command-ledger-store.js");

  // A file the store reads/writes, held in memory so no real disk is touched.
  const disk = new Map();
  const io = {
    existsSync: (p) => disk.has(p),
    readFileSync: (p) => disk.get(p),
    writeFileSync: (p, data) => disk.set(p, data),
    renameSync: (a, b) => { disk.set(b, disk.get(a)); disk.delete(a); },
    mkdirSync: () => {},
    dirname: () => "/tmp",
  };
  const makeStore = () => createExternalCommandLedgerStore({
    filePath: "/tmp/restart-ledger.json", io, log: {}, debounceMs: 0,
  });

  const restartCtx = { ...ctx, externalCommandLedgerStore: makeStore() };
  const orchA = new TurnOrchestrator(restartCtx);
  orchA.bindRunner(runner);
  const st = orchA._state("s1");
  st.phase = "streaming"; st.turnId = "t_restart"; st.queue = [];

  const envelope = {
    commandId: "cmd_restart_1", idempotencyKey: "idem_restart_1", payloadHash: "hash_r",
    lilySessionId: "s1", desktopDeviceId: "dtop", mobileDeviceId: "dmob",
    text: "重启前发来的任务", mode: "queue",
  };
  const admitted = await orchA.admitExternalCommand(envelope);
  must(admitted.ok === true, "pre-restart admit succeeds");
  // debounceMs:0 → flush is scheduled on a 0ms timer; let it fire.
  await new Promise((r) => setTimeout(r, 5));
  must(disk.has("/tmp/restart-ledger.json"), "the ledger was persisted to durable storage");

  // "Restart": a brand-new orchestrator over the same durable store.
  const orchB = new TurnOrchestrator({ ...ctx, externalCommandLedgerStore: makeStore() });
  orchB.bindRunner(runner);
  must(orchB.externalCommandRuntime.ledgers.get("s1")?.has("cmd_restart_1"), "the reloaded ledger carries the pre-restart command");
  const st2 = orchB._state("s1");
  st2.phase = "streaming"; st2.turnId = "t_after"; st2.queue = [];

  const replayAfterRestart = await orchB.admitExternalCommand(envelope);
  must(replayAfterRestart.ok === true, "a post-restart replay returns the original admission");
  must(replayAfterRestart.commandId === "cmd_restart_1", "post-restart replay returns the same commandId");
  must(st2.queue.length === 0, "a post-restart replay does NOT enqueue a second turn (exactly-once survives restart)");
}

console.log("turn-orchestrator: ok");
