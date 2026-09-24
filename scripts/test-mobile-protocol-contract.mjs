#!/usr/bin/env node
// Desktop and phone speak ONE protocol. The names are held equal, and frames
// the desktop's real mirror produces are fed to the phone's real reducer —
// so a field renamed on one side fails here, not on a user's phone.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = require(path.join(ROOT, "src/main/mobile/protocol.js"));
const { phoneFrameForEvent } = require(path.join(ROOT, "src/main/mobile/session-mirror.js"));
const { mobileConversationView } = require(path.join(ROOT, "src/main/mobile/conversation-view.js"));
const phone = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/protocol.mjs")).href);
const { initialConversation, reduce, messages } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/conversation.mjs")).href);

// --- the same names on both sides ------------------------------------------------
assert.deepEqual({ ...phone.FROM_PHONE }, { ...desktop.FROM_PHONE }, "phone → desktop frame names");
assert.deepEqual({ ...phone.TO_PHONE }, { ...desktop.TO_PHONE }, "desktop → phone frame names");
assert.deepEqual({ ...phone.CLOSE }, { ...desktop.CLOSE }, "relay close codes");
assert.equal(phone.PHONE_PROTOCOL, desktop.PHONE_PROTOCOL);

// The phone's command is what the desktop's controller accepts.
const command = phone.toDesktop.command({ text: "hi", mobileDeviceId: "mweb_x", lilySessionId: "s1" });
assert.equal(command.type, desktop.FROM_PHONE.COMMAND);
assert.equal(command.protocolVersion, desktop.PHONE_PROTOCOL);
assert.ok(command.commandId && command.idempotencyKey === command.commandId && command.correlationId.startsWith("corr_"));

// --- a real desktop turn, rendered by the real phone model ---------------------
const commandOf = (turnId) => (turnId === "t1" ? command.commandId : "");
const events = [
  { type: "turn.started", turnId: "t1", payload: { text: "hi" } },
  { type: "assistant.delta", turnId: "t1", payload: { text: "你" } },
  { type: "assistant.delta", turnId: "t1", payload: { text: "好" } },
  { type: "tool.started", turnId: "t1", payload: { name: "bash" } },
  { type: "assistant.final", turnId: "t1", payload: { assistant: "你好！" } },
  { type: "turn.completed", turnId: "t1", payload: { assistant: "你好！" } },
];
let state = reduce(initialConversation(), { type: "sent", commandId: command.commandId, text: "hi" });
for (const event of events) {
  const frame = phoneFrameForEvent(event, "s1", commandOf);
  if (frame) state = reduce(state, { type: "frame", frame: JSON.parse(JSON.stringify(frame)) });
}
assert.deepEqual(state.pending, [], "the desktop's turn resolves the phone's pending task by identity");
assert.deepEqual(messages(state).map((m) => [m.role, m.text, m.status]), [["user", "hi", ""], ["assistant", "你好！", "completed"]]);

// …then the desktop's snapshot replaces the live copy.
const view = mobileConversationView([
  { id: "u", role: "user", content: "hi", turnId: "t1" },
  { id: "a", role: "assistant", content: "", record: { assistantText: "你好！" }, turnId: "t1" },
]);
const snapshot = desktop.toPhone.sessionContext({ session: { id: "s1", title: "t" }, items: view.items });
state = reduce(state, { type: "frame", frame: JSON.parse(JSON.stringify(snapshot)) });
assert.equal(state.live, null);
assert.deepEqual(messages(state).map((m) => [m.role, m.text]), [["user", "hi"], ["assistant", "你好！"]]);

// A desktop-typed turn is recognisably "not this phone's".
const deskTurn = phoneFrameForEvent({ type: "turn.started", turnId: "t2", payload: { text: "桌面" } }, "s1", commandOf);
state = reduce(reduce(state, { type: "sent", commandId: "cmd_other", text: "等下再说" }), { type: "frame", frame: deskTurn });
assert.deepEqual(state.pending.map((p) => p.commandId), ["cmd_other"], "\"\" means not yours — the phone's task keeps waiting");

console.log("mobile-protocol-contract: ok");
