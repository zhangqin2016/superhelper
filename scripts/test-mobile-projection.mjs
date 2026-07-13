#!/usr/bin/env node
// Mobile turn-projection: the pure event→frame mapper + the event bus observer
// hook that feeds it. Together they let the phone SEE the desktop turn it
// triggered (streaming reply + lifecycle), not just an admit ack.

import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { mobileProjectionFrame, buildSessionContextFrame, MAX_RECENT } = require("../src/main/mobile-projection.js");
const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");

// --- pure mapper ---
{
  const ev = (type, payload = {}, turnId = "t1") => ({ type, turnId, payload });

  assert.deepEqual(mobileProjectionFrame(ev("turn.started")), { type: "turn.started", turnId: "t1" });
  assert.deepEqual(mobileProjectionFrame(ev("assistant.delta", { text: "hi" })), { type: "assistant.delta", turnId: "t1", text: "hi" });
  assert.equal(mobileProjectionFrame(ev("assistant.delta", { text: "" })), null, "empty delta is dropped");
  assert.deepEqual(mobileProjectionFrame(ev("tool.started", { name: "bash" })), { type: "tool.started", turnId: "t1", tool: "bash" });
  assert.deepEqual(mobileProjectionFrame(ev("turn.completed")), { type: "turn.ended", turnId: "t1", status: "completed" });
  assert.deepEqual(mobileProjectionFrame(ev("turn.failed")), { type: "turn.ended", turnId: "t1", status: "failed" });
  assert.deepEqual(mobileProjectionFrame(ev("turn.interrupted")), { type: "turn.ended", turnId: "t1", status: "interrupted" });

  // assistant.final text extraction (string / content array)
  assert.deepEqual(mobileProjectionFrame(ev("assistant.final", { assistant: { text: "done" } })), { type: "assistant.final", turnId: "t1", text: "done" });
  assert.deepEqual(
    mobileProjectionFrame(ev("assistant.final", { assistant: { content: [{ text: "a" }, { text: "b" }] } })),
    { type: "assistant.final", turnId: "t1", text: "ab" },
  );

  // events the phone doesn't need are dropped (relay stays quiet)
  assert.equal(mobileProjectionFrame(ev("tool.input.delta", { text: "secret" })), null, "tool input is never projected");
  assert.equal(mobileProjectionFrame(ev("stream.metadata")), null);
  assert.equal(mobileProjectionFrame(null), null);
}

// --- session context builder ---
{
  const f = buildSessionContextFrame({
    title: "重构登录", sessionId: "s1", phase: "streaming", queueLength: 2,
    recent: [{ role: "user", content: "帮我改登录" }, { role: "assistant", content: "好的" }, { role: "bad", text: "" }],
  });
  assert.equal(f.type, "session.context");
  assert.equal(f.title, "重构登录");
  assert.equal(f.phase, "streaming");
  assert.equal(f.queueLength, 2);
  assert.deepEqual(f.recent, [{ role: "user", text: "帮我改登录" }, { role: "assistant", text: "好的" }], "maps content→text, drops empty, normalizes role");

  // caps count + truncates long text
  const many = Array.from({ length: 20 }, (_, i) => ({ role: "user", text: "x".repeat(2000) + i }));
  const capped = buildSessionContextFrame({ title: "t", sessionId: "s", recent: many });
  assert.equal(capped.recent.length, MAX_RECENT, "recent is capped");
  assert.ok(capped.recent[0].text.length <= 800, "message text is truncated");

  // tolerant of junk
  assert.deepEqual(buildSessionContextFrame().recent, []);
}

// --- event bus observer hook ---
{
  const bus = new RuntimeEventBus(() => null); // no window; observers fire in emitBatch
  const seen = [];
  const unsub = bus.addObserver((sessionId, events) => { seen.push({ sessionId, types: events.map((e) => e.type) }); });

  bus.emit("s1", { type: "turn.started", turnId: "t1", payload: {} });
  bus.emit("s1", { type: "assistant.delta", turnId: "t1", payload: { text: "x" } });
  assert.equal(seen.length, 2, "observer called per emitted batch");
  assert.equal(seen[0].sessionId, "s1");
  assert.deepEqual(seen[1].types, ["assistant.delta"]);

  // unsubscribe stops delivery
  unsub();
  bus.emit("s1", { type: "turn.completed", turnId: "t1", payload: {} });
  assert.equal(seen.length, 2, "no delivery after unsubscribe");

  // a throwing observer is isolated (never breaks emit)
  bus.addObserver(() => { throw new Error("boom"); });
  const ok = bus.emit("s1", { type: "turn.started", turnId: "t2", payload: {} });
  assert.ok(Array.isArray(ok) && ok.length === 1, "emit still returns events despite observer throwing");
}

console.log("mobile-projection: ok");
