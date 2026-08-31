"use strict";
// Actual renderer modules and DOM; the transport is deliberately a fixture.
// This is not a real multi-user/server or native secure-storage acceptance test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-reply-navigation-"));
app.setPath("userData", path.join(dir, "data")); app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => { console.error("reply navigation timed out"); finish(1); }, 35_000);
function finish(code) {
  clearTimeout(deadline);
  if (win && !win.isDestroyed()) win.destroy();
  fs.rmSync(dir, { recursive: true, force: true }); app.exit(code);
}

async function exercise(moduleUrl) {
  const { initCollaborationCenter } = await import(moduleUrl);
  const make = (id, tag = "div", parent = document.body) => {
    const node = document.createElement(tag); node.id = id; parent.append(node); return node;
  };
  make("collaborationNavButton", "button"); make("workbenchNavButton", "button");
  const shell = make("centerPanel"), panel = make("collaborationCenter", "div", shell);
  for (const id of ["collaborationInboxColumn", "collaborationInbox", "collaborationFriends", "collaborationTeams", "collaborationStatus", "collaborationLive", "collaborationScopeBadge", "collaborationTimeline", "collaborationConversationEmpty"]) make(id, "div", panel);
  make("collaborationReplyPreview", "div", panel);
  const textarea = make("collaborationComposer", "textarea", panel), send = make("collaborationSendButton", "button", panel);
  const byId = (id) => document.getElementById(id);
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
    throw Error(`Condition not reached: ${label}`);
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  const copy = (value) => structuredClone(value);
  const rows = { A: [{ id: "source-A", conversationId: "A", seq: 1, revision: 1, bodyText: "source A", senderUserId: "peer" }],
    B: [1, 2].map((seq) => ({ id: `source-B${seq}`, conversationId: "B", seq, revision: 1, bodyText: `source B${seq}`, senderUserId: "peer" })) };
  const drafts = { A: { text: "A draft", replyToMessageId: null, mentionUserIds: ["peer-A"] }, B: { text: "B draft", replyToMessageId: null, mentionUserIds: ["peer-B"] } };
  const saves = [], sends = [], opens = [], errors = [];
  let openGate = null, previewGate = null, releaseOpen, releasePreview, releaseSend, publish, releaseOlder, releaseDirectory, holdDirectory = false, holdOlder = false, latestOnly = false, enabled = true, visibleIds = ["A", "B"];
  window.addEventListener("unhandledrejection", (event) => { errors.push(String(event.reason)); event.preventDefault(); });
  const api = {
    list: async () => ({ ok: true, conversations: visibleIds.map((id) => ({ id, scopeId: "personal", kind: "group" })) }),
    getDirectory: async () => {
      if (holdDirectory) return new Promise((resolve) => { releaseDirectory = resolve; });
      return { ok: true, profile: { userId: "self" }, contacts: [], teams: [] };
    },
    getSocialCommands: async () => ({ ok: true, commands: [] }), onStateChange: (callback) => { publish = callback; return () => {}; },
    getDraft: async (id) => ({ ok: true, ...copy(drafts[id]) }),
    saveDraft: async (input) => { saves.push(copy(input)); const { conversationId, ...intent } = input; drafts[conversationId] = intent; return { ok: true }; },
    readMessages: async ({ conversationId, messageIds }) => {
      if (holdOlder && conversationId === "B" && messageIds.includes("source-B1")) return new Promise((resolve) => { releaseOlder = resolve; });
      if (previewGate === conversationId) return new Promise((resolve) => { releasePreview = resolve; });
      return { ok: true, messages: copy(rows[conversationId].filter((row) => messageIds.includes(row.id))), unavailableMessageIds: [] };
    },
    open: async (id) => {
      opens.push(id);
      if (openGate === id) await new Promise((resolve) => { releaseOpen = resolve; });
      const partial = latestOnly && id === "B";
      return { ok: true, conversation: { id, scopeId: "personal", kind: "group", title: id }, messages: copy(partial ? rows.B.slice(1) : rows[id]), hasMore: partial, nextBeforeSeq: partial ? 2 : null, offline: false };
    },
    send: async (input) => { sends.push(copy(input)); return new Promise((resolve) => { releaseSend = resolve; }); },
  };
  window.assistantClient = { collaboration: api };
  const center = initCollaborationCenter({ getPolicy: async () => ({ collaboration: { enabled } }) });
  center.show(); await center.open("A"); await waitFor(() => textarea.value === "A draft", "A draft restored");
  const buttonFor = (id) => byId("collaborationTimeline").querySelector(`[data-message-key="${id}"] [data-action="reply-message"]`);
  const oldA = buttonFor("source-A");
  if (!oldA) return { missingReplyAction: true };
  oldA.click(); await waitFor(() => drafts.A.replyToMessageId === "source-A", "A reply saved");
  await waitFor(() => byId("collaborationReplyPreview").textContent.includes("source A"), "authorized A preview");
  byId("collaborationReplyPreview").querySelector('[data-action="clear-reply"]').click(); await tick();
  const clearedA = copy(drafts.A);
  openGate = "A"; releaseOpen = null;
  const backgroundOpen = center.open("A", { userNavigation: false }); await waitFor(() => releaseOpen, "background A refresh held");
  textarea.value = "background typing"; textarea.dispatchEvent(new Event("input", { bubbles: true })); await tick();
  const backgroundEditable = drafts.A.text === "background typing" && !send.disabled;
  openGate = null; releaseOpen(); await backgroundOpen;
  textarea.value = "A draft"; textarea.dispatchEvent(new Event("input", { bubbles: true })); await tick();
  const beforePending = saves.length;
  releaseOpen = null;
  openGate = "B"; const pendingOpen = center.open("B"); await waitFor(() => releaseOpen, "B opening");
  oldA.click(); await tick(); const openingFenced = saves.length === beforePending;
  openGate = null; releaseOpen(); await pendingOpen; await waitFor(() => textarea.value === "B draft", "B draft restored");
  const beforeDetached = saves.length; oldA.click(); await tick(); const detachedFenced = saves.length === beforeDetached;

  previewGate = "B"; buttonFor("source-B1").click(); await waitFor(() => releasePreview, "held B preview");
  const oldClear = byId("collaborationReplyPreview").querySelector('[data-action="clear-reply"]');
  center.hide(); const hiddenText = byId("collaborationReplyPreview").textContent, hiddenSaves = saves.length;
  releasePreview({ ok: true, messages: [{ ...rows.B[0], bodyText: "LATE HIDDEN PRIVATE PREVIEW" }], unavailableMessageIds: [] });
  oldClear?.click(); await tick();
  const hiddenFenced = byId("collaborationReplyPreview").textContent === hiddenText && saves.length === hiddenSaves;
  previewGate = null; releasePreview = null; center.show(); await center.open("B"); await tick();
  textarea.value = "same text"; textarea.dispatchEvent(new Event("input", { bubbles: true }));
  buttonFor("source-B1").click(); await tick(); send.click(); await waitFor(() => sends.length === 1, "first send dispatched");
  buttonFor("source-B2").click(); await waitFor(() => drafts.B.replyToMessageId === "source-B2", "newer reply draft saved");
  releaseSend({ ok: true, clientCommandId: sends[0].clientCommandId, state: "queued" }); await tick();
  const newerDraft = { text: textarea.value, saved: copy(drafts.B) };

  send.click(); await waitFor(() => sends.length === 2, "second send dispatched");
  await center.open("A"); await waitFor(() => textarea.value === "A draft", "manual A restored");
  const beforeLateSend = opens.length;
  releaseSend({ ok: true, clientCommandId: sends[1].clientCommandId, state: "queued" }); await tick();
  const sendNavigationFenced = opens.length === beforeLateSend && textarea.value === "A draft";

  await center.open("B"); await tick(); previewGate = "B"; releasePreview = null;
  const oldB2 = buttonFor("source-B2"); oldB2.click(); await waitFor(() => releasePreview, "held source before revoke");
  const stalePreview = releasePreview;
  rows.B[1] = { ...rows.B[1], bodyText: "", revision: 2, revokedAt: "2026-08-31T00:00:00Z" };
  previewGate = null; holdOlder = true; latestOnly = true;
  const slowHistory = center.open("B", { userNavigation: false }); await waitFor(() => releaseOlder, "older cache blocked after latest source revoke");
  const revokedText = byId("collaborationReplyPreview").textContent;
  const immediateRevoke = revokedText.includes("collaboration.reply.revoked") && !byId("collaborationTimeline").querySelector('[data-message-key="source-B2"] .collaboration-message-body').textContent.includes("source B2");
  stalePreview({ ok: true, messages: [{ ...rows.B[1], bodyText: "STALE REVOKED CONTENT", revision: 1, revokedAt: null }], unavailableMessageIds: [] });
  await tick(); const slowHistoryFenced = byId("collaborationReplyPreview").textContent === revokedText;
  holdOlder = false; latestOnly = false; releaseOlder({ ok: true, messages: copy([rows.B[0]]), unavailableMessageIds: [] }); await slowHistory;
  const beforeRevokedClick = saves.length; oldB2.click(); await tick();
  const revokeFenced = byId("collaborationReplyPreview").textContent === revokedText && !revokedText.includes("source B2") && saves.length === beforeRevokedClick;
  // Main has removed A's encrypted draft while the user remains in B. An
  // eventual new membership must not resurrect the old renderer-only draft.
  textarea.value = "B survives unrelated revocation"; textarea.dispatchEvent(new Event("input", { bubbles: true })); await tick();
  drafts.A = { text: "", replyToMessageId: null, mentionUserIds: [] }; visibleIds = ["B"];
  publish({ type: "access-revoked", state: { ok: true } }); await tick(); await tick();
  visibleIds = ["A", "B"]; await center.open("A"); await tick();
  const inactiveRegrantCleared = textarea.value === "";
  await center.open("B"); await tick();
  const unrelatedDraftPreserved = textarea.value === "B survives unrelated revocation";
  // A list snapshot predates a newly authorized open. Waiting on the directory
  // must not give that old list permission to erase the new selection's draft.
  visibleIds = ["B"]; holdDirectory = true;
  publish({ type: "access-revoked", state: { ok: true } }); await waitFor(() => releaseDirectory, "old access list awaiting directory");
  visibleIds = ["A", "B"]; await center.open("A");
  textarea.value = "newly authorized A draft"; textarea.dispatchEvent(new Event("input", { bubbles: true })); await tick();
  holdDirectory = false; releaseDirectory({ ok: true, profile: { userId: "self" }, contacts: [], teams: [] }); await tick(); await tick();
  const lateAccessListFenced = textarea.value === "newly authorized A draft";
  await center.open("B"); await tick();
  const allowed = buttonFor("source-B1"); enabled = false; await center.refresh(); const beforeDisabled = saves.length;
  allowed?.click(); await tick(); const policyFenced = saves.length === beforeDisabled;
  publish({ type: "availability", state: { ok: false } }); await tick();
  const resetCleared = textarea.value === "" && byId("collaborationReplyPreview").textContent === "";
  center.destroy(); oldA.click(); allowed?.click(); await tick();
  // Model only the documented main admission side effect: it clears a durable
  // draft iff the complete submitted intent matches. A skipped autosave must
  // not leave an older durable draft behind after the new text is sent.
  const { initCollaborationComposer } = await import(new URL("./collaboration-composer.js", moduleUrl));
  drafts.A = { text: "durable old", replyToMessageId: null, mentionUserIds: ["peer-A"] };
  api.send = async (input) => {
    const submitted = { text: input.bodyText, replyToMessageId: input.replyToMessageId, mentionUserIds: input.mentionUserIds };
    if (JSON.stringify(drafts[input.conversationId]) === JSON.stringify(submitted)) drafts[input.conversationId] = { text: "", replyToMessageId: null, mentionUserIds: [] };
    return { ok: true, state: "queued" };
  };
  const fresh = initCollaborationComposer({ textarea, sendButton: send }); fresh.setConversation("A");
  await waitFor(() => textarea.value === "durable old", "durable draft before same-task send");
  textarea.value = "immediate new"; textarea.dispatchEvent(new Event("input", { bubbles: true })); send.click(); await tick();
  const immediateDraft = copy(drafts.A); fresh.destroy();
  return { clearedA, backgroundEditable, openingFenced, detachedFenced, hiddenFenced, newerDraft, sends, sendNavigationFenced, revokedText, immediateRevoke, slowHistoryFenced, revokeFenced, inactiveRegrantCleared, unrelatedDraftPreserved, lateAccessListFenced, policyFenced, resetCleared, immediateDraft, errors };
}

