import assert from "node:assert/strict";
import { refreshVisibleHistory } from "../src/renderer/modules/collaboration-visible-history.js";
const existing = Array.from({ length: 401 }, (_, i) => ({ id: `m${i + 1}`, seq: i + 1, revision: 1, bodyText: "old" }));
const calls = [];
const result = await refreshVisibleHistory({ conversationId: "c", existing, latest: [existing.at(-1)], isCurrent: () => true,
  readMessages: async (request) => { calls.push(request); return { ok: true, messages: request.messageIds.filter((id) => id !== "m2").map((id) => ({ id, seq: Number(id.slice(1)), revision: 2, revokedAt: "now", bodyText: "" })), unavailableMessageIds: request.messageIds.includes("m2") ? ["m2"] : [] }; },
});
assert.deepEqual(calls.map((c) => c.messageIds.length), [200, 200]);
assert.equal(result.find((row) => row.id === "m1").revokedAt, "now", "already loaded old messages receive new tombstones");
assert.equal(result.some((row) => row.id === "m2"), false, "no longer authorized cached row is removed from the visible history");
assert.equal(result.at(-1).id, "m401");
let current = true, requests = 0;
const stale = await refreshVisibleHistory({ conversationId: "c", existing, latest: [], isCurrent: () => current,
  readMessages: async () => { requests++; current = false; return { ok: true, messages: [] }; },
});
assert.equal(stale, null); assert.equal(requests, 1, "navigation invalidation stops further page reads");
await assert.rejects(refreshVisibleHistory({ conversationId: "c", existing: [existing[0]], latest: [], isCurrent: () => true, readMessages: async () => ({ ok: false }) }));
console.log("collaboration visible history refresh passed");
