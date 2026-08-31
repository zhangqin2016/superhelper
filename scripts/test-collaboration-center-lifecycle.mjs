import assert from "node:assert/strict";
import { initCollaborationCenter } from "../src/renderer/modules/collaboration-center.js";
class Node extends EventTarget {
  children = []; dataset = {}; hidden = false; value = ""; textContent = "";
  clientTop = 0;
  getBoundingClientRect() { return { top: 0, bottom: 0 }; }
  classList = { toggle() {} }; setAttribute() {} focus() {}
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children.flatMap((c) => c.fragment ? c.children : [c]); }
}
const nodes = new Map();
globalThis.document = { getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: () => new Node(), createDocumentFragment: () => Object.assign(new Node(), { fragment: true }) };
let publish;
const opens = [];
globalThis.window = { assistantClient: { collaboration: {
  onStateChange: (cb) => { publish = cb; return () => {}; }, list: async () => ({ ok: true, conversations: [{ id: "a" }] }),
  open: (id, beforeSeq) => new Promise((resolve) => opens.push({ id, beforeSeq, resolve })), getDraft: async () => ({ ok: true, text: "private draft" }), saveDraft: async () => ({ ok: true }),
} } };
const center = initCollaborationCenter({ getPolicy: async () => ({ collaboration: { enabled: true } }) });
const settle = () => new Promise((r) => setImmediate(r));
try {
  assert.equal(typeof center.open, "function", "notification navigation uses the same guarded conversation opening path");
  const first = center.open("a");
  const second = center.open("b");
  opens[1].resolve({ ok: true, conversation: { id: "b", title: "Latest B" }, messages: [] }); await second;
  opens[0].resolve({ ok: true, conversation: { id: "a", title: "Old A" }, messages: [] }); await first;
  assert.equal(nodes.get("collaborationLive").textContent, "Latest B", "slow opening A cannot replace later selected B");
  const navigation = center.open("c");
  publish({ type: "sync", state: { ok: true } }); await settle();
  assert.deepEqual(opens.map((request) => request.id), ["a", "b", "c"], "background sync cannot supersede pending user navigation with the old active conversation");
  opens[2].resolve({ ok: true, conversation: { id: "c", title: "Selected C" }, messages: [] }); await navigation;
  await settle();
  const textarea = nodes.get("collaborationComposer");
  assert.equal(textarea.value, "private draft");
  publish({ type: "availability", state: { ok: true } }); await settle();
  assert.equal(textarea.value, "", "account/service replacement clears renderer-only private draft state");
  assert.equal(nodes.get("collaborationTimeline").children.length, 0);
  let request = center.open("offline");
  opens.at(-1).resolve({ ok: true, conversation: { id: "offline" }, messages: [], offline: true, hasMore: false, nextBeforeSeq: 451 }); await request;
  assert.equal(nodes.get("collaborationStatus").textContent, "collaboration.offlineCache");
  center.hide(); center.show(); await settle();
  assert.equal(nodes.get("collaborationStatus").textContent, "collaboration.offlineCache", "local inbox reload cannot claim cached history is online");
  request = center.open("offline");
  opens.at(-1).resolve({ ok: true, conversation: { id: "offline" }, messages: [], offline: false, hasMore: true, nextBeforeSeq: 252 }); await request;
  assert.equal(nodes.get("collaborationLoadOlder").hidden, false, "online recovery restores pagination affordance");
  assert.equal(nodes.get("collaborationStatus").textContent, "collaboration.statusAvailable", "online refresh clears stale offline banner");
  const page = center.loadOlder();
  const latePage = opens.at(-1);
  assert.equal(latePage.beforeSeq, 252);
  request = center.open("new-selection");
  opens.at(-1).resolve({ ok: true, conversation: { id: "new-selection", title: "New selection" }, messages: [] }); await request;
  latePage.resolve({ ok: false }); await page;
  assert.equal(nodes.get("collaborationLive").textContent, "New selection", "late history failure does not overwrite another conversation");
  request = center.open("paging");
  opens.at(-1).resolve({ ok: true, conversation: { id: "paging" }, messages: [], hasMore: true, nextBeforeSeq: 401 }); await request;
  const supersededPage = center.loadOlder(), oldRequest = opens.at(-1);
  request = center.open("failing-navigation"); opens.at(-1).resolve({ ok: false }); await request;
  oldRequest.resolve({ ok: false }); await supersededPage;
  assert.equal(nodes.get("collaborationLoadOlder").disabled, false, "failed navigation releases the superseded page busy state");
  const count = opens.length;
  const retryPage = center.loadOlder();
  assert.equal(opens.length, count + 1, "earlier history remains retryable after navigation failure");
  opens.at(-1).resolve({ ok: true, messages: [], hasMore: false }); await retryPage;
  request = center.open("paging"); opens.at(-1).resolve({ ok: false, code: "COLLAB_ACCESS_REVOKED" }); await request;
  assert.equal(textarea.value, "", "revoked selection clears renderer draft plaintext");
  assert.equal(nodes.get("collaborationSendButton").disabled, true, "revoked selection cannot submit messages");
  assert.equal(nodes.get("collaborationTimeline").children.length, 0);
  assert.equal(nodes.get("collaborationScopeBadge").textContent, "");
  request = center.open("hidden-revoked"); opens.at(-1).resolve({ ok: true, conversation: { id: "hidden-revoked" }, messages: [] }); await request;
  await settle(); center.hide();
  publish({ type: "access-revoked", state: { ok: true } }); await settle(); await settle();
  assert.equal(textarea.value, "", "hidden views clear revoked plaintext without needing to be opened");
  request = center.open("revoked-a"); opens.at(-1).resolve({ ok: true, conversation: { id: "revoked-a" }, messages: [] }); await request;
  await settle();
  const pendingNavigation = center.open("missing-b");
  publish({ type: "access-revoked", state: { ok: true } }); await settle(); await settle();
  opens.at(-1).resolve({ ok: false, code: "COLLABORATION_NOT_FOUND" }); await pendingNavigation;
  assert.equal(textarea.value, "", "pending navigation must not retain revoked prior selection");
  assert.equal(nodes.get("collaborationSendButton").disabled, true);
  console.log("collaboration center lifecycle passed (controller harness, not visual E2E)");
} finally { center.destroy(); delete globalThis.document; delete globalThis.window; }
