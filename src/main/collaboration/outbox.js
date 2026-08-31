"use strict";

function errorCode(error) { return String(error?.code || ""); }

function isAmbiguousCommit(error) {
  return errorCode(error) === "COLLAB_RESPONSE_UNKNOWN";
}

function isRetryable(error) {
  const code = errorCode(error);
  return code === "COLLAB_TRANSACTION_RETRY" || code === "COLLAB_NETWORK_UNAVAILABLE" || code === "COLLAB_RATE_LIMITED";
}

// Stores may legally return a live object. A transport is asynchronous, so it
// must receive a command snapshot rather than an object whose state machine
// transition can be observed retroactively after the request resolves.
function transportSnapshot(item) {
  if (typeof structuredClone === "function") return structuredClone(item);
  return JSON.parse(JSON.stringify(item));
}

/**
 * The persistent outbox has no permission to invent a new idempotency key.
 * In particular, an ambiguous response remains confirming until durable sync
 * matches the original clientCommandId.
 */
function createCollaborationOutbox({ store, transport, onStateChange = () => {}, maxAutoRetries = 3, retryBaseMs = 1_000, retryMaxMs = 30_000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!store || typeof store.getOutbox !== "function" || typeof store.setOutboxState !== "function") throw new TypeError("A collaboration store is required.");
  if (!transport || typeof transport.submit !== "function") throw new TypeError("A collaboration transport is required.");
  const lanes = new Map();
  const retryTimers = new Map();
  let stopped = false;
  const stoppedResult = () => ({ ok: false, code: "COLLABORATION_STOPPED" });
  function scheduleRetry(outboxId, attempt) {
    if (stopped || retryTimers.has(outboxId)) return;
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
    const task = prior.catch(() => undefined).then(() => stopped ? stoppedResult() : operation());
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
    const earlier = [];
    for (const queued of store.listOutbox?.() || []) {
      if (queued.id === item.id) break;
      if (queued.conversationId === item.conversationId) earlier.push(queued);
    }
    const barrierId = typeof store.findOutboxPredecessor === "function" ? store.findOutboxPredecessor({ outboxId: item.id })
      : earlier.find((queued) => ["queued", "submitting", "paused", "failed", "delivery_unknown", "cancellation_requested"].includes(queued.state))?.id;
    if (barrierId) return { state: item.state, clientCommandId: item.clientCommandId, blockedBy: barrierId };
    if (!store.setOutboxState({ outboxId: item.id, expectedStates: ["queued"], state: "submitting" })) {
      return { state: store.getOutbox({ outboxId: item.id })?.state || "missing", clientCommandId: item.clientCommandId };
    }
    try {
      await transport.submit(transportSnapshot(item));
      // Shutdown is not proof of delivery or cancellation. Leave submitting
      // durable so the next service can recover this exact idempotency key.
      if (stopped) return stoppedResult();
      store.confirmOutboxDelivery?.({ outboxId: item.id });
      store.setOutboxState({ outboxId: item.id, expectedStates: ["submitting"], state: "confirming" });
      onStateChange({ outboxId: item.id, state: "confirming" });
      return { state: "confirming", clientCommandId: item.clientCommandId };
    } catch (error) {
      if (stopped) return stoppedResult();
      if (isAmbiguousCommit(error)) {
        store.setOutboxState({ outboxId: item.id, expectedStates: ["submitting"], state: "confirming" });
        onStateChange({ outboxId: item.id, state: "confirming" });
        return { state: "confirming", clientCommandId: item.clientCommandId };
      }
      if (isRetryable(error)) {
        const retry = store.recordOutboxRetry({ outboxId: item.id, maxAttempts: maxAutoRetries });
        if (retry) onStateChange({ outboxId: item.id, state: retry.state });
        if (retry?.state === "queued") scheduleRetry(item.id, retry.attempts);
      }
      else {
        store.setOutboxState({ outboxId: item.id, expectedStates: ["submitting"], state: "failed" });
        onStateChange({ outboxId: item.id, state: "failed" });
      }
      throw error;
    }
  }
  function submit(outboxId) {
      if (stopped) return Promise.resolve(stoppedResult());
      const item = store.getOutbox({ outboxId });
      if (!item) return Promise.resolve({ state: "missing" });
      return enqueue(item.conversationId, () => submitNow(outboxId));
  }
  return {
    submit,
    async reconcilePending() {
      if (stopped) return stoppedResult();
      if (typeof transport.lookupReceipt !== "function") return;
      for (const item of store.listOutbox().filter((row) => ["confirming", "delivery_unknown", "cancellation_requested"].includes(row.state))) {
        await enqueue(item.conversationId, async () => {
          const current = store.getOutbox({ outboxId: item.id });
          if (!current || !["confirming", "delivery_unknown", "cancellation_requested"].includes(current.state)) return;
          const receipt = await transport.lookupReceipt({ clientCommandId: current.clientCommandId, conversationId: current.conversationId });
          if (stopped) return stoppedResult();
          if (!receipt?.committed || !receipt.messageId || !receipt.eventId || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) return;
          store.settleOutboxFromSync({ clientCommandId: current.clientCommandId, eventId: receipt.eventId, messageId: receipt.messageId, sequence: receipt.sequence });
          onStateChange({ outboxId: current.id, state: "persisted" });
        }).catch(() => undefined); // an unavailable receipt never proves non-delivery
        if (stopped) return stoppedResult();
      }
    },
    continue(outboxId) {
      if (stopped) return stoppedResult();
      const item = store.getOutbox({ outboxId });
      if (!item || !store.setOutboxState({ outboxId: item.id, expectedStates: ["paused", "delivery_unknown"], state: "queued" })) return { state: item?.state || "missing" };
      return { state: "queued", clientCommandId: item.clientCommandId };
    },
    skip(outboxId) {
      if (stopped) return stoppedResult();
      const item = store.getOutbox({ outboxId });
      if (!item || !store.setOutboxState({ outboxId: item.id, expectedStates: ["queued", "paused", "failed", "delivery_unknown"], state: "cancelled" })) return { state: item?.state || "missing" };
      return { state: "cancelled" };
    },
    cancel(outboxId) {
      if (stopped) return Promise.resolve(stoppedResult());
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
        if (typeof transport.lookupReceipt !== "function") {
          // A local cancellation request cannot prove the server did not
          // commit. Do not display it as cancellation: retain the original
          // idempotency key and give the user an explicit recovery decision.
          store.setOutboxState({ outboxId: current.id, expectedStates: ["cancellation_requested"], state: "delivery_unknown" });
          onStateChange({ outboxId: current.id, state: "delivery_unknown" });
          return { state: "delivery_unknown", recovery: "retry_or_sync", requiresSync: true };
        }
        let receipt;
        try {
          receipt = await transport.lookupReceipt({ clientCommandId: current.clientCommandId, conversationId: current.conversationId });
        } catch {
          if (stopped) return stoppedResult();
          // Receipt retrieval has the same ambiguity as the original send.
          // Never strand the durable row in cancellation_requested.
          store.setOutboxState({ outboxId: current.id, expectedStates: ["cancellation_requested"], state: "delivery_unknown" });
          onStateChange({ outboxId: current.id, state: "delivery_unknown" });
          return { state: "delivery_unknown", recovery: "retry_or_sync", requiresSync: true };
        }
        if (stopped) return stoppedResult();
        if (receipt?.committed) {
          store.settleOutboxFromSync({ clientCommandId: current.clientCommandId, eventId: receipt.eventId || `receipt:${current.clientCommandId}`, messageId: receipt.messageId || current.messageId, sequence: receipt.sequence });
          return { state: "persisted", canRevoke: true };
        }
        // A receipt query is a point-in-time observation. An absent/running
        // row cannot prove that a timed-out command will never commit, so it
        // must not falsely cancel an optimistic message.
        store.setOutboxState({ outboxId: current.id, expectedStates: ["cancellation_requested"], state: "delivery_unknown" });
        onStateChange({ outboxId: current.id, state: "delivery_unknown" });
        return { state: "delivery_unknown", recovery: "retry_or_sync", requiresSync: true };
      });
    },
    async drainQueued() {
      if (stopped) return stoppedResult();
      const rows = store.listOutbox().filter((item) => item.state === "queued");
      await Promise.all(rows.map((item) => submit(item.id).catch(() => undefined)));
      if (stopped) return stoppedResult();
      return { drained: rows.length };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of retryTimers.values()) clearTimeoutFn(timer);
      retryTimers.clear();
    },
  };
}

module.exports = { createCollaborationOutbox, isAmbiguousCommit, isRetryable, transportSnapshot };
