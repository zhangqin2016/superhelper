"use strict";

function errorCode(error) { return String(error?.code || ""); }

function isAmbiguousCommit(error) {
  return errorCode(error) === "COLLAB_RESPONSE_UNKNOWN";
}

function isRetryable(error) {
  const code = errorCode(error);
  return code === "COLLAB_TRANSACTION_RETRY" || code === "COLLAB_NETWORK_UNAVAILABLE" || code === "COLLAB_RATE_LIMITED";
}

/**
 * The persistent outbox has no permission to invent a new idempotency key.
 * In particular, an ambiguous response remains confirming until durable sync
 * matches the original clientCommandId.
 */
function createCollaborationOutbox({ store, transport, maxAutoRetries = 3, retryBaseMs = 1_000, retryMaxMs = 30_000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!store || typeof store.getOutbox !== "function" || typeof store.setOutboxState !== "function") throw new TypeError("A collaboration store is required.");
  if (!transport || typeof transport.submit !== "function") throw new TypeError("A collaboration transport is required.");
  const lanes = new Map();
  const retryTimers = new Map();
  function scheduleRetry(outboxId, attempt) {
    if (retryTimers.has(outboxId)) return;
    const exponent = Math.max(0, Number(attempt) - 1);
    const delay = Math.min(Math.max(1, Number(retryMaxMs) || 30_000), Math.max(1, Number(retryBaseMs) || 1_000) * (2 ** exponent));
    const timer = setTimeoutFn(() => {
      retryTimers.delete(outboxId);
      return submit(outboxId).catch(() => undefined);
    }, delay);
    retryTimers.set(outboxId, timer);
  }
  function enqueue(conversationId, operation) {
    const prior = lanes.get(conversationId) || Promise.resolve();
    const task = prior.catch(() => undefined).then(operation);
    const tail = task.catch(() => undefined);
    lanes.set(conversationId, tail);
    tail.finally(() => {
      if (lanes.get(conversationId) === tail) lanes.delete(conversationId);
    });
    return task;
  }
  async function submitNow(outboxId) {
    const item = store.getOutbox({ outboxId });
    if (!item) return { state: "missing" };
    if (item.state === "confirming" || item.state === "persisted") return { state: item.state, clientCommandId: item.clientCommandId };
    if (!store.setOutboxState({ outboxId: item.id, expectedStates: ["queued"], state: "submitting" })) {
      return { state: store.getOutbox({ outboxId: item.id })?.state || "missing", clientCommandId: item.clientCommandId };
    }
    try {
      await transport.submit(item);
      store.setOutboxState({ outboxId: item.id, expectedStates: ["submitting"], state: "confirming" });
      return { state: "confirming", clientCommandId: item.clientCommandId };
    } catch (error) {
      if (isAmbiguousCommit(error)) {
        store.setOutboxState({ outboxId: item.id, expectedStates: ["submitting"], state: "confirming" });
        return { state: "confirming", clientCommandId: item.clientCommandId };
      }
      if (isRetryable(error)) {
        const retry = store.recordOutboxRetry({ outboxId: item.id, maxAttempts: maxAutoRetries });
        if (retry?.state === "queued") scheduleRetry(item.id, retry.attempts);
      }
      else store.setOutboxState({ outboxId: item.id, expectedStates: ["submitting"], state: "failed" });
      throw error;
    }
  }
  function submit(outboxId) {
      const item = store.getOutbox({ outboxId });
      if (!item) return Promise.resolve({ state: "missing" });
      return enqueue(item.conversationId, () => submitNow(outboxId));
  }
  return {
    submit,
    continue(outboxId) {
      const item = store.getOutbox({ outboxId });
      if (!item || !store.setOutboxState({ outboxId: item.id, expectedStates: ["paused"], state: "queued" })) return { state: item?.state || "missing" };
      return { state: "queued", clientCommandId: item.clientCommandId };
    },
    skip(outboxId) {
      const item = store.getOutbox({ outboxId });
      if (!item || !store.setOutboxState({ outboxId: item.id, expectedStates: ["queued", "paused", "failed"], state: "cancelled" })) return { state: item?.state || "missing" };
      return { state: "cancelled" };
    },
    cancel(outboxId) {
      const item = store.getOutbox({ outboxId });
      if (!item) return Promise.resolve({ state: "missing" });
      return enqueue(item.conversationId, async () => {
        const current = store.getOutbox({ outboxId: item.id });
        if (!current) return { state: "missing" };
        if (["queued", "paused", "failed"].includes(current.state)) {
          store.setOutboxState({ outboxId: current.id, expectedStates: ["queued", "paused", "failed"], state: "cancelled" });
          return { state: "cancelled" };
        }
        if (!["submitting", "confirming"].includes(current.state)) return { state: current.state, ...(current.state === "persisted" ? { canRevoke: true } : {}) };
        if (!store.setOutboxState({ outboxId: current.id, expectedStates: ["submitting", "confirming"], state: "cancellation_requested" })) return { state: store.getOutbox({ outboxId: current.id })?.state || "missing" };
        if (typeof transport.lookupReceipt !== "function") return { state: "cancellation_requested", requiresReceiptCheck: true };
        const receipt = await transport.lookupReceipt({ clientCommandId: current.clientCommandId, conversationId: current.conversationId });
        if (receipt?.committed) {
          store.settleOutboxFromSync({ clientCommandId: current.clientCommandId, eventId: receipt.eventId || `receipt:${current.clientCommandId}`, messageId: receipt.messageId || current.messageId, sequence: receipt.sequence });
          return { state: "persisted", canRevoke: true };
        }
        store.setOutboxState({ outboxId: current.id, expectedStates: ["cancellation_requested"], state: "cancelled" });
        return { state: "cancelled" };
      });
    },
    async drainQueued() {
      const rows = store.listOutbox().filter((item) => item.state === "queued");
      await Promise.all(rows.map((item) => submit(item.id).catch(() => undefined)));
      return { drained: rows.length };
    },
    stop() {
      for (const timer of retryTimers.values()) clearTimeoutFn(timer);
      retryTimers.clear();
    },
  };
}

module.exports = { createCollaborationOutbox, isAmbiguousCommit, isRetryable };
