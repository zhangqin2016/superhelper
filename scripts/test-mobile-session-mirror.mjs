#!/usr/bin/env node
// Runtime events → phone frames, to exactly the phones watching that session;
// the real payload shapes (a string `assistant`); the phone's command named on
// its turn; a fresh conversation once a turn settles.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createSessionMirror, phoneFrameForEvent } = require(path.join(ROOT, "src/main/mobile/session-mirror.js"));
const { RuntimeEventBus } = require(path.join(ROOT, "src/main/runtime-event-bus.js"));

const ev = (type, payload = {}, turnId = "t1") => ({ type, turnId, payload });

// --- mapping, with the payload shapes the runtime really emits ---------------
{
  const commandOf = (turnId) => (turnId === "t1" ? "cmd_phone_1" : "");
  assert.deepEqual(phoneFrameForEvent(ev("turn.started", { text: "整理日志", files: [{}] }), "s1", commandOf),
    { type: "turn.started", turnId: "t1", sessionId: "s1", userText: "整理日志", files: 1, commandId: "cmd_phone_1" },
    "a phone's turn names its command (read from the turn's admission record)");
  assert.deepEqual(phoneFrameForEvent(ev("turn.started", { text: "桌面上问的" }, "t2"), "s1", commandOf),
    { type: "turn.started", turnId: "t2", sessionId: "s1", userText: "桌面上问的", commandId: "" }, "a desktop-typed turn says so: an empty command");
  assert.deepEqual(phoneFrameForEvent(ev("assistant.delta", { text: "片" }), "s1"), { type: "assistant.delta", turnId: "t1", sessionId: "s1", text: "片" });
  assert.equal(phoneFrameForEvent(ev("assistant.delta", { text: "" }), "s1"), null);
  assert.deepEqual(phoneFrameForEvent(ev("assistant.final", { assistant: "最终答案" }), "s1"),
    { type: "assistant.final", turnId: "t1", sessionId: "s1", text: "最终答案" }, "the runtime's final text is a STRING");
  assert.deepEqual(phoneFrameForEvent(ev("turn.failed", { assistant: "模型鉴权失败" }), "s1"),
    { type: "turn.ended", turnId: "t1", sessionId: "s1", status: "failed", text: "模型鉴权失败" }, "a failure says why");
  assert.deepEqual(phoneFrameForEvent(ev("turn.completed"), "s1"), { type: "turn.ended", turnId: "t1", sessionId: "s1", status: "completed" });
  assert.deepEqual(phoneFrameForEvent(ev("tool.started", { name: "bash" }), "s1"), { type: "tool.started", turnId: "t1", sessionId: "s1", tool: "bash" });
  assert.equal(phoneFrameForEvent(ev("tool.input.delta", { text: "secret" }), "s1"), null, "tool input never leaves the desktop");
  assert.equal(phoneFrameForEvent(ev("assistant.thinking.delta", { text: "…" }), "s1"), null);
  assert.ok(phoneFrameForEvent(ev("assistant.final", { assistant: "x".repeat(100_000) }), "s1").text.length <= 60_001, "bounded for the relay");
}

// --- routing: only the phones watching the session; snapshot after a settle ---
{
  const bus = new RuntimeEventBus(() => null);
  const conversation = [
    { id: "u1", role: "user", content: "整理日志", turnId: "t1" },
    { id: "a1", role: "assistant", content: "", record: { assistantText: "整理好了" }, turnId: "t1" },
  ];
  const port = {
    findSession: (id) => ({ s1: { id: "s1", title: "修复构建" }, s2: { id: "s2", title: "周报" } })[id] || null,
    turnState: () => ({ phase: "idle", runningTurnId: "", canInterrupt: false, queueLength: 0 }),
    readConversation: async () => conversation,
    turnCommandId: () => "",
    observeRuntime: (listener) => bus.addObserver(listener),
  };
  const phones = [
    { grantId: "gA", targetSessionId: () => "s1" },
    { grantId: "gB", targetSessionId: () => "s2" },
    { grantId: "gC", targetSessionId: () => "s1" },
  ];
  const sent = [];
  const mirror = createSessionMirror({ port, controllers: () => phones, send: (grantId, frame) => sent.push([grantId, frame.type]) });
  mirror.start();

  bus.emit("s1", ev("turn.started", { text: "整理日志" }));
  bus.emit("s1", ev("assistant.delta", { text: "整" }));
  assert.deepEqual(sent, [["gA", "turn.started"], ["gC", "turn.started"], ["gA", "assistant.delta"], ["gC", "assistant.delta"]], "only phones on s1");
  sent.length = 0;
  bus.emit("s1", ev("turn.completed", { assistant: "整理好了" }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, [["gA", "turn.ended"], ["gC", "turn.ended"], ["gA", "session.context"], ["gC", "session.context"]], "a settled turn is followed by the conversation as the desktop shows it");

  const snap = await mirror.snapshot("s1");
  assert.equal(snap.title, "修复构建");
  assert.deepEqual(snap.recent.map((m) => [m.role, m.text]), [["user", "整理日志"], ["assistant", "整理好了"]], "the answer comes from record.assistantText");
  assert.equal(await mirror.snapshot("missing"), null);

  sent.length = 0;
  mirror.stop();
  bus.emit("s1", ev("assistant.delta", { text: "x" }));
  assert.deepEqual(sent, [], "stopped mirrors send nothing");
}

// --- a snapshot read failure still answers (empty, never throws) --------------
{
  const port = {
    findSession: () => ({ id: "s1", title: "t" }),
    turnState: () => ({ phase: "streaming", runningTurnId: "t7", canInterrupt: true, queueLength: 1 }),
    readConversation: async () => { throw new Error("db locked"); },
    observeRuntime: () => () => {},
  };
  const mirror = createSessionMirror({ port, controllers: () => [], send: () => {} });
  const snap = await mirror.snapshot("s1");
  assert.deepEqual(snap.recent, []);
  assert.equal(snap.runningTurnId, "t7");
  assert.equal(snap.canInterrupt, true);
}

console.log("mobile-session-mirror: ok");
