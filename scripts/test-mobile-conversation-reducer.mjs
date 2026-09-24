#!/usr/bin/env node
// The phone's conversation model (web/lib/mobile/conversation.mjs), pure.
// A sent task leaves "pending" by identity; the live turn merges into its
// place; the desktop's history is the source of truth once it has the turn.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { initialConversation, reduce, messages, isBusy } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/conversation.mjs")).href);

const frame = (f) => ({ type: "frame", frame: f });
const run = (actions, state = initialConversation()) => actions.reduce(reduce, state);
const shape = (state) => messages(state).map((m) => [m.role, m.text, m.status || "", m.pending ? "pending" : m.live ? "live" : "history"]);

const context = (recent, extra = {}) => frame({ type: "session.context", sessionId: "s1", title: "修复构建", recent, ...extra });
const history = [
  { id: "u1", role: "user", text: "旧问题", turnId: "t0" },
  { id: "a1", role: "assistant", text: "旧回答", turnId: "t0", status: "completed" },
];

// --- send → admitted → turn starts (by commandId) → streams → settles --------
{
  let s = run([context(history), { type: "sent", commandId: "cmd_1", text: "整理日志" }]);
  assert.deepEqual(shape(s).at(-1), ["user", "整理日志", "sending", "pending"], "shows at once");
  assert.equal(isBusy(s), true);
  s = reduce(s, frame({ type: "command.admitted", commandId: "cmd_1" }));
  assert.deepEqual(shape(s).at(-1), ["user", "整理日志", "queued", "pending"]);

  // A desktop-typed turn starts first: this phone's task stays pending.
  s = reduce(s, frame({ type: "turn.started", turnId: "t_desk", userText: "桌面上的问题", commandId: "" }));
  assert.ok(shape(s).some((m) => m[3] === "pending"), "an unrelated turn does not consume the phone's pending task");
  s = reduce(s, frame({ type: "turn.ended", turnId: "t_desk", status: "completed", text: "桌面答案" }));

  // The phone's turn names its command.
  s = reduce(s, frame({ type: "turn.started", turnId: "t1", userText: "整理日志", commandId: "cmd_1" }));
  assert.ok(!shape(s).some((m) => m[3] === "pending"), "matched by identity, not by text");
  s = reduce(s, frame({ type: "assistant.delta", turnId: "t1", text: "整理" }));
  s = reduce(s, frame({ type: "assistant.delta", turnId: "t1", text: "中" }));
  s = reduce(s, frame({ type: "assistant.delta", turnId: "t_other", text: "串台" }));
  assert.deepEqual(shape(s).slice(-2), [["user", "整理日志", "", "history"], ["assistant", "整理中", "running", "live"]], "question then the streaming answer; foreign deltas ignored");
  s = reduce(s, frame({ type: "tool.started", turnId: "t1", tool: "bash" }));
  assert.equal(messages(s).at(-1).tool, "bash");
  s = reduce(s, frame({ type: "assistant.final", turnId: "t1", text: "整理好了（最终版）" }));
  assert.equal(messages(s).at(-1).text, "整理好了（最终版）", "the final text replaces what streamed");
  s = reduce(s, frame({ type: "turn.ended", turnId: "t1", status: "completed" }));
  assert.equal(isBusy(s), false);

  // The desktop's history arrives with the turn: the live copy gives way.
  s = reduce(s, context([...history,
    { id: "u2", role: "user", text: "整理日志", turnId: "t1" },
    { id: "a2", role: "assistant", text: "整理好了（最终版）", turnId: "t1", status: "completed" }]));
  assert.equal(s.live, null);
  assert.deepEqual(shape(s).slice(-2), [["user", "整理日志", "", "history"], ["assistant", "整理好了（最终版）", "completed", "history"]]);
  assert.equal(messages(s).filter((m) => m.text === "整理日志").length, 1, "never shown twice");
}

// --- the same text sent twice is two tasks, reconciled one by one ------------
{
  let s = run([context([]), { type: "sent", commandId: "a", text: "继续" }, { type: "sent", commandId: "b", text: "继续" }]);
  s = reduce(s, frame({ type: "turn.started", turnId: "t1", userText: "继续", commandId: "b" }));
  assert.deepEqual(s.pending.map((p) => p.commandId), ["a"], "identical text, but the right one resolved");
}

// --- a desktop that predates commandId: first in, first out ------------------
{
  let s = run([context([]), { type: "sent", commandId: "a", text: "一" }, { type: "sent", commandId: "b", text: "二" }]);
  s = reduce(s, frame({ type: "command.admitted", commandId: "a" }));
  s = reduce(s, frame({ type: "command.admitted", commandId: "b" }));
  s = reduce(s, frame({ type: "turn.started", turnId: "t1", userText: "一" })); // no commandId field at all
  assert.deepEqual(s.pending.map((p) => p.commandId), ["b"]);
}

// --- refusals and an absent desktop take the task back out, and say why -------
{
  let s = run([context([]), { type: "sent", commandId: "a", text: "x" }, frame({ type: "command.rejected", commandId: "a", code: "NO_TARGET_SESSION" })]);
  assert.deepEqual(s.pending, []);
  assert.match(s.notice.text, /没有可用的会话/);
  s = run([{ type: "sent", commandId: "b", text: "y" }, frame({ type: "relay.peer_offline", commandId: "b" })], s);
  assert.deepEqual(s.pending, []);
  assert.equal(s.desktopOnline, false);
  s = reduce(s, frame({ type: "relay.presence", desktopOnline: true }));
  assert.equal(s.desktopOnline, true);
  s = reduce(s, { type: "disconnected" });
  assert.equal(s.desktopOnline, null, "unknown while the phone itself is disconnected");
}

