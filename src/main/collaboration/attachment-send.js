"use strict";

const fail = (code) => ({ ok: false, code, retryable: false });
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);

// This is deliberately a persistence coordinator, not another dispatch
// queue. Transfer manifests hold the waiting intent; this module performs the
// one-way handoff into the existing durable text outbox once transfers prove
// that their server object references are usable.
function createAttachmentSendCoordinator({ store, transfers, outbox, deviceId = null, assertActive = () => {}, onChange = () => {} } = {}) {
  if (!store || !transfers || !outbox) throw new TypeError("Attachment send dependencies are required.");
  const identical = (row, intent) => row && row.conversationId === intent.conversationId && row.bodyText === intent.bodyText
    && row.scopeId === intent.scopeId && JSON.stringify(row.attachmentIds || []) === JSON.stringify(intent.attachmentIds || []) && row.attachmentPurpose === intent.purpose;
  const handoffs = new Map();
  async function handoffDurably(intent) {
    assertActive();
    const ready = await transfers.handoffIntent(intent);
    // A transfer verification can await network work. Never let a stopped,
    // revoked, or replaced account cross that boundary into SQLite/outbox.
    assertActive();
    if (ready?.state !== "ready_to_handoff") return { ok: true, state: "waiting_attachments", clientCommandId: intent.clientCommandId };
    const existing = store.getOutbox?.({ outboxId: intent.clientCommandId });
    if (existing) {
      if (!identical(existing, ready)) return fail("IDEMPOTENCY_KEY_REUSED");
      transfers.completeHandoff?.(ready);
      return { ok: true, state: existing.state, clientCommandId: intent.clientCommandId, handedOff: false };
    }
    const persisted = store.persistDraftAndOptimisticMessage({
      conversationId: ready.conversationId, draftId: "composer", draftText: "", messageId: `optimistic:${ready.clientCommandId}`,
      clientCommandId: ready.clientCommandId, bodyText: ready.bodyText, scopeId: ready.scopeId,
      attachmentIds: ready.attachmentIds, attachmentPurpose: ready.purpose,
      // Attachment verification may finish long after the explicit send.  It
      // never owns the composer, even if a later user draft has identical text.
      preserveDraft: true,
      ...(deviceId == null ? {} : { originDeviceId: deviceId }),
    });
    // The SQLite write is the only durable dispatch admission. Marking the
    // manifest afterwards is merely recovery bookkeeping, so a crash here is
    // harmless: recovery observes the existing outbox row and never writes a
    // second one.
    assertActive();
    transfers.completeHandoff?.(ready);
    assertActive(); onChange();
    const submitted = await outbox.submit(persisted.outboxId);
    assertActive(); onChange();
    return { ok: true, ...submitted, clientCommandId: ready.clientCommandId, handedOff: true };
  }
  function handoff(intent) {
    const current = handoffs.get(intent.clientCommandId);
    if (current) return current;
    const task = handoffDurably(intent).finally(() => handoffs.delete(intent.clientCommandId));
    handoffs.set(intent.clientCommandId, task);
    return task;
  }
  return Object.freeze({
    async sendAttachments({ conversationId, transferIds, bodyText, clientCommandId } = {}) {
      if (!validId(conversationId) || !Array.isArray(transferIds) || transferIds.length < 1 || transferIds.length > 20
        || transferIds.some((id) => !validId(id)) || new Set(transferIds).size !== transferIds.length
        || typeof bodyText !== "string" || Buffer.byteLength(bodyText, "utf8") > 32 * 1024 || (clientCommandId != null && !validId(clientCommandId))) return fail("COLLABORATION_INVALID_INPUT");
      assertActive();
      const intent = await transfers.createSendIntent({ conversationId, transferIds, bodyText, clientCommandId });
      assertActive(); onChange();
      const result = await handoff(intent);
      return result?.state === "waiting_attachments" ? { ok: true, state: "waiting_attachments", clientCommandId: intent.clientCommandId } : result;
    },
    async recover() {
      assertActive();
      let handedOff = 0; const failures = [];
      for (const intent of await transfers.listSendIntents()) {
        if (intent.recoveryError) {
          failures.push({ clientCommandId: intent.clientCommandId, code: intent.recoveryError });
          continue;
        }
        try {
          const result = await handoff(intent);
          if (result?.handedOff) handedOff += 1;
        } catch (error) {
          if (["COLLABORATION_STOPPED", "COLLAB_ACCOUNT_CHANGED"].includes(error?.code)) throw error;
          failures.push({ clientCommandId: intent.clientCommandId, code: String(error?.code || "COLLAB_ATTACHMENT_INTENT_UNAVAILABLE") });
        }
      }
      return { handedOff, ...(failures.length ? { failures } : {}) };
    },
  });
}

module.exports = { createAttachmentSendCoordinator };
