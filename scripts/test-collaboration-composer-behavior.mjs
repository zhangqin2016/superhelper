import assert from "node:assert/strict";
import { initCollaborationComposer } from "../src/renderer/modules/collaboration-composer.js";
class Control extends EventTarget { value = ""; disabled = false; }
const textarea = new Control(), button = new Control();
const requests = [], pending = [];
const drafts = new Map([["b", "B saved draft"]]);
globalThis.window = { assistantClient: { collaboration: {
  send: (input) => { requests.push(input); return new Promise((resolve) => pending.push(resolve)); },
  getDraft: async (conversationId) => ({ ok: true, text: drafts.get(conversationId) || "" }),
  saveDraft: async ({ conversationId, text }) => { drafts.set(conversationId, text); return { ok: true }; },
} } };
const composer = initCollaborationComposer({ textarea, sendButton: button });
const settle = () => new Promise((r) => setImmediate(r));
const enter = (extra = {}) => { const e = new Event("keydown", { cancelable: true }); Object.assign(e, { key: "Enter", shiftKey: false, ...extra }); textarea.dispatchEvent(e); };
try {
  composer.setConversation("a"); await settle();
  textarea.value = "A original"; textarea.dispatchEvent(new Event("input"));
  enter({ isComposing: true });
  assert.equal(requests.length, 0, "IME confirmation is not an accidental send");
  enter(); enter();
  assert.equal(requests.length, 1, "repeated Enter cannot create duplicate sends while pending");
  composer.setConversation("b"); await settle();
  assert.equal(textarea.value, "B saved draft", "durable per-conversation draft is restored");
  textarea.value = "B changed"; textarea.dispatchEvent(new Event("input"));
  pending.shift()({ ok: true, state: "confirming" }); await settle();
  assert.equal(textarea.value, "B changed", "late ACK for A cannot clear B's draft");
  assert.equal(drafts.get("b"), "B changed");
  composer.setConversation("a"); await settle();
  textarea.value = "same retry"; textarea.dispatchEvent(new Event("input")); enter();
  pending.shift()({ ok: false, code: "COLLABORATION_UNAVAILABLE" }); await settle();
  enter();
  assert.equal(requests.at(-1).clientCommandId, requests.at(-2).clientCommandId, "IPC retry of the same unchanged draft keeps its original command identity");
  pending.shift()({ ok: true, state: "queued" }); await settle();
  textarea.value = "Alice private draft"; textarea.dispatchEvent(new Event("input"));
  assert.equal(typeof composer.reset, "function", "account changes must discard renderer-only draft/intent state");
  composer.reset();
  drafts.set("a", "Bob own draft");
  composer.setConversation("a"); await settle();
  assert.equal(textarea.value, "Bob own draft", "same conversation ID under another account never reuses Alice's cached draft");
  let releaseDraft;
  window.assistantClient.collaboration.getDraft = async () => new Promise((resolve) => { releaseDraft = resolve; });
  composer.setConversation("loading");
  composer.setConversation("a");
  releaseDraft({ ok: true, text: "durable pending draft" }); await settle();
  window.assistantClient.collaboration.getDraft = async () => ({ ok: true, text: "durable pending draft" });
  composer.setConversation("loading"); await settle();
  assert.equal(textarea.value, "durable pending draft", "switching away during draft load cannot cache an invented empty draft");
  composer.destroy();
  textarea.value = "must not send"; button.dispatchEvent(new Event("click"));
  assert.equal(requests.length, 3, "destroy removes the click handler as well as keyboard handlers");
  console.log("collaboration composer behavior passed");
} finally { composer.destroy(); delete globalThis.window; }
