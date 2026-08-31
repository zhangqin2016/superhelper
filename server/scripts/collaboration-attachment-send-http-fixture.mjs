import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../../src/main/collaboration/collaboration-store");
const { createCollaborationService } = require("../../src/main/collaboration/service");

/** Native selection is a test picker; the actual account service, encrypted
 * journals, scheduler, outbox, signed HTTP, PostgreSQL and receiver save run.
 * The surrounding fixture supplies only its fake private storage provider.
 */
export async function verifyAttachmentServiceHttp({ desktop, directory, source, fetchImpl, conversationId, pool, dropAck }) {
  const services = [];
  const saved = path.join(directory, "received-through-service.txt");
  function open(userId) {
    const account = desktop(userId);
    const store = new CollaborationStore({ dbPath: path.join(directory, `${userId}-service.db`), accountId: userId, keyring: account.keyring });
    if (!store.listConversations().length) store.replaceProjectionFromBootstrap({ conversations: [{ id: conversationId, scopeId: "team:org", kind: "channel" }] });
    const { client, deviceId } = account;
    const service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId,
      policy: { enabled: true, attachments: true }, realtimeEnabled: false,
      transferOptions: { rootPath: path.join(directory, "collaboration-transfer"), fetchImpl,
        chooseFile: async () => ({ canceled: false, filePaths: [source] }), chooseSaveFile: async () => ({ canceled: false, filePath: saved }) },
      transport: {
        submit: (item) => client.submitMessage({ action: "send", deviceId, conversationId: item.conversationId, clientCommandId: item.clientCommandId,
          bodyText: item.bodyText, ...(item.attachmentIds?.length ? { attachmentIds: item.attachmentIds, attachmentPurpose: item.attachmentPurpose } : {}) }),
        lookupReceipt: ({ clientCommandId, conversationId }) => client.lookupCommandReceipt({ deviceId, clientCommandId, conversationId }),
      },
    });
    assert.equal(service.ok, true); services.push(service); return service;
  }
  async function until(predicate, description) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 20)); }
    assert.fail(`Timed out: ${description}`);
  }
  try {
    let sender = open("a");
    const first = await sender.prepareAttachment({ conversationId }), second = await sender.prepareAttachment({ conversationId });
    assert.equal(first.state, "prepared"); assert.equal(second.state, "prepared");
    assert.equal(sender.store.listOutbox().length, 0, "selection alone cannot send a message");
    dropAck("/api/collaboration/v1/messages");
    const input = { conversationId, transferIds: [first.id, second.id], bodyText: "service attachment delivery" };
    const waiting = await sender.sendAttachments(input);
    assert.equal(waiting.state, "waiting_attachments"); assert.ok(waiting.clientCommandId);
    assert.equal(sender.store.listOutbox().length, 0, "unverified attachment intent is outside the text dispatch lane");
    await until(async () => (await pool.query("select count(*)::int n from command_receipts where client_command_id=$1", [waiting.clientCommandId])).rows[0].n === 1,
      "explicit send uploads both files and commits one message without a separate resume click");
    sender.stop(); sender = open("a"); sender.start();
    await until(() => sender.store.getOutbox({ outboxId: waiting.clientCommandId })?.state === "persisted", "restart resolves the original dropped message ACK");
    const original = sender.store.getOutbox({ outboxId: waiting.clientCommandId });
    assert.equal(original.attachmentIds.length, 2);
    const repeated = await sender.sendAttachments(input);
    assert.equal(repeated.clientCommandId, waiting.clientCommandId);
    assert.equal((await pool.query("select count(*)::int n from command_receipts where client_command_id=$1", [waiting.clientCommandId])).rows[0].n, 1);
    const receiver = open("b");
    const history = await receiver.open({ conversationId }); assert.equal(history.ok, true);
    const message = history.messages.find((row) => row.bodyText === input.bodyText);
    assert.ok(message); assert.deepEqual(message.attachmentIds, original.attachmentIds);
    assert.equal((await pool.query("select count(*)::int n from message_attachments where message_id=$1", [message.id])).rows[0].n, 2);
    const incoming = await receiver.prepareDownload({ conversationId, messageId: message.id, objectId: message.attachmentIds[0] });
    assert.equal(incoming.ok, true); await receiver.enqueueTransfer({ transferId: incoming.id });
    await until(() => receiver.getTransfers().transfers?.find((row) => row.id === incoming.id)?.state === "ready", "receiver completes authenticated download");
    assert.equal((await receiver.saveDownload({ transferId: incoming.id })).saved, true);
    assert.deepEqual(fs.readFileSync(saved), fs.readFileSync(source));
    console.log("attachment service HTTP: two-file waiting -> durable outbox -> dropped ACK/restart -> one PG message -> receiver native save passed (fake storage only)");
  } finally { for (const service of services) service.stop(); }
}
