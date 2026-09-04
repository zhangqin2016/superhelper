import assert from "node:assert/strict";
import { createConversationPrefs } from "../src/renderer/modules/collaboration-conversation-prefs.js";

// A fake localStorage so the pure ordering/persistence logic can be tested
// without a DOM.
function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), _map: map };
}

const store = fakeStorage();
const prefs = createConversationPrefs("acct-1", store);
const convs = [
  { id: "a", updatedAt: 100 },
  { id: "b", updatedAt: 300 },
  { id: "c", updatedAt: 200 },
];

// Default: newest first, nothing pinned/muted/hidden.
assert.deepEqual(prefs.apply(convs).map((c) => c.id), ["b", "c", "a"], "default order is newest first");

// Pin the oldest -> it floats to the very top; the rest keep recency order.
prefs.togglePin("a");
assert.deepEqual(prefs.apply(convs).map((c) => c.id), ["a", "b", "c"], "a pinned conversation floats to the top");
assert.equal(prefs.apply(convs)[0].pinned, true, "the pinned row is annotated");

// Two pinned keep recency order among themselves.
prefs.togglePin("c");
assert.deepEqual(prefs.apply(convs).map((c) => c.id), ["c", "a", "b"], "pinned cluster ordered by recency, then the rest");

// Mute annotates without reordering.
prefs.toggleMute("b");
assert.equal(prefs.apply(convs).find((c) => c.id === "b").muted, true, "muted is annotated");
assert.deepEqual(prefs.apply(convs).map((c) => c.id), ["c", "a", "b"], "muting does not reorder");

// Delete hides until a newer message arrives; unpins too.
prefs.hide("c", 200);
assert.deepEqual(prefs.apply(convs).map((c) => c.id), ["a", "b"], "a deleted conversation is hidden");
assert.equal(prefs.isPinned("c"), false, "deleting a pinned conversation also unpins it");
// A newer message than the delete time brings it back (unpinned).
assert.deepEqual(prefs.apply([{ id: "c", updatedAt: 500 }, ...convs.filter((c) => c.id !== "c")]).map((c) => c.id).includes("c"), true,
  "a newer message resurfaces a deleted conversation");

// Persistence: a fresh instance on the same storage sees the same prefs.
const reopened = createConversationPrefs("acct-1", store);
assert.equal(reopened.isPinned("a"), true, "prefs persist across instances");
assert.equal(reopened.isMuted("b"), true);
// A different account does not inherit them.
const other = createConversationPrefs("acct-2", store);
assert.equal(other.isPinned("a"), false, "prefs are per-account");

// Corrupt storage degrades to empty rather than throwing.
const bad = { getItem: () => "{not json", setItem: () => {} };
assert.deepEqual(createConversationPrefs("x", bad).apply(convs).map((c) => c.id), ["b", "c", "a"], "corrupt storage falls back to defaults");

// The global unread badge must skip muted conversations (WeChat's rule): the
// list still shows their own dot, but they never raise the count.
{
  const fs = await import("node:fs");
  const badge = fs.readFileSync(new URL("../src/renderer/modules/collaboration-unread-badge.js", import.meta.url), "utf8");
  assert.match(badge, /Number\(row\?\.unreadCount\) > 0 && !isMuted\(row\.id\)/,
    "the unread badge total excludes muted conversations");
  const center = fs.readFileSync(new URL("../src/renderer/modules/collaboration-center.js", import.meta.url), "utf8");
  assert.match(center, /isMuted: \(id\) => inboxPrefs\(\)\.isMuted\(id\)/,
    "the centre feeds the badge the live mute state");
}

console.log("collaboration conversation prefs: pin floats, mute annotates, delete hides then resurfaces, per-account persistence");
