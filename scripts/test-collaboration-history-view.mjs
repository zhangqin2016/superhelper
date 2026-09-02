import assert from "node:assert/strict";
import { applyCollaborationHistoryPage } from "../src/renderer/modules/collaboration-history-view.js";
const rows = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: `m${from + i}`, seq: from + i, bodyText: `message ${from + i}` }));
const page = (from, to, hasMore = true, offline = false) => ({ messages: rows(from, to), nextBeforeSeq: from, hasMore, offline });
let state = applyCollaborationHistoryPage({}, page(1, 200), { latest: true });
state = applyCollaborationHistoryPage(state, page(401, 600), { latest: true });
assert.equal(state.nextBeforeSeq, 401, "newest window with no overlap establishes the newest missing interval");
state = applyCollaborationHistoryPage(state, page(201, 400));
assert.equal(state.messages.length, 600, "loading the gap connects all displayed history");
state = applyCollaborationHistoryPage(state, page(401, 600), { latest: true });
assert.equal(state.nextBeforeSeq, 201, "overlapping refresh does not undo backwards progress");
state = applyCollaborationHistoryPage(state, page(1, 200, false));
assert.equal(state.hasMore, false); assert.equal(state.messages.length, 600);

let offline = applyCollaborationHistoryPage({}, page(451, 451, false, true), { latest: true });
offline = applyCollaborationHistoryPage(offline, page(252, 451), { latest: true });
assert.equal(offline.hasMore, true, "cache exhaustion is not remote history exhaustion");
assert.equal(offline.nextBeforeSeq, 252); assert.equal(offline.offline, false);
const pending = { id: "local", clientCommandId: "command", seq: null, bodyText: "pending" };
let cancelled = applyCollaborationHistoryPage({}, { ...page(1, 1, false), messages: [...rows(1, 1), pending] }, { latest: true });
cancelled = applyCollaborationHistoryPage(cancelled, page(1, 1, false), { latest: true });
assert.deepEqual(cancelled.messages.map((row) => row.id), ["m1"], "latest pending set replaces rather than unions cancelled bubbles");
const revoked = { id: "m1", seq: 1, revision: 3, bodyText: "", revokedAt: "2026-08-31" };
const merged = applyCollaborationHistoryPage({ messages: [revoked] }, { messages: [{ ...revoked, revision: 2, bodyText: "old", revokedAt: null }], hasMore: false });
assert.equal(merged.messages[0].bodyText, "", "late old page cannot resurrect newer tombstone");
const optimistic = { id: "optimistic:send-1", clientCommandId: "send-1", seq: null, revision: 1, state: "confirming", bodyText: "hello" };
const authoritative = { id: "server-1", clientCommandId: "send-1", seq: 7, revision: 1, state: "persisted", bodyText: "hello" };
for (const messages of [[optimistic, authoritative], [authoritative, optimistic]]) {
  const result = applyCollaborationHistoryPage({}, { messages, hasMore: false }, { latest: true });
  assert.equal(result.messages.length, 1, "one command renders one bubble even when history and optimistic state race");
  assert.equal(result.messages[0].id, "server-1", "the sequenced server message wins over an equal-revision optimistic alias");
}
const preexistingRace = applyCollaborationHistoryPage({ messages: [authoritative, { ...optimistic, revision: 9 }] }, { messages: [], hasMore: true });
assert.equal(preexistingRace.messages.length, 1, "a preexisting duplicate pair is healed on the next merge");
assert.equal(preexistingRace.messages[0].id, "server-1", "authority outranks a misleading optimistic revision");
const repeatedText = applyCollaborationHistoryPage({}, { messages: [
  { ...authoritative, id: "server-2", clientCommandId: "send-2", seq: 8 },
  { ...authoritative, id: "server-3", clientCommandId: "send-3", seq: 9 },
], hasMore: false }, { latest: true });
assert.equal(repeatedText.messages.length, 2, "equal text from distinct commands remains two legitimate messages");

const fallback = applyCollaborationHistoryPage({}, { messages: [
  { conversationId: "c", senderUserId: "me", bodyText: "drift", createdAt: 1000, seq: null, state: "confirming", revision: 1 },
  { conversationId: "c", senderUserId: "me", bodyText: "drift", createdAt: 1550, seq: 22, state: "persisted", revision: 1 },
], hasMore: false }, { latest: true });
assert.equal(fallback.messages.length, 1, "durable identity fallback reconciles a drifted optimistic bubble");

console.log("collaboration history view passed");
