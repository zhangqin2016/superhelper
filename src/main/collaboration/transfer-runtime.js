"use strict";

const path = require("node:path");
const { createTransferManifestStore } = require("./transfer-manifest");
const { createTransferManager } = require("./transfer-manager");
const { createTransferScheduler } = require("./transfer-scheduler");
const { createQiniuMultipartTransport } = require("./multipart-transport");
const { assertScopeWritable, isConversationRevoked } = require("./access-revocation");
const { saveVerifiedDownload } = require("./save-transfer");
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
 * never a path, scope, account, object key, DEK or transport implementation.
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
    function authorize({ accountId: owner, scopeId, conversationId, purpose }) {
      active();
      if (owner !== undefined && owner !== accountId || allowed[purpose] !== true) throw fail("COLLAB_ACCESS_REVOKED");
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
    const manifests = createTransferManifestStore({ rootPath: rootPath || require("../config").userDataPath("collaboration-transfer"), accountId, keyring: store.keyring });
    const manager = createTransferManager({ manifests, objectClient: client.objects, deviceId, assertAuthorized: authorize,
      multipart: createQiniuMultipartTransport({ ...(fetchImpl ? { fetchImpl } : {}) }), ...(fetchImpl ? { fetchImpl } : {}) });
    const scheduler = createTransferScheduler({ manager, manifests, onChange });
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
    return Object.freeze({
      ok: true,
      start() { if (!stopped) scheduler.start(); },
      stop() { stopped = true; scheduler.stop(); },
      list() {
        if (stopped) return { ok: false, code: "COLLABORATION_STOPPED", transfers: [] };
        try { active(); return { ok: true, ...scheduler.list() }; }
        catch (error) { return { ...safeError(error), transfers: [] }; }
      },
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
      cancel: (command) => transferAction(command, "cancel"),
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
      // Main-process save/import brokers only. Never expose this through IPC.
      verifiedFile,
    });
  } catch { return unavailable(); }
}

module.exports = { createTransferRuntime };