app.whenReady().then(async () => {
  const page = path.join(dir, "index.html"); fs.writeFileSync(page, "<!doctype html><html><body></body></html>");
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } }); await win.loadFile(page);
  const url = pathToFileURL(path.join(__dirname, "../src/renderer/modules/collaboration-center.js")).href;
  const result = await win.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(url)})`);
  assert.notEqual(result.missingReplyAction, true, "actual center timeline exposes a reply action for an authorized persisted message");
  assert.deepEqual(result.clearedA, { text: "A draft", replyToMessageId: null, mentionUserIds: ["peer-A"] }, "clear reply preserves body and explicit mentions");
  for (const key of ["lateAccessListFenced", "immediateRevoke", "slowHistoryFenced", "inactiveRegrantCleared", "unrelatedDraftPreserved", "backgroundEditable", "openingFenced", "detachedFenced", "hiddenFenced", "sendNavigationFenced", "revokeFenced", "policyFenced", "resetCleared"]) assert.equal(result[key], true, key);
  assert.deepEqual(result.immediateDraft, { text: "", replyToMessageId: null, mentionUserIds: [] }, "same-task input/send cannot strand an older durable draft");
  assert.equal(result.newerDraft.text, "same text", "old send cannot clear a changed reply with the same body");
  assert.deepEqual(result.newerDraft.saved, { text: "same text", replyToMessageId: "source-B2", mentionUserIds: ["peer-B"] });
  assert.equal(result.sends[0].replyToMessageId, "source-B1"); assert.equal(result.sends[1].replyToMessageId, "source-B2");
  assert.deepEqual(result.sends[0].mentionUserIds, ["peer-B"]);
  assert.notEqual(result.sends[0].clientCommandId, result.sends[1].clientCommandId, "changed reply intent owns a new immutable command ID");
  assert.deepEqual(result.errors, [], "late callbacks are handled without unhandled rejections");
  console.log("collaboration reply navigation: actual Electron center draft, navigation, visibility and revoke fences passed");
}).then(() => finish(0)).catch((error) => { console.error(error); finish(1); });
