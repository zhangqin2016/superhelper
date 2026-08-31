"use strict";

const { openCollaborationStore } = require("./collaboration-store");
const { createCollaborationSyncEngine } = require("./sync-engine");
const { createCollaborationOutbox } = require("./outbox");
const { createCollaborationRealtimeClient } = require("./realtime-client");
const { readHistoryPage } = require("./history-page");
const { hydratePendingConversation } = require("./history-hydration");
const { isConversationRevoked, recoverAccessDenial } = require("./access-revocation");
const { recoverConversationHydration } = require("./conversation-hydration");
const { directoryView } = require("./directory-view");

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
    let stopped = false;
    let started = false;
    const stoppedResult = () => ({ ok: false, code: "COLLABORATION_STOPPED" });
    const assertActive = () => {
      if (stopped) throw Object.assign(new Error("Collaboration service stopped"), { code: "COLLABORATION_STOPPED" });
    };
    const stateListeners = new Set();
    const emitState = (type) => {
      if (stopped) return;
      for (const listener of stateListeners) {
        try { listener({ type }); } catch { /* view observers never affect durable state */ }
      }
    };
    const engine = createCollaborationSyncEngine({ store });
    const syncEngine = {
      applyPage(page) {
        assertActive();
        try { return engine.applyPage(page); } finally {
          if (page.events?.some((event) => ["scope.revoked", "member.removed", "member.left"].includes(event.type)) && store.getSyncState().cursor >= page.toCursor) emitState("access-revoked");
        }
      },
      applyBootstrap(snapshot) {
        assertActive();
        const previous = store.listConversationIds?.() || [];
        try { return engine.applyBootstrap(snapshot); } finally {
          if (previous.some((conversationId) => !store.getConversation({ conversationId }))) emitState("access-revoked");
        }
      },
    };
    const recoverDeniedHistory = (conversationId, error) => {
      try { return recoverAccessDenial(store, conversationId, error); } finally {
        if (isConversationRevoked(store, conversationId)) emitState("access-revoked");
      }
    };
    let httpPollTimer = null;
    const hydrateAuthorizedHistory = async (conversationIds) => {
      assertActive();
      if (!client || !deviceId || typeof client.listMessageHistory !== "function" || typeof store.hydrateAuthorizedHistory !== "function") return;
      for (const conversationId of [...new Set((conversationIds || []).map(String).filter(Boolean))]) {
        if (isConversationRevoked(store, conversationId)) continue;
        try {
        if (typeof store.listHistoryTargets === "function") {
          await hydratePendingConversation({ store, client, deviceId, conversationId, assertActive });
          continue;
        }
        const history = await client.listMessageHistory({ deviceId, conversationId });
        assertActive();
        const messages = Array.isArray(history) ? history : history?.messages ?? history?.items;
        if (!Array.isArray(messages)) throw Object.assign(new Error("Invalid collaboration history"), { code: "COLLAB_HISTORY_INVALID" });
        store.hydrateAuthorizedHistory({ conversationId, messages });
        } catch (error) {
          assertActive();
          if (!recoverDeniedHistory(conversationId, error)) throw error;
        }
      }
    };
    const outbox = transport ? createCollaborationOutbox({ store, transport, onStateChange: () => emitState("outbox") }) : null;
    const messageConversationIdsFor = (events) => (events || [])
      .filter((event) => String(event?.type || "").startsWith("message."))
      .map((event) => event?.conversationId ?? event?.conversation_id);
    const recoverPendingHistory = async () => {
      assertActive();
      store.flushRevokedKeys?.();
      await recoverConversationHydration({ store, client, deviceId, assertActive, recoverDeniedHistory });
      const pending = typeof store.listPendingHistoryHydration === "function"
        ? store.listPendingHistoryHydration() : [];
      // A failed history request intentionally rejects. The lane must not
      // issue another page or ACK beyond a durable hydration checkpoint.
      await hydrateAuthorizedHistory(pending);
    };
    const synchronizeNow = () => {
      assertActive();
      const current = store.getSyncState();
      return Promise.resolve(client.syncAndAcknowledge({
        ...realtimeOptions.syncArgs, afterCursor: current.cursor, syncEngine,
        onFullResync: async ({ snapshot, acknowledge }) => {
          const applied = syncEngine.applyBootstrap({ ...snapshot, history: [], requireHistoryHydration: true });
          await hydrateAuthorizedHistory((snapshot.conversations || []).map((conversation) => conversation?.id));
          assertActive();
          await acknowledge();
          assertActive();
          return { ...applied, events: [], historyHydrated: true };
        },
        onIncrementalPage: async ({ page, acknowledge }) => {
          const applied = syncEngine.applyPage(page);
          await recoverPendingHistory();
          if (typeof store.listPendingHistoryHydration !== "function") await hydrateAuthorizedHistory(messageConversationIdsFor(page.events));
          assertActive();
          await acknowledge();
          assertActive();
          return { ...applied, events: Array.isArray(page.events) ? page.events : [], historyHydrated: true };
        },
      }))
        .then(async (result) => {
          assertActive();
          if (!result?.historyHydrated) await hydrateAuthorizedHistory(messageConversationIdsFor(result?.events));
          assertActive();
          await outbox?.reconcilePending?.();
          assertActive();
          await outbox?.drainQueued?.();
          assertActive();
          emitState("sync");
          return result;
        });
    };
    // One durable lane covers startup, HTTP polling, realtime hints and
    // cancellation recovery, explicit bootstrap and open-history hydration.
    // It prevents a later empty page from ACKing past
    // an earlier crash/retry hydration checkpoint.
    let syncLane = Promise.resolve();
    const enqueueSync = (operation) => {
      if (stopped) return Promise.resolve(stoppedResult());
      const task = syncLane.catch(() => undefined).then(async () => {
        if (stopped) return stoppedResult();
        return operation();
      }).catch((error) => {
        if (stopped) return stoppedResult();
        throw error;
      });
      syncLane = task.catch(() => undefined);
      return task;
    };
    const synchronize = () => {
      if (stopped) return Promise.resolve(stoppedResult());
      if (!client) return Promise.resolve(unavailableService());
      return enqueueSync(async () => {
        await recoverPendingHistory();
        return synchronizeNow();
      });
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
        if (stopped || typeof listener !== "function") return () => {};
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      getState() {
        if (stopped) return stoppedResult();
        const sync = store.getSyncState();
        return { ok: true, cursor: sync.cursor, watermark: sync.watermark, outbox: store.listOutbox?.() || [] };
      },
      getDirectory() {
        if (stopped) return stoppedResult();
        if (typeof store.getDirectory !== "function") return unavailableService();
        return { ok: true, ...directoryView(store.getDirectory()) };
      },
      list() {
        if (stopped) return stoppedResult();
        if (typeof store.listConversations !== "function") return unavailableService();
        return { ok: true, conversations: store.listConversations() };
      },
      getDraft({ conversationId } = {}) {
        if (stopped) return stoppedResult();
        if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        return { ok: true, text: store.getDraft({ conversationId, draftId: "composer" })?.text || "" };
      },
      readMessages({ conversationId, messageIds } = {}) {
        if (stopped) return stoppedResult();
        if (!Array.isArray(messageIds) || messageIds.length > 200 || messageIds.some((id) => typeof id !== "string" || !id || id.length > 200)) return { ok: false, code: "COLLABORATION_INVALID_INPUT" };
        return enqueueSync(() => {
          if (!store.getConversation({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND" };
          const messages = [], unavailableMessageIds = [];
          for (const messageId of messageIds) {
            const row = store.getMessage({ conversationId, messageId });
            if (row) messages.push(row); else unavailableMessageIds.push(messageId);
          }
          return { ok: true, messages, unavailableMessageIds };
        });
      },
      saveDraft({ conversationId, text } = {}) {
        if (stopped) return stoppedResult();
        if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        store.saveDraft({ conversationId, text });
        return { ok: true };
      },
      async open({ conversationId, beforeSeq } = {}) {
        if (stopped) return stoppedResult();
        if (typeof store.getConversation !== "function" || typeof store.listMessages !== "function") return unavailableService();
        return enqueueSync(async () => {
          const conversation = store.getConversation({ conversationId });
          if (!conversation) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
          try {
            const page = await readHistoryPage({ store, client, deviceId, conversationId, beforeSeq, assertActive });
            assertActive();
            return { ok: true, conversation, ...page };
          } catch (error) {
            assertActive();
            if (!recoverDeniedHistory(conversationId, error)) throw error;
            return { ok: false, code: "COLLAB_ACCESS_REVOKED", retryable: false };
          }
        });
      },
      async bootstrap() {
        if (stopped) return stoppedResult();
        if (!client || !deviceId) return unavailableService();
        return enqueueSync(async () => {
          const snapshot = await client.bootstrap({ deviceId });
          // Raw bootstrap history is encrypted at rest on the server. It never
          // crosses into the desktop projection; authorized history is fetched
          // through the server's decrypting history endpoint below.
          const applied = syncEngine.applyBootstrap({ ...snapshot, history: [], requireHistoryHydration: true });
          await hydrateAuthorizedHistory((snapshot.conversations || []).map((conversation) => conversation?.id));
          assertActive();
          await client.acknowledgeCursor({ deviceId, cursor: applied.cursor, bootstrapCompletionToken: snapshot.bootstrapCompletionToken });
          assertActive();
          emitState("bootstrap");
          return { ok: true, cursor: applied.cursor };
        });
      },
      async send({ conversationId, clientCommandId, bodyText } = {}) {
        if (stopped) return stoppedResult();
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
        if (stopped) return stoppedResult();
        return { ok: true, ...submitted };
      },
      async edit({ conversationId, messageId, clientCommandId, expectedRevision, bodyText } = {}) {
        if (stopped) return stoppedResult();
        if (!client || !deviceId || !store.getMessage?.({ conversationId, messageId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const result = await client.submitMessage({ action: "edit", deviceId, conversationId, messageId, clientCommandId, expectedRevision, bodyText });
        if (stopped) return stoppedResult();
        void synchronizeSafely();
        emitState("message");
        return { ok: true, clientCommandId, state: "confirming", ...(result?.message?.seq ? { seq: result.message.seq } : {}) };
      },
      async revoke({ conversationId, messageId, clientCommandId, expectedRevision } = {}) {
        if (stopped) return stoppedResult();
        if (!client || !deviceId || !store.getMessage?.({ conversationId, messageId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const result = await client.submitMessage({ action: "revoke", deviceId, conversationId, messageId, clientCommandId, expectedRevision });
        if (stopped) return stoppedResult();
        void synchronizeSafely();
        emitState("message");
        return { ok: true, clientCommandId, state: "confirming", ...(result?.message?.seq ? { seq: result.message.seq } : {}) };
      },
      async friend(command = {}) {
        if (stopped) return stoppedResult();
        if (!client || !deviceId || typeof client.submitFriend !== "function") return unavailableService();
        const result = await client.submitFriend({ ...command, deviceId });
        if (stopped) return stoppedResult();
        void synchronizeSafely();
        emitState("relationship");
        return { ok: true, clientCommandId: command.clientCommandId, state: "confirming", ...(result?.status ? { state: String(result.status) } : {}) };
      },
      async retry({ outboxId } = {}) {
        if (stopped) return stoppedResult();
        if (!outbox) return unavailableService();
        const continued = outbox.continue(outboxId);
        const result = continued.state === "queued" ? { ok: true, ...(await outbox.submit(outboxId)) } : { ok: true, ...continued };
        return result;
      },
      async cancel({ outboxId } = {}) {
        if (stopped) return stoppedResult();
        if (!outbox) return unavailableService();
        const result = { ok: true, ...(await outbox.cancel(outboxId)) };
        if (result.requiresSync) void synchronizeSafely();
        return result;
      },
      async markRead({ conversationId, seq } = {}) {
        if (stopped) return stoppedResult();
        if (!client || !deviceId || !Number.isSafeInteger(Number(seq)) || Number(seq) < 0) return unavailableService();
        const result = await client.submitMessage({ action: "read", deviceId, conversationId, seq: Number(seq), clientCommandId: `read:${conversationId}:${Number(seq)}` });
        if (stopped) return stoppedResult();
        emitState("read");
        return { ok: true, conversationId, seq: Number(result?.lastReadSeq ?? seq) };
      },
      start() {
        if (stopped) return stoppedResult();
        if (started) return;
        started = true;
        const recovered = store.recoverAbandonedSubmittingOutbox?.();
        if (recovered?.recovered) emitState("outbox");
        if (stopped) return stoppedResult();
        void Promise.resolve(outbox?.reconcilePending?.()).then(() => outbox?.drainQueued?.()).catch(() => undefined);
        // The serialized synchronize lane first recovers any crash-surviving
        // hydration checkpoint before issuing this initial page or any ACK.
        if (client) void synchronizeSafely();
        if (realtime) realtime.start();
        else if (client && httpPollTimer == null) {
          httpPollTimer = setInterval(() => { void synchronizeSafely(); }, 15_000);
          httpPollTimer.unref?.();
        }
      },
      stop() {
        if (stopped) return;
        // Store operations are synchronous. Fence all async continuations
        // before closing SQLite so a hung network request cannot retain it.
        stopped = true;
        stateListeners.clear();
        try { client?.stop?.(); } finally {
          try { realtime?.stop(); } finally {
            if (httpPollTimer != null) clearInterval(httpPollTimer);
            httpPollTimer = null;
            try { outbox?.stop?.(); } finally { store.close?.(); }
          }
        }
      },
    };
  } catch {
    try { opened.store?.close?.(); } catch { /* isolation boundary */ }
    return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  }
}

module.exports = { createCollaborationService, initializeCollaborationService, unavailableService };
