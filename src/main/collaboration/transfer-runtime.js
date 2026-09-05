"use strict";

const path = require("node:path");
const { validImportCommand, withImportSource } = require("./import-source");
const { createTransferManifestStore } = require("./transfer-manifest");
const { createTransferManager } = require("./transfer-manager");
const { createTransferScheduler } = require("./transfer-scheduler");
const { createQiniuMultipartTransport } = require("./multipart-transport");
const { assertScopeWritable, isConversationRevoked } = require("./access-revocation");
const { saveVerifiedDownload } = require("./save-transfer");
const { retiredTransferIds } = require("./transfer-retirement");
const fail = (code) => Object.assign(new Error(code), { code, retryable: false });
const unavailable = () => ({ ok: false, code: "COLLAB_TRANSFER_UNAVAILABLE", retryable: false });
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
function input(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !id(value[key]))) throw fail("COLLABORATION_INVALID_INPUT");
  return value;
}
function safeError(error) {
  if (error?.code === "EEXIST") return { ok: false, code: "COLLAB_TRANSFER_DESTINATION_EXISTS", retryable: false };
  const code = typeof error?.code === "string" && error.code.length <= 100 && /^(COLLAB[A-Z_]*|LILYENC_[A-Z_]+)$/.test(error.code) ? error.code : "COLLAB_TRANSFER_UNAVAILABLE";
  return { ok: false, code, retryable: error?.retryable === true };
}

/** Main-only assembly. Renderer supplies conversation/message/transfer IDs,
 * never scope, account, object key, DEK or transport implementation. The explicit
 * import command also accepts a native drop path or bounded clipboard image.
 * Failures in this optional module must not disable ordinary collaboration.
 */