// --- reopening the page mid-turn picks the running turn up ---------------------
{
  const s = run([context([{ id: "u", role: "user", text: "长任务", turnId: "t9" }, { id: "a", role: "assistant", text: "进行到一半", turnId: "t9", status: "running" }], { runningTurnId: "t9" })]);
  assert.equal(s.live.turnId, "t9");
  assert.deepEqual(shape(s), [["user", "长任务", "", "history"], ["assistant", "进行到一半", "running", "live"]]);
  const next = reduce(s, frame({ type: "assistant.delta", turnId: "t9", text: "，继续" }));
  assert.equal(messages(next).at(-1).text, "进行到一半，继续", "the stream continues from where history left it");
}

// --- switching session clears what belonged to the old one --------------------
{
  let s = run([context(history), { type: "sent", commandId: "a", text: "x" }]);
  s = reduce(s, { type: "switching", sessionId: "s2" });
  assert.equal(s.session, null);
  assert.deepEqual([s.history, s.pending, s.live], [[], [], null]);
  assert.equal(s.selectedSessionId, "s2");
  s = reduce(s, frame({ type: "session.context", sessionId: "s2", title: "周报", recent: [] }));
  assert.equal(s.session.title, "周报");
  s = reduce(s, frame({ type: "projects.list", projects: [{ id: "p1", name: "lily" }], selectedProjectId: "p1" }));
  s = reduce(s, frame({ type: "sessions.list", projectId: "p1", sessions: [{ id: "s2", title: "周报" }], selectedSessionId: "s2" }));
  assert.equal(s.selectedProjectId, "p1");
  assert.equal(s.sessions.length, 1);
}

// --- junk is ignored ----------------------------------------------------------
{
  const s = initialConversation();
  assert.equal(reduce(s, frame(null)), s);
  assert.equal(reduce(s, frame({ type: "unknown" })), s);
  assert.equal(reduce(s, { type: "nope" }), s);
}

// --- a phone that slept through turn.ended is told by the snapshot ------------
// Field case: the desktop had answered, the phone (screen locked → socket
// dropped → reconnected) kept showing 处理中 forever. The reconnect snapshot
// says the desktop is idle; that ends it — for a desktop that sends
// runningTurnId, and for one that predates it (no turn ids, phase only).
{
  // Old desktop: turn.started carries no commandId; context carries no turn ids.
  let s = run([context([], { phase: "idle" }), { type: "sent", commandId: "cmd_9", text: "查一下C盘" }]);
  s = reduce(s, frame({ type: "command.admitted", commandId: "cmd_9" }));
  s = reduce(s, frame({ type: "turn.started", turnId: "t9" }));
  s = reduce(s, frame({ type: "assistant.delta", turnId: "t9", text: "查到了" }));
  assert.equal(isBusy(s), true);
  s = reduce(s, { type: "disconnected" }); // the screen locked; turn.ended never arrived
  const oldDesktop = [{ role: "user", text: "查一下C盘" }, { role: "assistant", text: "查到了，合计 23.90 GiB" }];
  s = reduce(s, context(oldDesktop, { phase: "running", queueLength: 0 }));
  assert.equal(isBusy(s), true, "a running desktop keeps the live turn");
  s = reduce(s, context(oldDesktop, { phase: "idle", queueLength: 0 }));
  assert.equal(isBusy(s), false, "an idle desktop ends it");
  assert.deepEqual(shape(s), [["user", "查一下C盘", "", "history"], ["assistant", "查到了，合计 23.90 GiB", "", "history"]], "the answer shows once, from history");

  // A task admitted but whose turn start was missed is not left 排队中 by an idle, empty-queued desktop…
  let q = run([context([], { phase: "idle" }), { type: "sent", commandId: "cmd_a", text: "a" }, { type: "sent", commandId: "cmd_b", text: "b" }]);
  q = reduce(q, frame({ type: "command.admitted", commandId: "cmd_a" }));
  q = reduce(q, context(oldDesktop, { phase: "idle", queueLength: 0 }));
  assert.deepEqual(q.pending.map((p) => p.commandId), ["cmd_b"], "admitted-and-run is gone; not-yet-admitted stays");
  // …but is kept while the desktop still has a queue.
  q = reduce(q, frame({ type: "command.admitted", commandId: "cmd_b" }));
  q = reduce(q, context(oldDesktop, { phase: "idle", queueLength: 1 }));
  assert.deepEqual(q.pending.map((p) => p.commandId), ["cmd_b"]);

  // New desktop mid-turn: runningTurnId wins over any phase.
  let n = run([context(history, { phase: "idle" }), frame({ type: "turn.started", turnId: "t5", commandId: "" })]);
  n = reduce(n, context(history, { phase: "idle", runningTurnId: "t5" }));
  assert.equal(isBusy(n), true, "runningTurnId says it runs");
  // Unknown phase (empty) changes nothing.
  n = reduce(n, context(history, {}));
  assert.equal(isBusy(n), true, "no phase, no runningTurnId: not enough to end it");
}

console.log("mobile-conversation-reducer: ok");
