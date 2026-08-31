"use strict";

function errorCode(error) { return String(error?.code || ""); }

function isAmbiguousCommit(error) {
  return errorCode(error) === "COLLAB_RESPONSE_UNKNOWN";
}

function isRetryable(error) {
  const code = errorCode(error);
  return code === "COLLAB_TRANSACTION_RETRY" || code === "COLLAB_NETWORK_UNAVAILABLE" || code === "COLLAB_RATE_LIMITED";
}

function isStorageId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 512;
}

function isCompleteReceipt(receipt, item) {
  return receipt?.committed === true
    && (receipt.state == null || receipt.state === "completed") && receipt.ok !== false
    && isStorageId(receipt.eventId) && isStorageId(receipt.messageId)
    && isStorageId(item?.clientCommandId) && isStorageId(item?.conversationId)
    // Local keyring validates the full record key, not just the server ID.
    && isStorageId(`message:${item.conversationId}:${receipt.messageId}`)
    && Number.isSafeInteger(receipt.sequence) && receipt.sequence > 0;
}

function isUnknownReceipt(receipt) {
  // Only the server's explicit unknown contract allows same-key replay. A
  // missing, partial, or contradictory receipt is not a replay instruction.
  return receipt?.state === "unknown" && receipt.committed === false && receipt.deliveryUnknown === true
    && receipt.pending !== true && receipt.ok !== false
    && receipt.eventId == null && receipt.messageId == null && receipt.sequence == null;
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
 * Ambiguous responses recover only by receipt or bounded replay of the exact
 * durable command. Unknown delivery remains a conversation ordering barrier.
 */
function createCollaborationOutbox({ store, transport, deviceId = "", onStateChange = () => {}, maxAutoRetries = 3, retryBaseMs = 1_000, retryMaxMs = 30_000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!store || typeof store.getOutbox !== "function" || typeof store.setOutboxState !== "function") throw new TypeError("A collaboration store is required.");
  if (!transport || typeof transport.submit !== "function") throw new TypeError("A collaboration transport is required.");
  const lanes = new Map();
  const retryTimers = new Map();
  let stopped = false;
  const stoppedResult = () => ({ ok: false, code: "COLLABORATION_STOPPED" });
  const deviceMismatch = (item) => typeof deviceId === "string" && deviceId && typeof item?.originDeviceId === "string" && item.originDeviceId !== deviceId;
  const deviceResult = (item) => ({ state: item?.state || "missing", clientCommandId: item?.clientCommandId, code: "COLLAB_OUTBOX_DEVICE_CHANGED", recovery: "original_device_required" });
  function scheduleRetry(outboxId, attempt) {
    if (stopped || retryTimers.has(outboxId)) return;
    const exponent = Math.max(0, Number(attempt) - 1);
    const delay = Math.min(Math.max(1, Number(retryMaxMs) || 30_000), Math.max(1, Number(retryBaseMs) || 1_000) * (2 ** exponent));
    const timer = setTimeoutFn(() => {
      retryTimers.delete(outboxId);
      if (stopped) return Promise.resolve(stoppedResult());
      const item = store.getOutbox({ outboxId });
      if (item?.state === "confirming") return enqueue(item.conversationId, () => reconcileNow(outboxId, true)).catch(() => undefined);
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
    if (deviceMismatch(item)) return deviceResult(item);
    if (item.state === "confirming" || item.state === "persisted") return { state: item.state, clientCommandId: item.clientCommandId };
    if (item.deliveryConfirmed) {
      // An ACK can survive a crash before the following state transition. It
      // outranks a stale queued/submitting label at the final send boundary.
      store.setOutboxState({ outboxId: item.id, expectedStates: [item.state], state: "confirming" });
      onStateChange({ outboxId: item.id, state: "confirming" });
      return { state: "confirming", clientCommandId: item.clientCommandId };
    }
    const earlier = [];
    for (const queued of store.listOutbox?.() || []) {
      if (queued.id === item.id) break;
      if (queued.conversationId === item.conversationId) earlier.push(queued);
    }
    const barrierId = typeof store.findOutboxPredecessor === "function" ? store.findOutboxPredecessor({ outboxId: item.id })
      : earlier.find((queued) => ["queued", "submitting", "paused", "failed", "delivery_unknown", "cancellation_requested"].includes(queued.state)
        || (queued.state === "confirming" && !queued.deliveryConfirmed))?.id;
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
        if (typeof transport.lookupReceipt === "function") scheduleRetry(item.id, item.attempts + 1);
        return { state: "confirming", clientCommandId: item.clientCommandId };
      }
      if (item.deliveryUncertain) {
        // A definitive rejection of this replay says nothing about an earlier
        // dispatch. Preserve its uncertainty even after manual continuation.
        store.setOutboxState({ outboxId: item.id, expectedStates: ["submitting"], state: "confirming" });
        if (isRetryable(error)) {
          const retry = store.recordOutboxRetry({ outboxId: item.id, maxAttempts: maxAutoRetries, uncertainDelivery: true });
          if (retry) onStateChange({ outboxId: item.id, state: retry.state });
          if (retry?.state === "confirming") scheduleRetry(item.id, retry.attempts + 1);
        } else {
          store.setOutboxState({ outboxId: item.id, expectedStates: ["confirming"], state: "delivery_unknown" });
          onStateChange({ outboxId: item.id, state: "delivery_unknown" });
        }
        throw error;
      }
      if (isRetryable(error)) {
        const retry = store.recordOutboxRetry({ outboxId: item.id, maxAttempts: maxAutoRetries });
        if (retry) onStateChange({ outboxId: item.id, state: retry.state });
        if (retry?.state === "queued") scheduleRetry(item.id, retry.attempts);
      }
      else {
        store.setOutboxState({ outboxId: item.id, expectedStates: ["submitting"], state: "failed", deliveryUncertain: false });
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
  async function reconcileNow(outboxId, automatic = false) {
    const item = store.getOutbox({ outboxId });
    if (!item || !["confirming", "delivery_unknown", "cancellation_requested"].includes(item.state)) return;
    if (deviceMismatch(item)) return deviceResult(item);
    let receipt;
    try {
      receipt = await transport.lookupReceipt({ clientCommandId: item.clientCommandId, conversationId: item.conversationId });
    } catch {
      // Receipt failure leaves no positive evidence and cannot authorize replay.
    }
    if (stopped) return stoppedResult();
    let projectionFailed = false;
    if (isCompleteReceipt(receipt, item)) {
      // Commit evidence must survive even if encrypting the display projection
      // fails. A later stale/unknown receipt can never authorize replay again.
      store.confirmOutboxDelivery?.({ outboxId: item.id });
      try {
        store.settleOutboxFromSync({ clientCommandId: item.clientCommandId, eventId: receipt.eventId, messageId: receipt.messageId, sequence: receipt.sequence });
      } catch {
        projectionFailed = true; // SQLite retained the original command; retry its receipt, never its send.
      }
      if (!projectionFailed) {
        onStateChange({ outboxId: item.id, state: "persisted" });
        return;
      }
    }
    const current = store.getOutbox({ outboxId });
    // Cancelled/paused unknown delivery is receipt-only until explicit retry.
    // A successful ACK is already positive evidence and needs no replay.
    if (current?.state !== "confirming") return;
    if (current.deliveryConfirmed) {
      if (projectionFailed) scheduleRetry(outboxId, current.attempts + 1);
      return;
    }
    if (!automatic) { scheduleRetry(outboxId, current.attempts + 1); return; }
    const retry = store.recordOutboxRetry({ outboxId, maxAttempts: maxAutoRetries, uncertainDelivery: true });
    if (!retry) return;
    if (retry.state === "delivery_unknown") {
      onStateChange({ outboxId, state: retry.state });
      return;
    }
    if (isUnknownReceipt(receipt)) {
      try {
        // Keep confirming DURABLY throughout replay. A crash, network error,
        // or cancellation must never turn unknown delivery into "not sent".
        await transport.submit(transportSnapshot(current));
        if (stopped) return stoppedResult();
        store.confirmOutboxDelivery?.({ outboxId });
        onStateChange({ outboxId, state: "confirming" });
        return;
      } catch (error) {
        if (stopped) return stoppedResult();
        if (!isAmbiguousCommit(error) && !isRetryable(error)) {
          store.setOutboxState({ outboxId, expectedStates: ["confirming"], state: "delivery_unknown" });
          onStateChange({ outboxId, state: "delivery_unknown" });
          return;
        }
      }
    }
    scheduleRetry(outboxId, retry.attempts + 1);
  }
  return {
    submit,
    async reconcilePending() {
      if (stopped) return stoppedResult();
      if (typeof transport.lookupReceipt !== "function") return;
      for (const item of store.listOutbox().filter((row) => ["confirming", "delivery_unknown", "cancellation_requested"].includes(row.state))) {
        await enqueue(item.conversationId, () => reconcileNow(item.id)).catch(() => undefined);
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
      if (item?.deliveryConfirmed) return { state: item.state, canRevoke: true };
      if (item?.deliveryUncertain) {
        if (store.setOutboxState({ outboxId: item.id, expectedStates: ["queued", "paused", "failed"], state: "delivery_unknown" })) {
          onStateChange({ outboxId: item.id, state: "delivery_unknown" });
          return { state: "delivery_unknown" };
        }
        return { state: item.state };
      }
      if (!item || !store.setOutboxState({ outboxId: item.id, expectedStates: ["queued", "paused", "failed"], state: "cancelled" })) return { state: item?.state || "missing" };
      return { state: "cancelled" };
    },
    cancel(outboxId) {
      if (stopped) return Promise.resolve(stoppedResult());
      const item = store.getOutbox({ outboxId });
      if (!item) return Promise.resolve({ state: "missing" });
      if (deviceMismatch(item)) return Promise.resolve(deviceResult(item));
      return enqueue(item.conversationId, async () => {
        const current = store.getOutbox({ outboxId: item.id });
        if (!current) return { state: "missing" };
        if (deviceMismatch(current)) return deviceResult(current);
        if (current.deliveryConfirmed) return { state: current.state, canRevoke: true };
        if (["queued", "paused", "failed"].includes(current.state) && !current.deliveryUncertain) {
          store.setOutboxState({ outboxId: current.id, expectedStates: ["queued", "paused", "failed"], state: "cancelled" });
          return { state: "cancelled" };
        }
        const cancellableStates = ["submitting", "confirming", ...(current.deliveryUncertain ? ["queued", "paused", "failed"] : [])];
        if (!cancellableStates.includes(current.state)) return { state: current.state, ...(current.state === "persisted" ? { canRevoke: true } : {}) };
        if (!store.setOutboxState({ outboxId: current.id, expectedStates: cancellableStates, state: "cancellation_requested" })) return { state: store.getOutbox({ outboxId: current.id })?.state || "missing" };
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
        if (isCompleteReceipt(receipt, current)) {
          store.confirmOutboxDelivery?.({ outboxId: current.id });
          try {
            store.settleOutboxFromSync({ clientCommandId: current.clientCommandId, eventId: receipt.eventId, messageId: receipt.messageId, sequence: receipt.sequence });
            return { state: "persisted", canRevoke: true };
          } catch {
            // A local projection failure must also leave an explicit recovery
            // state rather than a rejected cancel stuck in cancellation_requested.
          }
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