function createTransferRuntime({ store, client, deviceId, policy, rootPath, chooseFile, chooseSaveFile, assertActive, onChange, fetchImpl } = {}) {
  if (policy?.enabled !== true || !(policy.attachments === true || policy.workspaceShares === true)) return unavailable();
  try {
    if (!store?.accountId || !client?.objects || !deviceId || typeof assertActive !== "function") return unavailable();
    const accountId = store.accountId;
    const allowed = Object.freeze({ attachment: policy.attachments === true, workspace: policy.workspaceShares === true });
    let stopped = false;
    function active() {
      if (stopped) throw fail("COLLABORATION_STOPPED");
      assertActive();
      if (store.accountId !== accountId) throw fail("COLLAB_ACCOUNT_CHANGED");
    }
    function authorize({ accountId: owner, scopeId, conversationId, purpose, direction, id: transferId }) {
      active();
      if (owner !== undefined && owner !== accountId || allowed[purpose] !== true) throw fail("COLLAB_ACCESS_REVOKED");
      // Coordinator cancellation is durable and must fence every later
      // scheduler/manager authorization, including a restart between writing
      // the coordinator state and best-effort child cleanup.
      if (transferId && claimsIncomplete && direction === "upload") throw fail("COLLAB_ATTACHMENT_INTENT_UNAVAILABLE");
      if (transferId && retiredIds.has(transferId)) throw fail("COLLAB_ACCESS_REVOKED");
      if (transferId && intentForTransfer(transferId)?.status === "cancelled") throw fail("COLLAB_ATTACHMENT_CANCELLED");
      const conversation = store.getConversation({ conversationId });
      if (!conversation || conversation.scopeId !== scopeId || isConversationRevoked(store, conversationId)) throw fail("COLLAB_ACCESS_REVOKED");
      assertScopeWritable(store, scopeId);
      return conversation;
    }
    function conversation(id, purpose) {
      active();
      const row = store.getConversation({ conversationId: id });
      return authorize({ conversationId: id, scopeId: row?.scopeId, purpose });
    }
    const transferRoot = rootPath || require("../config").collaborationTransferRoot();
    const manifests = createTransferManifestStore({ rootPath: transferRoot, accountId, keyring: store.keyring });
    const manager = createTransferManager({ manifests, objectClient: client.objects, deviceId, assertAuthorized: authorize,
      multipart: createQiniuMultipartTransport({ ...(fetchImpl ? { fetchImpl } : {}) }), ...(fetchImpl ? { fetchImpl } : {}) });
    const scheduler = createTransferScheduler({ manager, manifests, onChange });
    let claimsByTransferId = new Map(), claimsIncomplete = false, unrecognizedClaimCount = 0,
      retiredIds = retiredTransferIds({ rootPath: transferRoot, accountId, keyring: store.keyring });
    function refreshClaimIndex() {
      const scan = manifests.scan();
      retiredIds = retiredTransferIds({ rootPath: transferRoot, accountId, keyring: store.keyring });
      const next = new Map();
      for (const item of scan.transfers) {
        if (retiredIds.has(item.id)) continue;
        const intent = item.checkpoint.sendIntent;
        if (!intent) continue;
        for (const transferId of intent.transferIds) {
          if (next.has(transferId)) throw fail("COLLAB_ATTACHMENT_INTENT_INVALID");
          next.set(transferId, intent);
        }
      }
      claimsByTransferId = next;
      const unrecognized = scan.unrecognized.filter((item) => !retiredIds.has(item.entry));
      claimsIncomplete = unrecognized.length > 0;
      unrecognizedClaimCount = unrecognized.length;
      return { ...scan, transfers: scan.transfers.filter((item) => !retiredIds.has(item.id)), unrecognized };
    }
    const perform = async (operation) => { try { active(); return await operation(); } catch (error) { return safeError(error); } };
    const transferAction = (command, action) => perform(() => {
      const { transferId } = input(command, ["transferId"]);
      return scheduler[action](transferId);
    });
    async function verifiedFile(transferId) {
      active();
      const item = manager.list().transfers.find((entry) => entry.id === transferId);
      if (!item || item.direction !== "download" || item.state !== "ready") throw fail("COLLAB_TRANSFER_NOT_READY");
      // Cached plaintext is not a permanent server authorization grant.
      const checked = await manager.resumeDownload(transferId);
      active();
      if (!checked.ok || checked.state !== "ready") throw fail(checked.code || "COLLAB_TRANSFER_NOT_READY");
      return manager.verifiedFile(transferId);
    }
    const immutableIntent = (intent) => ({ coordinatorId: intent?.coordinatorId, clientCommandId: intent?.clientCommandId,
      conversationId: intent?.conversationId, scopeId: intent?.scopeId, purpose: intent?.purpose,
      transferIds: intent?.transferIds, bodyText: intent?.bodyText });
    const sameIntent = (left, right) => JSON.stringify(immutableIntent(left)) === JSON.stringify(immutableIntent(right));
    function intentForTransfer(transferId) {
      return claimsByTransferId.get(transferId) || null;
    }
    function recoveryFailureCount() {
      // The encrypted coordinator is the durable ownership journal.  Count
      // only opaque failures here: renderer learns that recovery needs help,
      // never which path, manifest field, or authorization detail failed.
      const intents = new Map();
      for (const intent of claimsByTransferId.values()) intents.set(intent.coordinatorId, intent);
      let count = unrecognizedClaimCount;
      for (const intent of intents.values()) {
        if (["cancelled", "handed_off"].includes(intent.status)) continue;
        try {
          for (const transferId of intent.transferIds) authorize(manifests.read(transferId));
        } catch (error) {
          // The global unreadable-manifest condition is represented once by
          // unrecognizedClaimCount rather than multiplied for every intent.
          if (error?.code !== "COLLAB_ATTACHMENT_INTENT_UNAVAILABLE") count += 1;
        }
      }
      return count;
    }
    function createSendIntent({ conversationId, transferIds, bodyText, clientCommandId } = {}) {
      active();
      if (!Array.isArray(transferIds) || transferIds.length < 1 || transferIds.length > 20 || new Set(transferIds).size !== transferIds.length || transferIds.some((transferId) => !id(transferId)) || typeof bodyText !== "string" || Buffer.byteLength(bodyText, "utf8") > 32 * 1024) throw fail("COLLABORATION_INVALID_INPUT");
      const items = transferIds.map((transferId) => manifests.read(transferId));
      const first = items[0];
      if (first.direction !== "upload" || first.conversationId !== conversationId || items.some((item) => item.direction !== "upload" || item.conversationId !== conversationId || item.scopeId !== first.scopeId || item.purpose !== first.purpose)) throw fail("COLLAB_ATTACHMENT_SCOPE_MISMATCH");
      authorize(first);
      const commandId = clientCommandId == null ? first.commandIds.send : clientCommandId;
      if (!id(commandId) || (clientCommandId != null && clientCommandId !== first.commandIds.send)) throw fail("IDEMPOTENCY_KEY_REUSED");
      const intent = { coordinatorId: first.id, clientCommandId: commandId, conversationId, scopeId: first.scopeId, purpose: first.purpose, transferIds: [...transferIds], bodyText, status: "waiting_attachments" };
      const scan = refreshClaimIndex();
      const claims = [...new Map(items.map((item) => {
        const claim = intentForTransfer(item.id);
        return [claim?.coordinatorId, claim];
      })).values()].filter(Boolean);
      if (claims.length) {
        if (claims.length === 1 && sameIntent(claims[0], intent)) {
          scheduleInitialPrepared(items);
          return claims[0];
        }
        throw fail("COLLAB_ATTACHMENT_ALREADY_CLAIMED");
      }
      if (scan.unrecognized.length) throw fail("COLLAB_ATTACHMENT_INTENT_UNAVAILABLE");
      // One encrypted coordinator manifest is the durable authority. The
      // linked transfers are referenced by ID and verified afresh at handoff;
      // this avoids pretending N individual manifest writes are atomic.
      manifests.update({ id: first.id, expectedRevision: first.revision, checkpoint: { ...first.checkpoint, sendIntent: intent } });
      refreshClaimIndex();
      // Explicit send is consent to start a newly prepared upload, but never
      // overrides a user pause, retry budget, or failed/active transfer. It
      // only schedules the initial prepared state after the intent is durable.
      scheduleInitialPrepared(items);
      return intent;
    }
    function scheduleInitialPrepared(items) {
      for (const item of items) {
        const current = manifests.read(item.id);
        // Only a missing schedule proves the initial explicit-send enqueue
        // never made it to disk. A disabled schedule is durable user/retry
        // state and must never be reset by restart recovery.
        if (current.checkpoint.state === "prepared" && current.checkpoint.schedule === undefined) scheduler.enqueue(current.id);
      }
    }
    function listSendIntents() {
      active();
      const scan = refreshClaimIndex();
      return scan.transfers
        .filter((item) => {
          const intent = item.checkpoint.sendIntent;
          return intent && item.id === intent.coordinatorId && intent.status !== "cancelled" && intent.status !== "handed_off";
        })
        .map((item) => {
          const intent = item.checkpoint.sendIntent;
          try {
            scheduleInitialPrepared(intent.transferIds.map((transferId) => manifests.read(transferId)));
            return intent;
          } catch (error) {
            if (["COLLABORATION_STOPPED", "COLLAB_ACCOUNT_CHANGED"].includes(error?.code)) throw error;
            return { ...intent, recoveryError: String(error?.code || "COLLAB_ATTACHMENT_INTENT_UNAVAILABLE") };
          }
        });
    }
    function handoffIntent(rawIntent) {
      active();
      const items = rawIntent.transferIds.map((transferId) => manifests.read(transferId));
      const intent = items[0]?.checkpoint.sendIntent;
      if (!intent || intent.coordinatorId !== items[0].id || !sameIntent(intent, rawIntent)) throw fail("COLLAB_ATTACHMENT_INTENT_INVALID");
      if (intent.status === "cancelled") throw fail("COLLAB_ATTACHMENT_CANCELLED");
      for (const item of items) { authorize(item); if (!["verified", "bound"].includes(item.checkpoint.state) || !item.checkpoint.objectId || item.checkpoint.deviceId !== deviceId) return intent; }
      const ready = { ...intent, attachmentIds: items.map((item) => item.checkpoint.objectId), state: "ready_to_handoff" };
      manifests.update({ id: items[0].id, expectedRevision: items[0].revision, checkpoint: { ...items[0].checkpoint, sendIntent: { ...intent, status: "ready_to_handoff" } } });
      refreshClaimIndex();
      return ready;
    }
    function completeHandoff(rawIntent) {
      active();
      const coordinator = manifests.read(rawIntent.coordinatorId);
      const intent = coordinator.checkpoint.sendIntent;
      if (!intent || !sameIntent(intent, rawIntent)) throw fail("COLLAB_ATTACHMENT_INTENT_INVALID");
      if (intent.status !== "handed_off") {
        manifests.update({ id: coordinator.id, expectedRevision: coordinator.revision, checkpoint: { ...coordinator.checkpoint, sendIntent: { ...intent, status: "handed_off" } } });
        refreshClaimIndex();
      }
      return { ok: true };
    }
    return Object.freeze({
      ok: true,
      start() { if (!stopped) { refreshClaimIndex(); scheduler.start(); } },
      stop() { stopped = true; scheduler.stop(); },
      list() {
        if (stopped) return { ok: false, code: "COLLABORATION_STOPPED", transfers: [] };
        try {
          active(); refreshClaimIndex(); const recoveryFailures = recoveryFailureCount(); const result = scheduler.list();
          return { ok: true, ...result, unrecognizedCount: unrecognizedClaimCount, recoveryFailureCount: recoveryFailures, transfers: result.transfers.map((view) => {
            const intent = intentForTransfer(view.id);
            if (!intent) return view;
            const outbox = store.getOutbox?.({ outboxId: intent.clientCommandId });
            const sendState = outbox?.state || intent.status;
            return { ...view, sendState, clientCommandId: intent.clientCommandId };
          }) };
        }
        catch (error) { return { ...safeError(error), transfers: [] }; }
      },
      importAttachment(command) { return perform(async () => {
        if (!validImportCommand(command)) throw fail("COLLABORATION_INVALID_INPUT");
        const { conversationId, source } = command;
        const target = conversation(conversationId, "attachment");
        return withImportSource(source, path.join(rootPath, "imports"), (file) => {
          authorize({ conversationId, scopeId: target.scopeId, purpose: "attachment" });
          return manager.prepareUpload({ ...file, conversationId, scopeId: target.scopeId, purpose: "attachment" });
        });
      }); },
      prepareAttachment(command) { return perform(async () => {
        const { conversationId } = input(command, ["conversationId"]);
        const selectedConversation = conversation(conversationId, "attachment");
        if (typeof chooseFile !== "function") return unavailable();
        const selection = await chooseFile();
        authorize({ conversationId, scopeId: selectedConversation.scopeId, purpose: "attachment" });
        if (selection?.canceled === true) return { ok: true, cancelled: true };
        if (!Array.isArray(selection?.filePaths) || selection.filePaths.length !== 1 || typeof selection.filePaths[0] !== "string" || !path.isAbsolute(selection.filePaths[0])) return unavailable();
        return manager.prepareUpload({ conversationId, scopeId: selectedConversation.scopeId, purpose: "attachment", inputPath: selection.filePaths[0] });
      }); },
      prepareDownload(command) { return perform(() => {
        const { conversationId, messageId, objectId } = input(command, ["conversationId", "messageId", "objectId"]);
        const message = store.getMessage({ conversationId, messageId });
        if (!message || message.revokedAt || !message.attachmentIds?.includes(objectId)) throw fail("COLLAB_OBJECT_UNAVAILABLE");
        const purpose = message.kind === "workspace_share" ? "workspace" : "attachment";
        const target = conversation(conversationId, purpose);
        const existing = manager.list().transfers.find((item) => item.direction === "download" && item.conversationId === conversationId
          && item.objectId === objectId && item.purpose === purpose && item.state !== "cancelled");
        if (existing) return existing;
        return manager.prepareDownload({ objectId, conversationId, scopeId: target.scopeId, purpose });
      }); },
      enqueue: (command) => transferAction(command, "enqueue"),
      pause: (command) => transferAction(command, "pause"),
      cancel(command) { return perform(async () => {
        const { transferId } = input(command, ["transferId"]); refreshClaimIndex(); manifests.read(transferId); const intent = intentForTransfer(transferId);
        if (intent?.status === "handed_off" || intent?.status === "ready_to_handoff") return { ok: false, code: "COLLAB_MESSAGE_CANCELLATION_REQUIRED" };
        if (intent?.status === "waiting_attachments") {
          const coordinator = manifests.read(intent.coordinatorId);
          if (!sameIntent(coordinator.checkpoint.sendIntent, intent)) throw fail("COLLAB_ATTACHMENT_INTENT_INVALID");
          manifests.update({ id: coordinator.id, expectedRevision: coordinator.revision, checkpoint: { ...coordinator.checkpoint, sendIntent: { ...intent, status: "cancelled" } } });
          refreshClaimIndex();
          // The coordinator fence above is authoritative. Child manifests are
          // intentionally not treated as one atomic transaction; a crash at
          // any point leaves their stale schedule harmless and non-dispatchable.
          for (const linkedId of intent.transferIds) {
            const linked = manifests.read(linkedId);
            if (["verified", "bound", "ready", "cancelled"].includes(linked.checkpoint.state)) continue;
            manifests.update({ id: linked.id, expectedRevision: linked.revision, checkpoint: { ...linked.checkpoint, state: "cancelled",
              schedule: { ...(linked.checkpoint.schedule || { attempts: 0, nextAttemptAt: 0 }), enabled: false } } });
          }
          return { ok: true, id: transferId, state: "cancelled" };
        }
        return scheduler.cancel(transferId);
      }); },
      saveDownload(command) { return perform(async () => {
        const { transferId } = input(command, ["transferId"]);
        const item = manifests.read(transferId); authorize(item);
        if (item.direction !== "download" || item.checkpoint.state !== "ready" || !item.checkpoint.plaintext) throw fail("COLLAB_TRANSFER_NOT_READY");
        if (typeof chooseSaveFile !== "function") return unavailable();
        const chosen = await chooseSaveFile({ defaultName: item.checkpoint.plaintext.originalName });
        authorize(item);
        if (chosen?.canceled === true) return { ok: true, cancelled: true };
        const sourcePath = await verifiedFile(transferId);
        return saveVerifiedDownload({ sourcePath, destinationPath: chosen?.filePath,
          expectedSize: item.checkpoint.plaintext.size, expectedSha256: item.checkpoint.plaintext.sha256,
          assertAuthorized: () => authorize(item), beforePublish: () => verifiedFile(transferId) });
      }); },
      previewDownload(command) { return perform(() => {
        const { transferId } = input(command, ["transferId"]);
        const result = manager.plaintextFile(transferId);
        if (result?.ok !== true) throw fail("COLLAB_TRANSFER_NOT_READY");
        return result;
      }); },
      // Main-process save/import brokers only. Never expose this through IPC.
      verifiedFile,
      // Private coordinator capability; service uses it to hand off into the
      // ordinary text outbox. It is intentionally absent from IPC/preload.
      createSendIntent, listSendIntents, handoffIntent, completeHandoff,
    });
  } catch { return unavailable(); }
}

module.exports = { createTransferRuntime };
