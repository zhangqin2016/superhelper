import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { createCollaborationService } = createRequire(import.meta.url)("../src/main/collaboration/service.js");
const store = {
  getSyncState: () => ({ cursor: 8, watermark: 5 }), applySyncPage() {}, close() {},
  listOutbox: () => [{ id: "queued-1", state: "queued" }],
  listConversations: () => [{ id: "c1", title: "Project", kind: "team" }],
  getConversation: ({ conversationId }) => conversationId === "c1" ? { id: "c1", title: "Project" } : null,
  listMessages: ({ conversationId }) => conversationId === "c1" ? [{ id: "m1", bodyText: "hello" }] : [],
};
const service = createCollaborationService({ openStore: () => ({ ok: true, store }) });
assert.deepEqual(service.getState(), { ok: true, cursor: 8, watermark: 5, outbox: [{ id: "queued-1", state: "queued" }] });
assert.deepEqual(service.list(), { ok: true, conversations: [{ id: "c1", title: "Project", kind: "team" }] });
assert.deepEqual(await service.open({ conversationId: "c1" }), { ok: true, conversation: { id: "c1", title: "Project" }, messages: [{ id: "m1", bodyText: "hello" }] });
assert.deepEqual(await service.open({ conversationId: "missing" }), { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false });

const bootstrapCalls = [];
const bootstrapStore = {
  getSyncState: () => ({ cursor: 1, watermark: 1 }), applySyncPage() {}, close() {},
  replaceProjectionFromBootstrap(snapshot) { bootstrapCalls.push(["commit", snapshot]); return { cursor: snapshot.watermark }; },
};
const bootstrapService = createCollaborationService({
  openStore: () => ({ ok: true, store: bootstrapStore }), deviceId: "device-1",
  client: {
    async bootstrap(input) { bootstrapCalls.push(["fetch", input]); return { watermark: 9, bootstrapCompletionToken: "server-only" }; },
    async acknowledgeCursor(input) { bootstrapCalls.push(["ack", input]); },
  },
});
assert.deepEqual(await bootstrapService.bootstrap(), { ok: true, cursor: 9 });
assert.deepEqual(bootstrapCalls.map(([kind]) => kind), ["fetch", "commit", "ack"], "bootstrap writes locally before its completion acknowledgement");
assert.equal(bootstrapCalls[2][1].cursor, 9);

assert.deepEqual(await service.bootstrap(), { ok: false, code: "COLLABORATION_UNAVAILABLE" }, "a cache without a main-process network client never fakes a bootstrap");

const pending = new Map();
const submitted = [];
const sendStore = {
  getSyncState: () => ({ cursor: 0, watermark: 0 }), applySyncPage() {}, close() {},
  getConversation: ({ conversationId }) => conversationId === "c1" ? { id: "c1", scopeId: "team:t1" } : null,
  persistDraftAndOptimisticMessage(input) {
    pending.set(input.clientCommandId, { id: input.clientCommandId, conversationId: input.conversationId, clientCommandId: input.clientCommandId, bodyText: input.bodyText, state: "queued" });
    return { outboxId: input.clientCommandId };
  },
  getOutbox: ({ outboxId }) => pending.get(outboxId) || null,
  setOutboxState({ outboxId, expectedStates, state }) {
    const item = pending.get(outboxId);
    if (!item || !expectedStates.includes(item.state)) return false;
    item.state = state;
    return true;
  },
  listOutbox: () => [...pending.values()],
};
const sendingService = createCollaborationService({
  openStore: () => ({ ok: true, store: sendStore }),
  // Keep the exact transport reference: a state transition after transport
  // resolves must never retroactively mutate the submitted command.
  transport: { async submit(item) { submitted.push(item); } },
});
const stateChanges = [];
const unsubscribeState = sendingService.subscribe((change) => stateChanges.push(change.type));
assert.deepEqual(await sendingService.send({ conversationId: "c1", clientCommandId: "cmd-1", bodyText: "local-first" }), { ok: true, state: "confirming", clientCommandId: "cmd-1" });
assert.deepEqual(submitted, [{ id: "cmd-1", conversationId: "c1", clientCommandId: "cmd-1", bodyText: "local-first", state: "submitting" }], "send persists then submits the original idempotency key");
assert.deepEqual(stateChanges, ["outbox"], "a durable outbox transition publishes an opaque state refresh hint");
assert.deepEqual(await sendingService.send({ conversationId: "c1", clientCommandId: "cmd-1", bodyText: "local-first" }), { ok: true, state: "confirming", clientCommandId: "cmd-1" }, "replaying a client command returns the durable existing state instead of a SQLite uniqueness failure");
assert.equal(submitted.length, 1, "replayed client commands do not enqueue a second network write");
unsubscribeState();
assert.deepEqual(await sendingService.send({ conversationId: "missing", clientCommandId: "cmd-2", bodyText: "no" }), { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false });

console.log("collaboration projection service checks passed");
