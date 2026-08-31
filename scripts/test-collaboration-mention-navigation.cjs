"use strict";
// Actual production renderer/DOM, with a controlled preload boundary. This does
// not substitute for signed-server or real two-account application acceptance.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
if (!app?.whenReady) { console.error("Run with Electron"); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-mention-navigation-"));
app.setPath("userData", path.join(dir, "data")); app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => { console.error("mention navigation timed out"); finish(1); }, 35_000);
function finish(code) { clearTimeout(deadline); if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(dir, { recursive: true, force: true }); app.exit(code); }

async function exercise(moduleUrl) {
  const { initCollaborationCenter } = await import(moduleUrl);
  const make = (id, tag = "div", parent = document.body) => { const node = document.createElement(tag); node.id = id; parent.append(node); return node; };
  make("collaborationNavButton", "button"); make("workbenchNavButton", "button");
  const shell = make("centerPanel"), panel = make("collaborationCenter", "div", shell);
  for (const id of ["collaborationInboxColumn", "collaborationInbox", "collaborationFriends", "collaborationTeams", "collaborationStatus", "collaborationLive", "collaborationScopeBadge", "collaborationTimeline", "collaborationConversationEmpty"]) make(id, "div", panel);
  const compose = make("composer", "div", panel); compose.className = "collaboration-composer";
  make("collaborationReplyPreview", "div", compose);
  const textarea = make("collaborationComposer", "textarea", compose), send = make("collaborationSendButton", "button", compose);
  const byId = (id) => document.getElementById(id), copy = (value) => structuredClone(value);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
  const waitFor = async (predicate, label) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } throw Error(`Condition not reached: ${label}`); };
  const check = (value, label) => { if (!value) throw Error(label); };
  const input = (text) => { textarea.value = text; textarea.setSelectionRange(text.length, text.length); textarea.dispatchEvent(new Event("input", { bubbles: true })); };
  const key = (name, extra = {}) => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extra }));
  const select = (id) => panel.querySelector(`[data-action="select-mention"][data-user-id="${id}"]`);
  const remove = (id) => panel.querySelector(`[data-action="remove-mention"][data-user-id="${id}"]`);
  const people = {
    A: ["a1", "a2"].map((userId) => ({ userId, lilyId: `lily-${userId}`, displayName: `Alpha ${userId}`, avatarObjectId: null })),
    B: ["b1", "b2"].map((userId) => ({ userId, lilyId: `lily-${userId}`, displayName: `Beta ${userId}`, avatarObjectId: null })),
  };
  const drafts = { A: { text: "A draft", replyToMessageId: "source-A", mentionUserIds: ["a1"] }, B: { text: "B draft", replyToMessageId: "source-B", mentionUserIds: ["b1"] } };
  const rows = (id) => [{ id: `source-${id}`, conversationId: id, seq: 1, revision: 1, bodyText: `Source ${id}`, senderUserId: "self" }];
  const complete = (id, items = people[id]) => ({ ok: true, conversationId: id, mentionCandidates: { status: "complete", items: copy(items) } });
  const saves = [], sends = [], opens = [], pending = [], errors = [];
  let held = null, mode = "complete", publish, allowed = ["A", "B"], releaseSend;
  window.addEventListener("unhandledrejection", (event) => { errors.push(String(event.reason)); event.preventDefault(); });
  window.assistantClient = { collaboration: {
    list: async () => ({ ok: true, conversations: allowed.map((id) => ({ id, scopeId: "personal", kind: "group" })) }),
    getDirectory: async () => ({ ok: true, profile: { userId: "self", displayName: "Self", lilyId: "self", avatarObjectId: null }, contacts: [], teams: [] }),
    getSocialCommands: async () => ({ ok: true, commands: [] }), onStateChange: (callback) => { publish = callback; return () => {}; },
    open: async (id) => { opens.push(id); return { ok: true, conversation: { id, scopeId: "personal", kind: "group" }, messages: rows(id), hasMore: false, nextBeforeSeq: null }; },
    readMessages: async ({ conversationId, messageIds }) => ({ ok: true, messages: rows(conversationId).filter((row) => messageIds.includes(row.id)), unavailableMessageIds: [] }),
    getDraft: async (id) => ({ ok: true, ...copy(drafts[id]) }),
    saveDraft: async ({ conversationId, ...value }) => { saves.push({ conversationId, ...copy(value) }); drafts[conversationId] = copy(value); return { ok: true }; },
    getMentionCandidates: async (id) => {
      if (held === id) return new Promise((resolve) => pending.push({ id, resolve }));
      if (mode === "unknown") return { ok: true, conversationId: id, mentionCandidates: { status: "unknown", items: [] } };
      if (mode === "error") return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
      return complete(id);
    },
    send: async (value) => {
      sends.push(copy(value));
      return new Promise((resolve) => { releaseSend = (result) => {
        const submitted = { text: value.bodyText, replyToMessageId: value.replyToMessageId, mentionUserIds: value.mentionUserIds };
        if (result.ok && JSON.stringify(drafts[value.conversationId]) === JSON.stringify(submitted)) drafts[value.conversationId] = { text: "", replyToMessageId: null, mentionUserIds: [] };
        resolve(result);
      }; });
    },
  } };
  const center = initCollaborationCenter({ getPolicy: async () => ({ collaboration: { enabled: true } }) });
  center.show(); await center.open("A"); await waitFor(() => textarea.value === "A draft", "A complete draft restored");
  byId("collaborationMentionButton").click(); await waitFor(() => select("a2"), "authorized A candidate shown by actual composer");
  const oldOption = select("a2"), oldRemove = remove("a1");
  check(oldRemove, "restored A explicit ID has a removable reminder tag"); key("Escape"); await tick();
  held = "A"; byId("collaborationMentionButton").click(); await waitFor(() => pending.length, "A candidate request held");
  const beforeTyping = pending.length; input("A typing @Al"); input("A typing @Alpha"); await tick();
  check(pending.length === beforeTyping, "rapid typing filters without starving/restarting the candidate request");
  held = null; await center.open("B"); await waitFor(() => textarea.value === "B draft" && remove("b1"), "B draft and reminders restored");
  const beforeStaleActions = saves.length;
  for (const request of pending.splice(0)) request.resolve(complete("A", [{ ...people.A[1], displayName: "LATE A PRIVATE NAME" }]));
  oldOption.click(); oldRemove.click(); await tick();
  check(saves.length === beforeStaleActions && !panel.textContent.includes("LATE A PRIVATE NAME") && drafts.B.mentionUserIds.join() === "b1", "late A result/detached buttons cannot modify B or reveal A candidate names");

  input("same body"); key("Escape"); send.click(); await waitFor(() => sends.length === 1, "first complete B intent sent");
  byId("collaborationMentionButton").click(); await waitFor(() => select("b2"), "B second candidate loaded");
  select("b2").click(); await waitFor(() => drafts.B.mentionUserIds.join() === "b1,b2", "new same-body reminder intent saved while send pending");
  releaseSend({ ok: true, state: "queued" }); await tick();
  check(textarea.value === "same body" && remove("b2") && drafts.B.replyToMessageId === "source-B", "old ACK preserves new reminder IDs and reply with identical text");
  send.click(); await waitFor(() => sends.length === 2, "new reminder intent sent");
  check(sends[1].clientCommandId !== sends[0].clientCommandId, "changed reminder set owns a new command UUID");
  releaseSend({ ok: false, code: "COLLABORATION_UNAVAILABLE" }); await tick(); send.click(); await waitFor(() => sends.length === 3, "failed unchanged intent retried");
  check(sends[2].clientCommandId === sends[1].clientCommandId, "unchanged retry retains UUID");
  await center.open("A"); await waitFor(() => textarea.value === "A typing @Alpha", "A local input survives B sends");
  const beforeLateSend = opens.length; releaseSend({ ok: true, state: "queued" }); await tick();
  check(opens.length === beforeLateSend && drafts.A.mentionUserIds.join() === "a1", "late B send does not navigate or clear A reminder intent");
  key("Escape");
  for (const candidateMode of ["unknown", "error"]) {
    mode = candidateMode; byId("collaborationMentionButton").click(); await tick();
    const beforeEnter = sends.length; key("Enter"); await tick();
    check(sends.length === beforeEnter && drafts.A.mentionUserIds.join() === "a1", `${candidateMode} candidate result preserves IDs and Enter does not send`);
    key("Escape");
  }
  mode = "complete"; input("A still composing");
  byId("collaborationMentionButton").click(); await waitFor(() => select("a2"), "A picker reopened"); key("Escape"); await tick();
  held = "A"; byId("collaborationMentionButton").click(); await waitFor(() => pending.length, "candidate pending before hide");
  const hiddenRemove = remove("a1"), hiddenDraft = copy(drafts.A), beforeHide = saves.length;
  center.hide();
  for (const request of pending.splice(0)) request.resolve(complete("A", [{ ...people.A[1], displayName: "LATE HIDDEN PRIVATE NAME" }]));
  hiddenRemove?.click(); await tick();
  check(!panel.textContent.includes("LATE HIDDEN PRIVATE NAME") && saves.length === beforeHide && JSON.stringify(drafts.A) === JSON.stringify(hiddenDraft), "hide invalidates pending candidates and old remove actions without deleting draft IDs");
  held = null; center.show(); await center.open("B"); await tick();
  drafts.A = { text: "", replyToMessageId: null, mentionUserIds: [] }; allowed = ["B"];
  publish({ type: "access-revoked", state: { ok: true } }); await tick(); await tick();
  allowed = ["A", "B"]; await center.open("A"); await tick();
  check(!textarea.value && !byId("collaborationMentionTags").querySelector('[data-action="remove-mention"]'), "regrant cannot revive reminder IDs of a revoked inactive conversation");
  held = "A"; byId("collaborationMentionButton").click(); await waitFor(() => pending.length, "candidate pending before account reset");
  publish({ type: "availability", state: { ok: false } }); await tick();
  for (const request of pending.splice(0)) request.resolve(complete("A", [{ ...people.A[0], displayName: "OLD ACCOUNT PRIVATE NAME" }]));
  await tick(); check(!textarea.value && !panel.textContent.includes("OLD ACCOUNT PRIVATE NAME") && !byId("collaborationMentionTags").querySelector('[data-action="remove-mention"]'), "account reset fences candidates and clears reminder tags");
  center.destroy(); oldOption.click(); oldRemove.click(); await tick();
  return { sends, errors };
}

app.whenReady().then(async () => {
  const page = path.join(dir, "test.html"); fs.writeFileSync(page, "<!doctype html><html><body></body></html>");
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } }); await win.loadFile(page);
  const url = pathToFileURL(path.join(__dirname, "../src/renderer/modules/collaboration-center.js")).href;
  const result = await win.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(url)})`);
  assert.equal(result.sends.length, 3);
  for (const send of result.sends) assert.deepEqual(Object.keys(send).sort(), ["conversationId", "clientCommandId", "bodyText", "replyToMessageId", "mentionUserIds"].sort(), "only the closed complete intent crosses preload");
  assert.deepEqual(result.sends[0].mentionUserIds, ["b1"]);
  assert.deepEqual(result.sends[1].mentionUserIds, ["b1", "b2"]);
  assert.deepEqual(result.errors, []);
  console.log("collaboration mention navigation: real Electron late candidates, full intents, retries, visibility and authorization fences passed");
}).then(() => finish(0)).catch((error) => { console.error(error); finish(1); });
