import assert from "node:assert/strict";
import { initCollaborationCenter } from "../src/renderer/modules/collaboration-center.js";
class Node extends EventTarget {
  children = []; dataset = {}; hidden = false; value = ""; textContent = "";
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
  open: (id) => new Promise((resolve) => opens.push({ id, resolve })), getDraft: async () => ({ ok: true, text: "private draft" }), saveDraft: async () => ({ ok: true }),
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
  console.log("collaboration center lifecycle passed (controller harness, not visual E2E)");
} finally { center.destroy(); delete globalThis.document; delete globalThis.window; }
