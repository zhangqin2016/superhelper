"use strict";

const { openCollaborationStore } = require("./collaboration-store");
const { createCollaborationSyncEngine } = require("./sync-engine");
const { createCollaborationOutbox } = require("./outbox");
const { createCollaborationRealtimeClient } = require("./realtime-client");

function unavailableService() {
  return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
}

/**
 * Startup adapter: the collaboration cache is strictly optional.  In
 * particular we never touch safeStorage or SQLite before both the signed
 * policy and the account identity have made the feature eligible.
 */
function initializeCollaborationService({
  policy,
  accountStatus,
  createKeyring = () => new (require("./local-keyring").LocalCollaborationKeyring)(),
  createService = createCollaborationService,
} = {}) {
  if (policy?.enabled !== true) return unavailableService();
  try {
    const account = typeof accountStatus === "function" ? accountStatus() : null;
    const accountId = String(account?.loggedIn ? account?.user?.id || "" : "").trim();
    if (!accountId) return unavailableService();
    const service = createService({ storeOptions: { accountId, keyring: createKeyring() }, policy });
    return service?.ok === true ? service : unavailableService();
  } catch {
    return unavailableService();
  }
}

/** Build collaboration outside the Electron startup critical path. */
function createCollaborationService({ openStore = openCollaborationStore, storeOptions, client, transport, deviceId = "", realtimeEnabled = true, realtimeOptions = {} } = {}) {
  const opened = openStore(storeOptions);
  if (!opened?.ok) return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  try {
    const store = opened.store;
    const stateListeners = new Set();
    const emitState = (type) => {
      for (const listener of stateListeners) {
        try { listener({ type }); } catch { /* view observers never affect durable state */ }
      }
    };
    const syncEngine = createCollaborationSyncEngine({ store });
    let httpPollTimer = null;
    const hydrateAuthorizedHistory = async (conversationIds) => {
      if (!client || !deviceId || typeof client.listMessageHistory !== "function" || typeof store.hydrateAuthorizedHistory !== "function") return;
      for (const conversationId of [...new Set((conversationIds || []).map(String).filter(Boolean))]) {
        const history = await client.listMessageHistory({ deviceId, conversationId });
        const messages = Array.isArray(history) ? history : history?.messages ?? history?.items;
        if (!Array.isArray(messages)) throw Object.assign(new Error("Invalid collaboration history"), { code: "COLLAB_HISTORY_INVALID" });
        store.hydrateAuthorizedHistory({ conversationId, messages });
      }
    };
    const outbox = transport ? createCollaborationOutbox({ store, transport, onStateChange: () => emitState("outbox") }) : null;
    const messageConversationIdsFor = (events) => (events || [])
      .filter((event) => String(event?.type || "").startsWith("message."))
      .map((event) => event?.conversationId ?? event?.conversation_id);
    const recoverPendingHistory = async () => {
      const pending = typeof store.listPendingHistoryHydration === "function"
        ? store.listPendingHistoryHydration() : [];
      // A failed history request intentionally rejects. The lane must not
      // issue another page or ACK beyond a durable hydration checkpoint.
      await hydrateAuthorizedHistory(pending);
    };
    const synchronizeNow = () => {
      const current = store.getSyncState();
      return Promise.resolve(client.syncAndAcknowledge({
        ...realtimeOptions.syncArgs, afterCursor: current.cursor, syncEngine,
        onFullResync: async ({ snapshot, acknowledge }) => {
          const applied = syncEngine.applyBootstrap({ ...snapshot, history: [] });
          await hydrateAuthorizedHistory((snapshot.conversations || []).map((conversation) => conversation?.id));
          await acknowledge();
          return { ...applied, events: [], historyHydrated: true };
        },
        onIncrementalPage: async ({ page, acknowledge }) => {
          const applied = syncEngine.applyPage(page);
          await hydrateAuthorizedHistory(messageConversationIdsFor(page.events));
          await acknowledge();
          return { ...applied, events: Array.isArray(page.events) ? page.events : [], historyHydrated: true };
        },
      }))
        .then(async (result) => {
          if (!result?.historyHydrated) await hydrateAuthorizedHistory(messageConversationIdsFor(result?.events));
          await outbox?.reconcilePending?.();
          await outbox?.drainQueued?.();
          emitState("sync");
          return result;
        });
    };
    // One durable lane covers startup, HTTP polling, realtime hints and
    // cancellation recovery. It prevents a later empty page from ACKing past
    // an earlier crash/retry hydration checkpoint.
    let syncLane = Promise.resolve();
    const synchronize = () => {
      if (!client) return Promise.resolve(unavailableService());
      const task = syncLane.catch(() => undefined).then(async () => {
        await recoverPendingHistory();
        return synchronizeNow();
      });
      syncLane = task.catch(() => undefined);
      return task;
    };
    // Every fire-and-forget lifecycle trigger terminates its own rejection.
    // UI/realtime are hints; a failed HTTP sync must never become an unhandled
    // rejection in Electron's main process.
    const synchronizeSafely = () => synchronize().catch(() => undefined);
    const realtime = client && realtimeEnabled
      ? createCollaborationRealtimeClient({
        ...realtimeOptions,
        onReconnect: () => outbox?.drainQueued?.(),
        sync: synchronize,
      })
      : null;
    return {
      ok: true, store, syncEngine, outbox, realtime,
      subscribe(listener) {
        if (typeof listener !== "function") return () => {};
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      getState() {
        const sync = store.getSyncState();
        return { ok: true, cursor: sync.cursor, watermark: sync.watermark, outbox: store.listOutbox?.() || [] };
      },
      list() {
        if (typeof store.listConversations !== "function") return unavailableService();
        return { ok: true, conversations: store.listConversations() };
      },
      getDraft({ conversationId } = {}) {
        if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        return { ok: true, text: store.getDraft({ conversationId, draftId: "composer" })?.text || "" };
      },
      saveDraft({ conversationId, text } = {}) {
        if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        store.saveDraft({ conversationId, text });
        return { ok: true };
      },
      async open({ conversationId } = {}) {
        if (typeof store.getConversation !== "function" || typeof store.listMessages !== "function") return unavailableService();
        const conversation = store.getConversation({ conversationId });
        if (!conversation) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        try {
          await hydrateAuthorizedHistory([conversationId]);
        } catch (error) {
          // Offline reading is local-first. An authorization failure is NOT
          // an offline condition and must never expose cached content here.
          if (!["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "COLLAB_NETWORK_UNAVAILABLE", "COLLAB_RESPONSE_UNKNOWN"].includes(error?.code)) throw error;
        }
        return { ok: true, conversation, messages: store.listMessages({ conversationId }) };
      },
      async bootstrap() {
        if (!client || !deviceId) return unavailableService();
        const snapshot = await client.bootstrap({ deviceId });
        // Raw bootstrap history is encrypted at rest on the server. It never
        // crosses into the desktop projection; authorized history is fetched
        // through the server's decrypting history endpoint below.
        const applied = syncEngine.applyBootstrap({ ...snapshot, history: [] });
        await hydrateAuthorizedHistory((snapshot.conversations || []).map((conversation) => conversation?.id));
        await client.acknowledgeCursor({ deviceId, cursor: applied.cursor, bootstrapCompletionToken: snapshot.bootstrapCompletionToken });
        emitState("bootstrap");
        return { ok: true, cursor: applied.cursor };
      },
      async send({ conversationId, clientCommandId, bodyText } = {}) {
        if (!outbox || typeof store.getConversation !== "function") return unavailableService();
        const existing = store.getOutbox?.({ outboxId: clientCommandId });
        if (existing) {
          if (existing.conversationId !== conversationId || existing.bodyText !== bodyText) return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", retryable: false };
          return { ok: true, state: existing.state, clientCommandId: existing.clientCommandId };
        }
        const conversation = store.getConversation({ conversationId });
        if (!conversation) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const messageId = `optimistic:${clientCommandId}`;
        const persisted = store.persistDraftAndOptimisticMessage({
          conversationId, draftId: "composer", draftText: "", messageId, clientCommandId, bodyText, scopeId: conversation.scopeId,
        });
        const submitted = await outbox.submit(persisted.outboxId);
        return { ok: true, ...submitted };
      },
      async edit({ conversationId, messageId, clientCommandId, expectedRevision, bodyText } = {}) {
        if (!client || !deviceId || !store.getMessage?.({ conversationId, messageId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const result = await client.submitMessage({ action: "edit", deviceId, conversationId, messageId, clientCommandId, expectedRevision, bodyText });
        void synchronizeSafely();
        emitState("message");
        return { ok: true, clientCommandId, state: "confirming", ...(result?.message?.seq ? { seq: result.message.seq } : {}) };
      },
      async revoke({ conversationId, messageId, clientCommandId, expectedRevision } = {}) {
        if (!client || !deviceId || !store.getMessage?.({ conversationId, messageId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const result = await client.submitMessage({ action: "revoke", deviceId, conversationId, messageId, clientCommandId, expectedRevision });
        void synchronizeSafely();
        emitState("message");
        return { ok: true, clientCommandId, state: "confirming", ...(result?.message?.seq ? { seq: result.message.seq } : {}) };
      },
      async friend(command = {}) {
        if (!client || !deviceId || typeof client.submitFriend !== "function") return unavailableService();
        const result = await client.submitFriend({ ...command, deviceId });
        void synchronizeSafely();
        emitState("relationship");
        return { ok: true, clientCommandId: command.clientCommandId, state: "confirming", ...(result?.status ? { state: String(result.status) } : {}) };
      },
      async retry({ outboxId } = {}) {
        if (!outbox) return unavailableService();
        const continued = outbox.continue(outboxId);
        const result = continued.state === "queued" ? { ok: true, ...(await outbox.submit(outboxId)) } : { ok: true, ...continued };
        return result;
      },
      async cancel({ outboxId } = {}) {
        if (!outbox) return unavailableService();
        const result = { ok: true, ...(await outbox.cancel(outboxId)) };
        if (result.requiresSync) void synchronizeSafely();
        return result;
      },
      async markRead({ conversationId, seq } = {}) {
        if (!client || !deviceId || !Number.isSafeInteger(Number(seq)) || Number(seq) < 0) return unavailableService();
        const result = await client.submitMessage({ action: "read", deviceId, conversationId, seq: Number(seq), clientCommandId: `read:${conversationId}:${Number(seq)}` });
        emitState("read");
        return { ok: true, conversationId, seq: Number(result?.lastReadSeq ?? seq) };
      },
      start() {
        const recovered = store.recoverAbandonedSubmittingOutbox?.();
        if (recovered?.recovered) emitState("outbox");
        void Promise.resolve(outbox?.drainQueued?.()).catch(() => undefined);
        // The serialized synchronize lane first recovers any crash-surviving
        // hydration checkpoint before issuing this initial page or any ACK.
        if (client) void synchronizeSafely();
        if (realtime) realtime.start();
        else if (client && httpPollTimer == null) {
          httpPollTimer = setInterval(() => { void synchronizeSafely(); }, 15_000);
          httpPollTimer.unref?.();
        }
      },
      stop() { realtime?.stop(); if (httpPollTimer != null) clearInterval(httpPollTimer); httpPollTimer = null; outbox?.stop?.(); store.close?.(); },
    };
  } catch {
    try { opened.store?.close?.(); } catch { /* isolation boundary */ }
    return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  }
}

module.exports = { createCollaborationService, initializeCollaborationService, unavailableService };
