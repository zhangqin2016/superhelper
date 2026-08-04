// Unit test for the SQLite-backed MessageStore + blob externalization.
// Run: node scripts/test-message-store.mjs  (node:sqlite is built in to Node 22.5+/Electron 41)
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const {
  createQueueRecoveryEnvelope,
} = require("../src/main/turn-queue-recovery-envelope.js");

let passed = 0;
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const ok = (cond, msg) => {
  if (cond) passed += 1;
  else fail(msg);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msgstore-"));
const dbPath = path.join(tmp, "messages.db");
const blobDir = path.join(tmp, "blobs");

// ~600KB base64 data URL — must be externalized to a blob (dedupe two copies).
const bigThumb = "data:image/png;base64," + "A".repeat(600 * 1024);
const smallIcon = "data:image/svg+xml;base64," + "B".repeat(100); // stays inline

try {
  const store = new MessageStore(dbPath, blobDir);

  // --- append a user message with a heavy thumbnail ---
  const userMsg = {
    id: "msg_u1",
    role: "user",
    content: "hello with image",
    timestamp: new Date("2026-01-01T00:00:00Z").toISOString(),
    record: {
      turnId: "t1",
      user: { text: "hello", files: [{ name: "a.png", isImage: true, thumbnail: bigThumb }] },
    },
  };
  store.append("S1", userMsg);

  // assistant turn that reuses the SAME thumbnail (dedupe) + a small inline icon
  store.append("S1", {
    id: "msg_a1",
    role: "assistant",
    timestamp: new Date("2026-01-01T00:01:00Z").toISOString(),
    record: {
      turnId: "t1",
      assistantText: "answer one",
      totalCostUsd: 0.012,
      durationMs: 3400,
      terminal: "turn.completed",
      icon: smallIcon,
      dupThumb: bigThumb,
    },
  });

  ok(store.count("S1") === 2, "count should be 2");

  // --- externalization: big thumb gone from stored bytes, small icon inline ---
  const page = store.getPage("S1", {});
  ok(page.conversation.length === 2, "page returns 2 messages");
  const u = page.conversation[0];
  const a = page.conversation[1];
  ok(u.content === "hello with image", "user content round-trips");
  const thumbRef = u.record.user.files[0].thumbnail;
  ok(thumbRef && thumbRef.__blobRef, "thumbnail replaced by blob ref");
  ok(thumbRef.mime === "image/png", "ref keeps mime");
  ok(typeof a.record.icon === "string" && a.record.icon.startsWith("data:"), "small icon stays inline");
  ok(a.record.assistantText === "answer one", "assistant text round-trips");

  // dedupe: both messages reference the same hash → one blob file, one catalog row
  const hash = thumbRef.__blobRef;
  ok(a.record.dupThumb.__blobRef === hash, "duplicate thumbnail dedupes to same hash");
  ok(store.blobs.exists(hash), "blob bytes written to disk");
  const refRow = store.db.get("SELECT refcount FROM blobs WHERE hash=?", hash);
  ok(refRow.refcount === 2, `blob refcount should be 2, got ${refRow?.refcount}`);

  // --- keyset pagination ---
  for (let i = 0; i < 5; i += 1) {
    store.append("S2", {
      id: `m${i}`,
      role: "user",
      content: `msg ${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
    });
  }
  const p1 = store.getPage("S2", { limit: 2 });
  ok(p1.conversation.map((m) => m.content).join(",") === "msg 3,msg 4", "newest page = last 2 chronological");
  ok(p1.hasMore === true, "hasMore true after newest page");
  const p2 = store.getPage("S2", { before: p1.nextBefore, limit: 2 });
  ok(p2.conversation.map((m) => m.content).join(",") === "msg 1,msg 2", "older page = msg 1,2");
  const p3 = store.getPage("S2", { before: p2.nextBefore, limit: 2 });
  ok(p3.conversation.map((m) => m.content).join(",") === "msg 0", "oldest page = msg 0");
  ok(p3.hasMore === false, "hasMore false at start");

  // --- getAll order ---
  ok(store.getAll("S2").map((m) => m.content).join(",") === "msg 0,msg 1,msg 2,msg 3,msg 4", "getAll chronological");

  // --- removeLast respects role ---
  ok(store.removeLast("S2", "assistant") === false, "removeLast(assistant) no-op when last is user");
  ok(store.removeLast("S2", "user") === true, "removeLast(user) removes");
  ok(store.count("S2") === 4, "count after removeLast is 4");

  // --- FTS search ---
  const hits = store.search("answer");
  ok(hits.length === 1 && hits[0].id === "msg_a1", "FTS finds assistant message");

  // --- GC: clearing S1 drops refcount; blob removed when it hits 0 ---
  store.clear("S1");
  ok(store.count("S1") === 0, "S1 cleared");
  ok(!store.blobs.exists(hash), "blob file GC'd after last ref removed");
  ok(!store.db.get("SELECT 1 FROM blobs WHERE hash=?", hash), "blob catalog row GC'd");

  // --- deleteFromTurn: rewind truncation (the turn + everything after) ---
  for (const t of ["t1", "t2", "t3"]) {
    store.append("S3", { id: `${t}_u`, role: "user", content: `${t} user`, turnId: t });
    store.append("S3", { id: `${t}_a`, role: "assistant", content: `${t} reply`, turnId: t });
  }
  ok(store.count("S3") === 6, "S3 seeded with 3 turns (6 messages)");
  ok(store.deleteFromTurn("S3", "t2") === 4, "deleteFromTurn(t2) removes t2 + t3 (4 messages)");
  ok(store.count("S3") === 2, "only t1 remains after rewind to t2");
  ok(store.getAll("S3").every((m) => m.content.startsWith("t1")), "remaining messages are all t1");
  ok(store.deleteFromTurn("S3", "nope") === 0, "deleteFromTurn on unknown turn is a no-op");

  // --- durable turn admission + runtime projection ---
  const admitted = store.admitTurnInput("S4", {
    turnId: "turn_1",
    delivery: "steer",
    userText: "生成报告",
    files: [{ name: "a.docx" }],
    metadata: { source: "test" },
    createdAt: 1000,
  }, { ownerScope: "owner-terminal-a" });
  ok(admitted.admittedSeq === 1, "first turn input admitted with seq 1");
  ok(admitted.userText === "生成报告", "turn input preserves user-visible text");
  ok(store.pendingTurnInputs("S4").length === 0, "non-queue admission is never auto-recovered");
  const dispatchClaim = store.claimTurnInputDispatch("S4", "turn_1", {
    attemptId: "dispatch_message_store_test",
    startedAt: 1050,
    ownerScope: "owner-terminal-a",
  });
  ok(dispatchClaim.ok === true, "turn input dispatch is claimed atomically");
  const dispatchLoser = store.claimTurnInputDispatch("S4", "turn_1", {
    attemptId: "dispatch_message_store_loser",
    startedAt: 1051,
    ownerScope: "owner-terminal-a",
  });
  ok(
    dispatchLoser.ok === false
      && dispatchLoser.turn.dispatchAttemptId === dispatchClaim.attemptId,
    "a second dispatch CAS loses without replacing the winning attempt",
  );
  const ownerlessDispatchInput = store.admitTurnInput("S4-ownerless-claim", {
    turnId: "turn-ownerless-claim",
    delivery: "direct",
    userText: "must require owner scope",
  }, { ownerScope: "owner-terminal-a" });
  const ownerlessDispatch = store.claimTurnInputDispatch(
    "S4-ownerless-claim",
    ownerlessDispatchInput.turnId,
    { attemptId: "dispatch-ownerless-claim" },
  );
  ok(
    ownerlessDispatch.ok === false
      && ownerlessDispatch.reason === "INVALID_CLAIM"
      && store.getTurnInputByTurnId(
        ownerlessDispatchInput.turnId,
        "owner-terminal-a",
      ).status === "admitted",
    "dispatch CAS requires authoritative owner scope and leaves the row unchanged",
  );
  ok(
    store.markTurnInputPromoted("turn_1", {
      dispatchAttemptId: "dispatch_message_store_loser",
    }) === null,
    "a losing attempt cannot promote another dispatch",
  );
  const promoted = store.markTurnInputPromoted("turn_1", {
    dispatchAttemptId: dispatchClaim.attemptId,
    metadata: { engineTextChanged: true },
  });
  ok(promoted.status === "promoted", "turn input promotion is recorded");
  ok(promoted.metadata.source === "test" && promoted.metadata.engineTextChanged === true, "promotion merges metadata");
  ok(store.outcomeUnknownTurnInputs("S4").length === 1, "promoted turn is outcome-unknown before terminal");
  for (let index = 0; index < 105; index += 1) {
    const turnId = `turn_unknown_${index}`;
    store.admitTurnInput("S4-unknown-bounded", {
      turnId,
      delivery: "direct",
      userText: `unknown ${index}`,
      metadata: {},
      createdAt: 1100 + index,
    });
    store.db.run(
      "UPDATE turn_inputs SET status = 'dispatching' WHERE turn_id = ?",
      turnId,
    );
  }
  const boundedUnknown = store.outcomeUnknownTurnInputs("S4-unknown-bounded");
  ok(boundedUnknown.length === 100, "outcome-unknown recovery query is bounded");
  ok(
    boundedUnknown[0].turnId === "turn_unknown_5"
      && boundedUnknown.at(-1).turnId === "turn_unknown_104",
    "outcome-unknown query keeps the newest bounded window in chronological order",
  );

  const scheduledEnvelope = (queueItemId, runId) => createQueueRecoveryEnvelope({
    item: { id: queueItemId, displayFiles: [] },
    options: {
      queueOrigin: "scheduled_task",
      scheduledTaskId: "durable-dedupe-task",
      scheduledTaskRunId: runId,
    },
  });
  const scheduledContext = {
    ownerScope: "owner-durable-a",
    queueRecoveryEnvelope: scheduledEnvelope("scheduled-item-1", "scheduled-run-durable"),
  };
  const scheduledFirst = store.admitQueuedTurnInput("S4-durable-dedupe", {
    turnId: "scheduled-turn-first",
    delivery: "queue",
    userText: "scheduled first",
  }, scheduledContext);
  ok(
    scheduledFirst.ok === true && scheduledFirst.inserted === true,
    "the first scheduled run is durably admitted",
  );
  store.markTurnInputTerminal({
    ownerScope: "owner-durable-a",
    sessionId: "S4-durable-dedupe",
    turnId: scheduledFirst.turn.turnId,
    dispatchAttemptId: null,
    fromStatuses: ["admitted"],
  }, "turn.completed");
  const scheduledReplay = store.admitQueuedTurnInput("S4-durable-dedupe", {
    turnId: "scheduled-turn-replay",
    delivery: "queue",
    userText: "scheduled replay",
  }, {
    ownerScope: "owner-durable-a",
    queueRecoveryEnvelope: scheduledEnvelope("scheduled-item-2", "scheduled-run-durable"),
  });
  ok(
    scheduledReplay.ok === true
      && scheduledReplay.duplicate === true
      && scheduledReplay.turn.turnId === scheduledFirst.turn.turnId
      && scheduledReplay.turn.status === "completed",
    "a completed scheduled run conflicts to its exact durable turn",
  );
  ok(
    store.db.get(
      "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
      "S4-durable-dedupe",
    ).count === 1,
    "scheduled replay does not add a second durable turn",
  );
  ok(
    store.findTurnInputByAdmissionKey(
      "S4-durable-dedupe",
      "owner-durable-a",
      "scheduled_task_run_id",
      "scheduled-run-durable",
    )?.turnId === scheduledFirst.turn.turnId,
    "scheduled run lookup is backed by its owner/session key",
  );
  ok(
    store.findTurnInputByAdmissionKey(
      "S4-durable-dedupe",
      "owner-durable-b",
      "scheduled_task_run_id",
      "scheduled-run-durable",
    ) === null,
    "scheduled run lookup does not cross owner scope",
  );
  const scheduledOtherOwner = store.admitQueuedTurnInput("S4-durable-dedupe", {
    turnId: "scheduled-turn-other-owner",
    delivery: "queue",
    userText: "scheduled other owner",
  }, {
    ownerScope: "owner-durable-b",
    queueRecoveryEnvelope: scheduledEnvelope(
      "scheduled-item-other-owner",
      "scheduled-run-durable",
    ),
  });
  ok(
    scheduledOtherOwner.inserted === true,
    "another owner may independently admit the same scheduled run id",
  );
  const scheduledOtherSession = store.admitQueuedTurnInput("S4-durable-dedupe-other", {
    turnId: "scheduled-turn-other-session",
    delivery: "queue",
    userText: "scheduled other session",
  }, {
    ownerScope: "owner-durable-a",
    queueRecoveryEnvelope: scheduledEnvelope(
      "scheduled-item-other-session",
      "scheduled-run-durable",
    ),
  });
  ok(
    scheduledOtherSession.inserted === true,
    "another session may independently admit the same scheduled run id",
  );

  const externalEnvelope = (
    queueItemId,
    payloadHash,
    commandId = "external-command-durable",
  ) => createQueueRecoveryEnvelope({
    item: { id: queueItemId, displayFiles: [] },
    options: {
      queueOrigin: "external_command",
      externalCommand: {
        commandId,
        idempotencyKey: "external-idempotency-durable",
        payloadHash,
        desktopDeviceId: "desktop-durable",
        mobileDeviceId: "mobile-durable",
      },
    },
  });
  const externalFirst = store.admitQueuedTurnInput("S4-external-dedupe", {
    turnId: "external-turn-first",
    delivery: "queue",
    userText: "external first",
  }, {
    ownerScope: "owner-durable-a",
    queueRecoveryEnvelope: externalEnvelope("external-item-1", "payload-a"),
  });
  const externalReplay = store.admitQueuedTurnInput("S4-external-dedupe", {
    turnId: "external-turn-replay",
    delivery: "queue",
    userText: "external replay",
  }, {
    ownerScope: "owner-durable-a",
    queueRecoveryEnvelope: externalEnvelope("external-item-2", "payload-a"),
  });
  ok(
    externalFirst.inserted === true
      && externalReplay.duplicate === true
      && externalReplay.turn.turnId === externalFirst.turn.turnId,
    "external command replay resolves to the durable original",
  );
  const externalConflict = store.admitQueuedTurnInput("S4-external-dedupe", {
    turnId: "external-turn-conflict",
    delivery: "queue",
    userText: "external conflict",
  }, {
    ownerScope: "owner-durable-a",
    queueRecoveryEnvelope: externalEnvelope("external-item-3", "payload-b"),
  });
  ok(
    externalConflict.ok === false
      && externalConflict.error === "IDEMPOTENCY_CONFLICT",
    "external idempotency tuple cannot be reused with a different payload hash",
  );
  const externalDifferentCommand = store.admitQueuedTurnInput(
    "S4-external-dedupe-other-session",
    {
      turnId: "external-turn-different-command",
      delivery: "queue",
      userText: "same idempotency under a different command id",
    },
    {
      ownerScope: "owner-durable-a",
      queueRecoveryEnvelope: externalEnvelope(
        "external-item-different-command",
        "payload-a",
        "external-command-different",
      ),
    },
  );
  ok(
    externalDifferentCommand.ok === true
      && externalDifferentCommand.duplicate === true
      && externalDifferentCommand.turn.turnId === externalFirst.turn.turnId
      && externalDifferentCommand.turn.externalCommandId
        === "external-command-durable",
    "same device tuple/idempotency/hash reuses the original turn across command ids and sessions",
  );
  const externalOtherOwner = store.admitQueuedTurnInput(
    "S4-external-dedupe-owner-b",
    {
      turnId: "external-turn-other-owner",
      delivery: "queue",
      userText: "same device tuple from another owner",
    },
    {
      ownerScope: "owner-durable-b",
      queueRecoveryEnvelope: externalEnvelope(
        "external-item-other-owner",
        "payload-a",
        "external-command-other-owner",
      ),
    },
  );
  ok(
    externalOtherOwner.ok === false
      && externalOtherOwner.error === "EXTERNAL_IDENTITY_OWNERSHIP_MISMATCH"
      && externalOtherOwner.turn == null,
    "a device tuple already owned by another principal is rejected without leaking its turn",
  );
  const invalidQueueAdmission = store.admitQueuedTurnInput("S4-invalid-queue", {
    turnId: "invalid-queue-turn",
    delivery: "queue",
    userText: "must not become memory-only work",
  }, { ownerScope: "owner-durable-a", queueRecoveryEnvelope: null });
  ok(
    invalidQueueAdmission.ok === false
      && invalidQueueAdmission.error === "QUEUE_RECOVERY_INVALID"
      && store.db.get(
        "SELECT COUNT(*) AS count FROM turn_inputs WHERE session_id = ?",
        "S4-invalid-queue",
      ).count === 0,
    "queued store admission rejects a missing durable recovery envelope",
  );

  const cancellable = store.admitQueuedTurnInput("S4-cancel", {
    turnId: "turn-cancel-admitted",
    delivery: "queue",
    userText: "cancel before dispatch",
  }, {
    ownerScope: "owner-terminal-a",
    queueRecoveryEnvelope: scheduledEnvelope(
      "scheduled-item-cancel",
      "scheduled-run-cancel",
    ),
  });
  const cancelled = store.markTurnInputTerminal({
    ownerScope: "owner-terminal-a",
    sessionId: "S4-cancel",
    turnId: cancellable.turn.turnId,
    dispatchAttemptId: null,
    fromStatuses: ["admitted"],
  }, "turn.interrupted", { errorCode: "QUEUE_CANCELLED" });
  ok(
    cancelled.ok === true
      && cancelled.turn.status === "interrupted"
      && store.pendingTurnInputs("S4-cancel", "owner-terminal-a").length === 0,
    "durable queue cancellation wins before the in-memory item may be removed",
  );

  const dispatchingCancel = store.admitQueuedTurnInput("S4-cancel-race", {
    turnId: "turn-cancel-dispatching",
    delivery: "queue",
    userText: "cancel after dispatch claim",
  }, {
    ownerScope: "owner-terminal-a",
    queueRecoveryEnvelope: scheduledEnvelope(
      "scheduled-item-cancel-race",
      "scheduled-run-cancel-race",
    ),
  });
  const dispatchingClaim = store.claimTurnInputDispatch(
    "S4-cancel-race",
    dispatchingCancel.turn.turnId,
    {
      ownerScope: "owner-terminal-a",
      attemptId: "dispatch-cancel-race",
    },
  );
  const cancelAfterDispatch = store.markTurnInputTerminal({
    ownerScope: "owner-terminal-a",
    sessionId: "S4-cancel-race",
    turnId: dispatchingCancel.turn.turnId,
    dispatchAttemptId: dispatchingClaim.attemptId,
    fromStatuses: ["admitted"],
  }, "turn.interrupted", { errorCode: "QUEUE_CANCELLED" });
  ok(
    cancelAfterDispatch.ok === false
      && cancelAfterDispatch.outcomeUnknown === true
      && store.getTurnInputByTurnId(
        dispatchingCancel.turn.turnId,
        "owner-terminal-a",
      ).status === "dispatching",
    "dispatching queue cancellation cannot pretend the engine outcome is known",
  );

  const terminalCas = store.admitTurnInput("S4-terminal-cas", {
    turnId: "turn-terminal-cas",
    delivery: "direct",
    userText: "terminal race",
  }, { ownerScope: "owner-terminal-a" });
  const terminalClaim = store.claimTurnInputDispatch(
    "S4-terminal-cas",
    terminalCas.turnId,
    {
      ownerScope: "owner-terminal-a",
      attemptId: "dispatch-terminal-cas",
    },
  );
  store.markTurnInputPromoted(terminalCas.turnId, {
    dispatchAttemptId: terminalClaim.attemptId,
  });
  const wrongTerminalOwner = store.markTurnInputTerminal({
    ownerScope: "owner-terminal-b",
    sessionId: "S4-terminal-cas",
    turnId: terminalCas.turnId,
    dispatchAttemptId: terminalClaim.attemptId,
    fromStatuses: ["promoted"],
  }, "turn.failed");
  const wrongTerminalAttempt = store.markTurnInputTerminal({
    ownerScope: "owner-terminal-a",
    sessionId: "S4-terminal-cas",
    turnId: terminalCas.turnId,
    dispatchAttemptId: "dispatch-terminal-wrong",
    fromStatuses: ["promoted"],
  }, "turn.failed");
  ok(
    wrongTerminalOwner.ok === false && wrongTerminalAttempt.ok === false,
    "terminal CAS rejects wrong owner and dispatch attempt",
  );
  const completedTerminal = store.markTurnInputTerminal({
    ownerScope: "owner-terminal-a",
    sessionId: "S4-terminal-cas",
    turnId: terminalCas.turnId,
    dispatchAttemptId: terminalClaim.attemptId,
    fromStatuses: ["promoted", "accepted"],
  }, "turn.completed");
  const lateFailedTerminal = store.markTurnInputTerminal({
    ownerScope: "owner-terminal-a",
    sessionId: "S4-terminal-cas",
    turnId: terminalCas.turnId,
    dispatchAttemptId: terminalClaim.attemptId,
    fromStatuses: ["promoted", "accepted"],
  }, "turn.failed", { errorCode: "LATE_FAILURE" });
  ok(
    completedTerminal.ok === true
      && completedTerminal.turn.status === "completed"
      && lateFailedTerminal.ok === false
      && store.getTurnInputByTurnId(
        terminalCas.turnId,
        "owner-terminal-a",
      ).status === "completed",
    "terminal CAS is immutable and first terminal wins",
  );

  store.appendRuntimeEvents("S4", [
    {
      id: "evt_1",
      type: "turn.started",
      sessionId: "S4",
      turnId: "turn_1",
      seq: 1,
      ts: 1100,
      source: "orchestrator",
      payload: { text: "生成报告" },
    },
    {
      id: "evt_2",
      type: "assistant.delta",
      sessionId: "S4",
      turnId: "turn_1",
      seq: 2,
      ts: 1200,
      source: "runtime",
      payload: { text: "已生成" },
    },
    {
      id: "evt_3",
      type: "assistant.final",
      sessionId: "S4",
      turnId: "turn_1",
      seq: 3,
      ts: 1300,
      source: "orchestrator",
      payload: { assistant: "已生成完整报告" },
    },
    {
      id: "evt_4",
      type: "turn.completed",
      sessionId: "S4",
      turnId: "turn_1",
      seq: 4,
      ts: 1400,
      source: "orchestrator",
      payload: { assistant: "已生成完整报告" },
    },
  ]);
  ok(store.getRuntimeEvents("S4").length === 4, "runtime events are persisted");
  const projection = store.getTurnProjection("S4", "turn_1");
  ok(projection.status === "completed", "projection terminal status is completed");
  ok(projection.userText === "生成报告", "projection preserves user text");
  ok(projection.assistantText === "已生成完整报告", "projection keeps final assistant text");
  store.appendRuntimeEvents("S4", [{
    id: "evt_4",
    type: "turn.completed",
    sessionId: "S4",
    turnId: "turn_1",
    seq: 4,
    ts: 1400,
    source: "orchestrator",
    payload: { assistant: "重复事件不应重复投影" },
  }]);
  ok(store.getRuntimeEvents("S4").length === 4, "duplicate runtime event id is ignored");
  ok(store.getTurnProjection("S4", "turn_1").assistantText === "已生成完整报告", "duplicate event must not mutate projection");
  const projectedConversation = store.getProjectedConversation("S4");
  ok(projectedConversation.length === 2, "projection builds user + assistant messages");
  ok(projectedConversation[0].role === "user" && projectedConversation[0].content === "生成报告", "projected user message is readable");
  ok(projectedConversation[1].role === "assistant" && projectedConversation[1].content === "已生成完整报告", "projected assistant message is readable");
  ok(projectedConversation[1].record.meta.projected === true, "projected assistant is marked for diagnostics");
  const terminalInput = store.markTurnInputTerminal({
    ownerScope: "owner-terminal-a",
    sessionId: "S4",
    turnId: "turn_1",
    dispatchAttemptId: dispatchClaim.attemptId,
    fromStatuses: ["promoted"],
  }, "turn.completed");
  ok(
    terminalInput.ok === true && terminalInput.turn.status === "completed",
    "turn input terminal status follows terminal event",
  );

  store.appendRuntimeEvents("S4_STEER", [
    {
      id: "steer_evt_1",
      type: "turn.started",
      sessionId: "S4_STEER",
      turnId: "turn_steer",
      seq: 1,
      ts: 2100,
      source: "orchestrator",
      payload: { text: "make a chart" },
    },
    {
      id: "steer_evt_2",
      type: "user.committed",
      sessionId: "S4_STEER",
      turnId: "turn_steer",
      seq: 2,
      ts: 2110,
      source: "orchestrator",
      payload: { text: "make a chart" },
    },
    {
      id: "steer_evt_3",
      type: "user.committed",
      sessionId: "S4_STEER",
      turnId: "turn_steer",
      seq: 3,
      ts: 2120,
      source: "orchestrator",
      payload: { text: "use weekly data too", steer: true, steerSeq: 1 },
    },
    {
      id: "steer_evt_4",
      type: "assistant.final",
      sessionId: "S4_STEER",
      turnId: "turn_steer",
      seq: 4,
      ts: 2130,
      source: "orchestrator",
      payload: { assistant: "chart ready" },
    },
    {
      id: "steer_evt_5",
      type: "turn.completed",
      sessionId: "S4_STEER",
      turnId: "turn_steer",
      seq: 5,
      ts: 2140,
      source: "orchestrator",
      payload: { assistant: "chart ready" },
    },
  ]);
  const steerProjection = store.getProjectedConversation("S4_STEER");
  ok(steerProjection.length === 3, "steer projection builds original user + steer user + assistant");
  ok(steerProjection.filter((m) => m.role === "user").length === 2, "projection keeps both user messages for a steered turn");
  ok(steerProjection.some((m) => m.content === "use weekly data too" && m.meta?.steer && m.meta?.steerSeq === 1), "projected steer keeps visible metadata");
  const persistedSteerEvent = store.getRuntimeEvents("S4_STEER")
    .find((event) => event.id === "steer_evt_3");
  ok(persistedSteerEvent?.payload?.steer === true && persistedSteerEvent.payload.steerSeq === 1, "compacted persisted user.committed keeps steer metadata");

  const hugeToolResult = "R".repeat(120_000);
  store.appendRuntimeEvents("S4", [
    {
      id: "evt_subagent_huge",
      type: "subagent.event",
      sessionId: "S4",
      turnId: "turn_1",
      seq: 5,
      ts: 1500,
      source: "orchestrator",
      payload: {
        subagent: {
          sessionId: "child_1",
          status: "running",
          tools: Array.from({ length: 20 }, (_, i) => ({
            id: `tool_${i}`,
            name: "read",
            status: "done",
            input: { filePath: `/tmp/${i}.txt` },
            result: hugeToolResult,
          })),
          textFull: "T".repeat(20_000),
          textPreview: "preview",
        },
      },
    },
    {
      id: "evt_process_huge",
      type: "process.event",
      sessionId: "S4",
      turnId: "turn_1",
      seq: 6,
      ts: 1600,
      source: "opencode",
      payload: {
        rawType: "session.updated",
        summary: "summary",
        handled: true,
        event: { type: "session.updated", id: "raw_1" },
        rawEvent: { type: "session.updated", properties: { blob: hugeToolResult } },
        effects: [{ kind: "tool", result: hugeToolResult }],
      },
    },
  ]);
  const compactedRuntimeEvents = store.getRuntimeEvents("S4", { afterSeq: 4, limit: 10 });
  const compactedSubagent = compactedRuntimeEvents.find((event) => event.id === "evt_subagent_huge");
  const compactedProcess = compactedRuntimeEvents.find((event) => event.id === "evt_process_huge");
  ok(compactedSubagent?.payload?.subagent?.tools?.length === 8, "subagent persistence keeps only recent compact tool states");
  ok(!("result" in compactedSubagent.payload.subagent.tools[0]), "subagent persistence drops full tool result");
  ok(compactedSubagent.payload.subagent.tools[0].resultPreview.length < 1_000, "subagent persistence stores bounded result preview");
  ok(compactedSubagent.payload.subagent.textFull.length < 1_500, "subagent persistence stores bounded transcript preview");
  ok(!("rawEvent" in compactedProcess.payload), "process persistence drops raw runtime event payload");
  ok(compactedProcess.payload.effects[0].result.length < 700, "process persistence bounds effect result");

  store.db.run(
    `UPDATE runtime_events SET payload_json = ? WHERE id = ?`,
    JSON.stringify({
      subagent: {
        sessionId: "legacy_child",
        tools: [{ id: "legacy_tool", name: "read", result: hugeToolResult }],
        textFull: "T".repeat(20_000),
      },
    }),
    "evt_subagent_huge",
  );
  const compactedLegacy = store.compactRuntimeEventPayloads({ limit: 10, minBytes: 1_000 });
  ok(compactedLegacy.compacted >= 1, "runtime event maintenance compacts legacy oversized payloads");
  const legacyAfter = store.getRuntimeEvents("S4", { afterSeq: 4, limit: 10 })
    .find((event) => event.id === "evt_subagent_huge");
  ok(legacyAfter.payload.subagent.tools[0].resultPreview.length < 1_000, "maintenance removes legacy full subagent result");

  const scheduledDraft = {
    status: "pending",
    source: "model",
    originalText: "please create a schedule every hour. say hello",
    draft: {
      title: "Say hello",
      scheduleText: "Every hour on the hour",
      rrule: "FREQ=HOURLY;INTERVAL=1",
    },
    createdAt: "2026-06-23T14:00:00.000Z",
  };
  store.appendRuntimeEvents("S6", [
    {
      id: "evt_s6_1",
      type: "turn.started",
      sessionId: "S6",
      turnId: "turn_schedule",
      seq: 1,
      ts: 3100,
      source: "orchestrator",
      payload: { text: "please create a schedule every hour. say hello" },
    },
    {
      id: "evt_s6_2",
      type: "assistant.final",
      sessionId: "S6",
      turnId: "turn_schedule",
      seq: 2,
      ts: 3200,
      source: "orchestrator",
      payload: {
        assistant: "I understood this as an automated scheduled task. Confirm to create it.",
        scheduledDraft,
      },
    },
    {
      id: "evt_s6_3",
      type: "turn.completed",
      sessionId: "S6",
      turnId: "turn_schedule",
      seq: 3,
      ts: 3300,
      source: "orchestrator",
      payload: {
        assistant: "I understood this as an automated scheduled task. Confirm to create it.",
        scheduledDraft,
      },
    },
  ]);
  const scheduledProjection = store.getProjectedConversation("S6");
  const scheduledAssistant = scheduledProjection.find((message) => message.role === "assistant");
  ok(
    scheduledAssistant?.meta?.scheduledDraft?.draft?.rrule === "FREQ=HOURLY;INTERVAL=1",
    "projected assistant preserves scheduled draft metadata",
  );
  ok(
    scheduledAssistant?.record?.meta?.scheduledDraft?.draft?.title === "Say hello",
    "projected assistant record preserves scheduled draft metadata",
  );

  store.appendRuntimeEvents("S5", [
    {
      id: "evt_s5_1",
      type: "turn.started",
      sessionId: "S5",
      turnId: "turn_stalled",
      seq: 1,
      ts: 2100,
      source: "orchestrator",
      payload: { text: "检查子任务" },
    },
    {
      id: "evt_s5_2",
      type: "assistant.final",
      sessionId: "S5",
      turnId: "turn_stalled",
      seq: 2,
      ts: 2200,
      source: "orchestrator",
      payload: { assistant: "已完成的子任务和已保留结果：\n- 找到了华为会议代码" },
    },
    {
      id: "evt_s5_3",
      type: "turn.stalled",
      sessionId: "S5",
      turnId: "turn_stalled",
      seq: 3,
      ts: 2300,
      source: "orchestrator",
      payload: { assistant: "已完成的子任务和已保留结果：\n- 找到了华为会议代码" },
    },
  ]);
  const stalledConversation = store.getProjectedConversation("S5");
  const stalledAssistant = stalledConversation.find((message) => message.role === "assistant");
  ok(stalledAssistant?.content.includes("华为会议代码"), "stalled projection keeps partial final content");
  ok(stalledAssistant?.record?.terminal === "turn.stalled", "stalled projection keeps terminal type");
  ok(stalledAssistant.failed !== true, "stalled projection is incomplete, not a failed answer");
  ok(store.pendingTurnInputs("S4").length === 0, "terminal turn no longer pending");

  store.appendRuntimeEvents("S7", [
    {
      id: "evt_s7_1",
      type: "turn.started",
      sessionId: "S7",
      turnId: "turn_partial_crash",
      seq: 1,
      ts: 4100,
      source: "orchestrator",
      payload: { text: "write a long answer" },
    },
    {
      id: "evt_s7_2",
      type: "assistant.delta",
      sessionId: "S7",
      turnId: "turn_partial_crash",
      seq: 2,
      ts: 4200,
      source: "runtime",
      payload: { text: "partial answer before crash" },
    },
  ]);
  const openPartialConversation = store.getProjectedConversation("S7");
  const openPartialAssistant = openPartialConversation.find((message) => message.role === "assistant");
  ok(openPartialAssistant?.content === "partial answer before crash", "open projected turn preserves streamed partial answer");
  ok(openPartialAssistant?.record?.terminal === "turn.stalled", "open projected turn is recovered as stalled after restart");
  ok(openPartialAssistant?.record?.meta?.projected === true, "open projected turn is marked as recovered projection");

  store.appendRuntimeEvents("S9", [
    {
      id: "evt_s9_unknown",
      type: "turn.dispatch_outcome_unknown",
      sessionId: "S9",
      turnId: "turn_unknown_projection",
      seq: 1,
      ts: 4300,
      source: "orchestrator",
      payload: {
        status: "outcome_unknown",
        automaticReplay: false,
        manualRecoveryRequired: true,
        recoveryId: "recovery_turn_unknown_projection",
        errorCode: "DISPATCH_OUTCOME_UNKNOWN",
      },
    },
  ]);
  const unknownProjection = store.getProjectedConversation("S9").find((message) => message.role === "assistant");
  ok(unknownProjection?.failed === true, "outcome-unknown projection must be visible as a failed recovery card");
  ok(unknownProjection?.meta?.outcomeUnknown === true, "outcome-unknown projection must remain distinguishable from confirmed failure");
  ok(unknownProjection?.record?.meta?.manualRecoveryRequired === true, "recovery action metadata must survive projection");

  store.appendRuntimeEvents("S10", [{
    id: "evt_s10_blocked",
    type: "turn.dispatch_blocked",
    sessionId: "S10",
    turnId: "turn_blocked_projection",
    seq: 1,
    ts: 4400,
    source: "orchestrator",
    payload: {
      status: "admitted",
      assistant: "消息未能送达助手引擎，本次没有执行。可以安全重试。",
      automaticReplay: false,
      manualRecoveryRequired: true,
      retryable: true,
    },
  }]);
  const blockedProjection = store.getProjectedConversation("S10").find((message) => message.role === "assistant");
  ok(blockedProjection?.failed === true, "dispatch-blocked projection must remain visible after reload");
  ok(blockedProjection?.meta?.dispatchBlocked === true, "dispatch-blocked projection must remain retryable and distinguishable");

  const crashClaim = store.admitTurnInput("S8", {
    turnId: "turn_dispatching_at_shutdown",
    delivery: "direct",
    userText: "dispatch was claimed before shutdown",
  }, { ownerScope: "owner-restart-state" });
  ok(
    store.claimTurnInputDispatch("S8", crashClaim.turnId, {
      attemptId: "dispatch_before_shutdown",
      startedAt: 5100,
      ownerScope: "owner-restart-state",
    }).ok === true,
    "pre-shutdown dispatch claim is durable",
  );

  // --- persistence across reopen ---
  store.close();
  const store2 = new MessageStore(dbPath, blobDir);
  ok(store2.count("S2") === 4, "data persists across reopen");
  const reopenedPartial = store2.getProjectedConversation("S7").find((message) => message.role === "assistant");
  ok(reopenedPartial?.content === "partial answer before crash", "streamed partial answer persists across reopen");
  ok(
    store2.getTurnInputByTurnId(
      "turn_dispatching_at_shutdown",
      "owner-restart-state",
    )?.status === "outcome_unknown",
    "reopen durably distinguishes an interrupted dispatch from a live dispatching attempt",
  );
  ok(
    store2.claimTurnInputDispatch("S8", "turn_dispatching_at_shutdown", {
      attemptId: "dispatch_after_shutdown",
      ownerScope: "owner-restart-state",
    }).ok === false,
    "an outcome-unknown dispatch is never automatically reclaimed",
  );
  store2.close();

  console.log(`\nmessage-store: ${passed} checks passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
