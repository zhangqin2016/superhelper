// Unit test for the SQLite-backed MessageStore + blob externalization.
// Run: node scripts/test-message-store.mjs  (node:sqlite is built in to Node 22.5+/Electron 41)
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");

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
  });
  ok(admitted.admittedSeq === 1, "first turn input admitted with seq 1");
  ok(admitted.userText === "生成报告", "turn input preserves user-visible text");
  ok(store.pendingTurnInputs("S4").length === 1, "admitted turn is pending before terminal");
  const promoted = store.markTurnInputPromoted("turn_1", { metadata: { engineTextChanged: true } });
  ok(promoted.status === "promoted", "turn input promotion is recorded");
  ok(promoted.metadata.source === "test" && promoted.metadata.engineTextChanged === true, "promotion merges metadata");

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
  const terminalInput = store.markTurnInputTerminal("turn_1", "turn.completed");
  ok(terminalInput.status === "completed", "turn input terminal status follows terminal event");

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

  // --- persistence across reopen ---
  store.close();
  const store2 = new MessageStore(dbPath, blobDir);
  ok(store2.count("S2") === 4, "data persists across reopen");
  store2.close();

  console.log(`\nmessage-store: ${passed} checks passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
