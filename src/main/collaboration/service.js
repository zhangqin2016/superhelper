"use strict";

const { openCollaborationStore } = require("./collaboration-store");
const { createCollaborationSyncEngine } = require("./sync-engine");
const { createCollaborationOutbox } = require("./outbox");
const { createCollaborationRealtimeClient } = require("./realtime-client");
const { createEphemeralPresence, createTypingCommand } = require("./ephemeral-presence");
const { createReactionCommand } = require("./reaction-command");
const { readHistoryPage } = require("./history-page");
const { hydratePendingConversation } = require("./history-hydration");
const { isConversationRevoked, recoverAccessDenial } = require("./access-revocation");
const { recoverConversationHydration, assertHydrationComplete } = require("./conversation-hydration");
const { directoryView } = require("./directory-view");
const { createSocialCommands } = require("./social-commands");
const socialDirectory = require("./social-directory-actions");
const { createMentionCandidateCache } = require("./mention-candidate-cache");
const { createTransferRuntime } = require("./transfer-runtime");
const { createAttachmentSendCoordinator } = require("./attachment-send");
const { createReadRecovery } = require("./read-recovery");
const { createFriendLookup, createDirectoryReads } = require("./friend-lookup");
const { messageMetadata, messageIdentifier, validateCreateBody, sameCreateIntent } = require("./message-intent");
const { validOperationRequest } = require("./message-operation-view");
const { createEditDraftService } = require("./edit-draft-service");

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
function createCollaborationService({ openStore = openCollaborationStore, storeOptions, client, transport, deviceId = "", realtimeEnabled = true, realtimeOptions = {}, policy, transferOptions = {}, mentionCandidateClock } = {}) {
  const opened = openStore(storeOptions);
  if (!opened?.ok) return { ok: false, code: "COLLABORATION_UNAVAILABLE" };
  try {
    const store = opened.store;
    const candidateCache = createMentionCandidateCache({ store, now: mentionCandidateClock });
    // Direct/test assembly may inject an already-open cache.  Keep the
    // revocation hook and runtime on one root before any service lifecycle
    // recovery; Electron production supplies this before store construction.
    if (!store.transferRoot && transferOptions.rootPath) store.transferRoot = transferOptions.rootPath;
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
    const presence = createEphemeralPresence();
    const reactionCommand = createReactionCommand({
      store, deviceId, getOutbox: () => outbox, isStopped: () => stopped, stoppedResult,
      onChanged: () => emitState("message"),
    });
    const typingCommand = createTypingCommand({ store, getRealtime: () => realtime, isStopped: () => stopped, stoppedResult });
    const engine = createCollaborationSyncEngine({ store });
    let attachmentSend = null;
    const transfers = createTransferRuntime({ ...transferOptions, store, client, deviceId, policy, assertActive, onChange: () => { emitState("transfer"); void attachmentSend?.recover?.().catch(() => undefined); } });
    const transferCommand = (method, payload) => stopped ? stoppedResult() : transfers.ok ? transfers[method](payload) : unavailableService();
    const syncEngine = {
      applyPage(page) {
        assertActive();
        candidateCache.clear();
        try { return engine.applyPage(page); } finally {
          if (page.events?.some((event) => ["scope.revoked", "member.removed", "member.left"].includes(event.type)) && store.getSyncState().cursor >= page.toCursor) emitState("access-revoked");
        }
      },
      applyBootstrap(snapshot) {
        assertActive();
        candidateCache.clear();
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
    const reads = createReadRecovery({ store, client, deviceId, assertActive, recoverDeniedHistory, onChange: () => emitState("read") });
    const recoverReadsSafely = () => reads.recover().catch(() => undefined);
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
    const outbox = transport ? createCollaborationOutbox({ store, transport, deviceId, onStateChange: () => emitState("outbox") }) : null;
    if (transfers.ok && outbox) attachmentSend = createAttachmentSendCoordinator({ store, transfers, outbox, deviceId: deviceId || null, assertActive, onChange: () => emitState("attachment-send") });
    const messageConversationIdsFor = (events) => (events || [])
      .filter((event) => String(event?.type || "").startsWith("message."))
      .map((event) => event?.conversationId ?? event?.conversation_id);
    const recoverPendingHistory = async () => {
      assertActive();
      store.flushRevokedKeys?.();
      // The account event itself is the durable refresh checkpoint. Bootstrap
      // removes it atomically with the authoritative directory replacement.
      // A failed request/restart therefore cannot ACK past a stale roster.
      if (store.db?.get(`SELECT 1 FROM events WHERE account_id = ? AND type = 'directory.changed' LIMIT 1`, store.accountId)) {
        return bootstrapNow();
      }
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
          await recoverConversationHydration({ store, client, deviceId, assertActive, recoverDeniedHistory });
          await hydrateAuthorizedHistory((snapshot.conversations || []).map((conversation) => conversation?.id));
          assertActive();
          assertHydrationComplete(store);
          await acknowledge();
          assertActive();
          return { ...applied, events: [], historyHydrated: true };
        },
        onIncrementalPage: async ({ page, acknowledge }) => {
          const applied = syncEngine.applyPage(page);
          const refreshed = await recoverPendingHistory();
          if (refreshed) return { ...refreshed, events: page.events || [], historyHydrated: true };
          if (typeof store.listPendingHistoryHydration !== "function") await hydrateAuthorizedHistory(messageConversationIdsFor(page.events));
          assertActive();
          assertHydrationComplete(store);
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
          void recoverReadsSafely();
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
    const bootstrapNow = async () => {
      const snapshot = await client.bootstrap({ deviceId });
      assertActive();
      if (Number(snapshot.watermark) < store.getSyncState().cursor) throw Object.assign(new Error("Stale collaboration directory snapshot"), { code: "COLLAB_BOOTSTRAP_STALE" });
      const applied = syncEngine.applyBootstrap({ ...snapshot, history: [], requireHistoryHydration: true });
      await recoverConversationHydration({ store, client, deviceId, assertActive, recoverDeniedHistory });
      await hydrateAuthorizedHistory((snapshot.conversations || []).map((conversation) => conversation?.id));
      assertActive();
      assertHydrationComplete(store);
      await client.acknowledgeCursor({ deviceId, cursor: applied.cursor, bootstrapCompletionToken: snapshot.bootstrapCompletionToken });
      assertActive(); emitState("bootstrap");
      return { ok: true, cursor: applied.cursor };
    };
    const bootstrap = () => enqueueSync(bootstrapNow);
    const social = createSocialCommands({ store, client, deviceId, assertActive,
      onChange: () => emitState("relationship"),
      onConfirmed: async () => {
        // A replay may return an existing relationship/conversation without a
        // new event. Refresh its authorized snapshot, not an invented local row.
        if (client?.bootstrap && client?.acknowledgeCursor) await bootstrap();
        else if (client?.syncAndAcknowledge) await synchronize();
      },
    });
    const realtime = client && realtimeEnabled
      ? createCollaborationRealtimeClient({
        ...realtimeOptions,
        onReconnect: () => outbox?.drainQueued?.(),
        // Typing is a hint, so it only reaches the UI when the live set actually
        // changes — a peer re-sending every keystroke must not re-render.
        onEphemeral: (frame) => { if (presence.note(frame)) emitState("typing"); },
        sync: synchronize,
      })
      : null;
    return {
      ok: true, store, syncEngine, outbox, realtime,
      getTransfers() { return transferCommand("list"); },
      prepareAttachment(command) { return transferCommand("prepareAttachment", command); },
      enqueueTransfer(command) { return transferCommand("enqueue", command); },
      pauseTransfer(command) { return transferCommand("pause", command); },
      cancelTransfer(command) { return transferCommand("cancel", command); },
      prepareDownload(command) { return transferCommand("prepareDownload", command); },
      saveDownload(command) { return transferCommand("saveDownload", command); },
      resolveTransferPreview(command) { return transferCommand("previewDownload", command); },
      sendAttachments(command) { return stopped ? stoppedResult() : attachmentSend ? attachmentSend.sendAttachments(command) : unavailableService(); },
      subscribe(listener) {
        if (stopped || typeof listener !== "function") return () => {};
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      getState() {
        if (stopped) return stoppedResult();
        const sync = store.getSyncState();
        return { ok: true, cursor: sync.cursor, watermark: sync.watermark, outbox: store.listOutbox?.() || [],
          typing: presence.snapshot() };
      },
      typing: typingCommand,
      ...createDirectoryReads({ store, socialDirectory, directoryView, isStopped: () => stopped, stoppedResult, unavailableService }),
      openFriend(command) { return stopped ? stoppedResult() : socialDirectory.openFriend(store, command); },
      lookupFriend: createFriendLookup({ client, deviceId, assertActive, isStopped: () => stopped, stoppedResult, unavailableService }),
      getConversationDetails({ conversationId } = {}) {
        return enqueueSync(() => socialDirectory.getConversationDetails({ store, client, deviceId, conversationId, assertActive, recoverDeniedHistory, candidateCache }));
      },
      getMentionCandidates({ conversationId } = {}) {
        return enqueueSync(() => socialDirectory.getMentionCandidates({ store, client, deviceId, conversationId, assertActive, recoverDeniedHistory, candidateCache }));
      },
      getDraft({ conversationId } = {}) {
        if (stopped) return stoppedResult();
        if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const draft = store.getDraft({ conversationId, draftId: "composer" });
        return { ok: true, text: draft?.text || "", ...messageMetadata(draft || {}) };
      },
      ...createEditDraftService({ store, enqueueSync, assertActive, isStopped: () => stopped, stoppedResult }),
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
      readMessageOperations(input = {}) {
        if (stopped) return stoppedResult();
        const request = validOperationRequest(input);
        if (!request) return { ok: false, code: "COLLABORATION_INVALID_INPUT" };
        const accountId = store.accountId;
        return enqueueSync(() => {
          const accessFailure = () => {
            assertActive();
            if (store.accountId !== accountId) return { ok: false, code: "COLLAB_ACCOUNT_CHANGED" };
            if (isConversationRevoked(store, request.conversationId)) return { ok: false, code: "COLLAB_ACCESS_REVOKED" };
            if (!store.getConversation?.({ conversationId: request.conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND" };
            return null;
          };
          const beforeRead = accessFailure();
          if (beforeRead) return beforeRead;
          const result = store.readMessageOperations({ ...request, deviceId });
          return accessFailure() || result;
        });
      },
      saveDraft({ conversationId, text, replyToMessageId, mentionUserIds } = {}) {
        if (stopped) return stoppedResult();
        if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        store.saveDraft({ conversationId, text, replyToMessageId, mentionUserIds });
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
        return bootstrap();
      },
      async send({ conversationId, clientCommandId, bodyText, replyToMessageId, mentionUserIds } = {}) {
        if (stopped) return stoppedResult();
        if (!outbox || typeof store.getConversation !== "function") return unavailableService();
        let metadata;
        try { metadata = messageMetadata({ replyToMessageId, mentionUserIds }); validateCreateBody(bodyText);
          if (!messageIdentifier(conversationId) || !messageIdentifier(clientCommandId)) throw new Error("invalid id");
        } catch { return { ok: false, code: "COLLABORATION_INVALID_INPUT", retryable: false }; }
        const existing = store.getOutbox?.({ outboxId: clientCommandId });
        if (existing) {
          if (!sameCreateIntent(existing, { conversationId, bodyText, ...metadata })) return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", retryable: false };
          return { ok: true, state: existing.state, clientCommandId: existing.clientCommandId };
        }
        const conversation = store.getConversation({ conversationId });
        if (!conversation) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        if (!deviceId) return { ok: false, code: "COLLAB_OUTBOX_DEVICE_REQUIRED", retryable: false };
        const messageId = `optimistic:${clientCommandId}`;
        const persisted = store.persistDraftAndOptimisticMessage({
          conversationId, draftId: "composer", draftText: "", messageId, clientCommandId, bodyText, ...metadata, scopeId: conversation.scopeId,
          ...(deviceId ? { originDeviceId: deviceId } : {}),
        });
        const submitted = await outbox.submit(persisted.outboxId);
        if (stopped) return stoppedResult();
        return { ok: true, ...submitted };
      },
      async edit({ conversationId, messageId, clientCommandId, expectedRevision, bodyText } = {}) {
        if (stopped) return stoppedResult();
        if (!outbox || !store.getMessage?.({ conversationId, messageId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const existing = store.getOutbox?.({ outboxId: clientCommandId });
        if (existing) {
          if (existing.commandType !== "message.edit" || existing.conversationId !== conversationId || existing.messageId !== messageId
            || existing.expectedRevision !== Number(expectedRevision) || existing.bodyText !== String(bodyText ?? "")) return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", retryable: false };
          return { ok: true, state: existing.state, clientCommandId: existing.clientCommandId };
        }
        const conversation = store.getConversation?.({ conversationId });
        if (!conversation) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const persisted = store.persistMessageMutation({ commandType: "message.edit", conversationId, messageId, clientCommandId, expectedRevision, bodyText,
          ...(deviceId ? { originDeviceId: deviceId } : {}) });
        const result = await outbox.submit(persisted.outboxId);
        if (stopped) return stoppedResult();
        emitState("message");
        return { ok: true, ...result };
      },
      async revoke({ conversationId, messageId, clientCommandId, expectedRevision } = {}) {
        if (stopped) return stoppedResult();
        if (!outbox || !store.getMessage?.({ conversationId, messageId })) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const existing = store.getOutbox?.({ outboxId: clientCommandId });
        if (existing) {
          if (existing.commandType !== "message.revoke" || existing.conversationId !== conversationId || existing.messageId !== messageId
            || existing.expectedRevision !== Number(expectedRevision)) return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", retryable: false };
          return { ok: true, state: existing.state, clientCommandId: existing.clientCommandId };
        }
        const conversation = store.getConversation?.({ conversationId });
        if (!conversation) return { ok: false, code: "COLLABORATION_NOT_FOUND", retryable: false };
        const persisted = store.persistMessageMutation({ commandType: "message.revoke", conversationId, messageId, clientCommandId, expectedRevision,
          ...(deviceId ? { originDeviceId: deviceId } : {}) });
        const result = await outbox.submit(persisted.outboxId);
        if (stopped) return stoppedResult();
        emitState("message");
        return { ok: true, ...result };
      },
      react: reactionCommand,
      async friend(command = {}) {
        if (stopped) return stoppedResult();
        if (!client || !deviceId || typeof client.submitFriend !== "function") return unavailableService();
        try { return await social.submit("friend", command); } catch (error) { if (stopped) return stoppedResult(); throw error; }
      },
      async conversation(command = {}) {
        if (stopped) return stoppedResult();
        if (!client?.submitConversation || !deviceId) return unavailableService();
        try { return await social.submit("conversation", command); } catch (error) { if (stopped) return stoppedResult(); throw error; }
      },
      getSocialCommands() { return stopped ? stoppedResult() : social.list(); },
      async retrySocial(command) {
        if (stopped) return stoppedResult();
        try { return await social.retry(command); } catch (error) { if (stopped) return stoppedResult(); throw error; }
      },
      async retry({ outboxId } = {}) {
        if (stopped) return stoppedResult();
        if (!outbox) return unavailableService();
        const continued = await outbox.continue(outboxId);
        if (stopped) return stoppedResult();
        const result = continued.state === "queued" ? { ok: true, ...(await outbox.submit(outboxId)) } : { ok: true, ...continued };
        if (stopped) return stoppedResult();
        return result;
      },
      async cancel({ outboxId } = {}) {
        if (stopped) return stoppedResult();
        if (!outbox) return unavailableService();
        const result = { ok: true, ...(await outbox.cancel(outboxId)) };
        if (stopped) return stoppedResult();
        if (result.state === "cancelled") await outbox.drainQueued();
        if (stopped) return stoppedResult();
        if (result.requiresSync) void synchronizeSafely();
        return result;
      },
      async skip({ outboxId } = {}) {
        if (stopped) return stoppedResult();
        if (!outbox) return unavailableService();
        const result = { ok: true, ...(await outbox.skip(outboxId)) };
        if (stopped) return stoppedResult();
        if (result.state === "cancelled") await outbox.drainQueued();
        if (stopped) return stoppedResult();
        return result;
      },
      async markRead({ conversationId, seq } = {}) {
        if (stopped) return stoppedResult();
        try { const result = await reads.markRead({ conversationId, seq }); return stopped ? stoppedResult() : result; } catch (error) { if (stopped) return stoppedResult(); throw error; }
      },
      start() {
        if (stopped) return stoppedResult();
        if (started) return;
        started = true;
        void recoverReadsSafely();
        transfers.start?.();
        void attachmentSend?.recover?.().catch(() => undefined);
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
        candidateCache.clear();
        // Typing hints are per-session state: a stopped panel must show nobody
        // typing rather than whoever was typing when it closed.
        presence.forget();
        stateListeners.clear();
        try { transfers.stop?.(); } catch { /* optional transfer cleanup cannot retain SQLite */ }
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
