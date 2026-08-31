#!/usr/bin/env node

import assert from "node:assert/strict";

const {
  createCollaborationMessageService,
  createHmacMessageBodyIntentSigner,
  MAX_MESSAGE_BODY_BYTES,
  applyMessageActivityProjection,
} = await import("../server/src/services/collaboration/messages.js");
const { createCollaborationMessageCrypto } = await import("../server/src/services/collaboration/message-crypto.js");
const { runCollaborationCommand } = await import("../server/src/services/collaboration/command-runner.js");

function createHarness({ now = () => new Date("2026-08-29T12:00:00.000Z"), bodyIntentSigner: providedBodyIntentSigner, useTask4Kernel = false } = {}) {
  const state = {
    messages: new Map(),
    revisions: [],
    reads: new Map(),
    commandReceipts: new Map(),
    commandInputs: [],
    nextSeq: 1,
  };
  const baseMessageCrypto = createCollaborationMessageCrypto({
    currentKekVersion: 1,
    kekByVersion: { 1: Buffer.alloc(32, 9) },
  });
  const cryptoCalls = { decrypt: 0 };
  const messageCrypto = {
    encrypt: baseMessageCrypto.encrypt,
    decrypt(args) {
      cryptoCalls.decrypt += 1;
      return baseMessageCrypto.decrypt(args);
    },
  };
  const activeMemberIds = ["user-a", "user-b", "user-c"];
  const attachments = new Map([
    ["object-ready", { id: "object-ready", state: "verified", ownerUserId: "user-a" }],
    ["object-pending", { id: "object-pending", state: "uploading", ownerUserId: "user-a" }],
  ]);
  const repository = {
    async findReplyTarget(_trx, { conversationId, replyToMessageId }) {
      const message = state.messages.get(replyToMessageId);
      return message && message.conversationId === conversationId ? structuredClone(message) : null;
    },
    async findAttachments(_trx, { attachmentIds }) {
      return attachmentIds.map((id) => attachments.get(id)).filter(Boolean).map((attachment) => structuredClone(attachment));
    },
    async activeConversationMemberIds() {
      return [...activeMemberIds];
    },
    async insertMessage(_trx, message) {
      state.messages.set(message.id, structuredClone(message));
    },
    async findMessageForUpdate(_trx, { conversationId, messageId }) {
      const message = state.messages.get(messageId);
      return message && message.conversationId === conversationId ? structuredClone(message) : null;
    },
    async compareAndSwapMessage(_trx, { messageId, expectedRevision, patch }) {
      const current = state.messages.get(messageId);
      if (!current || current.revision !== expectedRevision) return null;
      const next = { ...current, ...structuredClone(patch), revision: current.revision + 1 };
      state.messages.set(messageId, next);
      return structuredClone(next);
    },
    async insertMessageRevision(_trx, revision) {
      state.revisions.push(structuredClone(revision));
    },
    async advanceLastReadSeq(_trx, { conversationId, userId, submittedSeq }) {
      const key = `${conversationId}:${userId}`;
      const previous = state.reads.get(key) || 0;
      const lastReadSeq = Math.max(previous, submittedSeq);
      state.reads.set(key, lastReadSeq);
      return { lastReadSeq };
    },
    async listHistory(_trx, args) {
      const values = [...state.messages.values()]
        .filter((message) => message.conversationId === args.conversationId)
        .filter((message) => args.messageIds == null || args.messageIds.includes(message.id))
        .filter((message) => args.beforeSeq == null || message.createSeq < args.beforeSeq)
        .filter((message) => message.createSeq > args.visibleAfterSeq)
        .sort((left, right) => right.createSeq - left.createSeq);
      return values.slice(0, args.limit).map((message) => ({
        ...structuredClone(message),
        accessToken: "must-not-leave-message-repository",
        wrappedDek: "must-not-leave-message-repository",
        localPath: "/private/local-only",
      }));
    },
  };
  const fakeCommandRunner = async (command) => {
    state.commandInputs.push(structuredClone(command.input));
    const receiptKey = `${command.account.deviceId}:${command.commandType}:${command.clientCommandId}`;
    const prior = state.commandReceipts.get(receiptKey);
    const authorization = await command.authorize({ trx: {}, account: command.account, input: command.input });
    if (!authorization?.ok) {
      const error = new Error(authorization?.code || "COLLAB_AUTHORIZATION_DENIED");
      error.code = authorization?.code || "COLLAB_AUTHORIZATION_DENIED";
      throw error;
    }
    const effectiveInput = typeof command.resolveInput === "function"
      ? await command.resolveInput({ trx: {}, account: command.account, input: command.input, receipt: prior, commandType: command.commandType })
      : command.input;
    const fingerprint = JSON.stringify(effectiveInput);
    if (prior) {
      assert.equal(prior.fingerprint, fingerprint, "a command id may only replay an identical message intent");
      return structuredClone(prior.response);
    }
    const plan = await command.project({ trx: {}, account: command.account, input: effectiveInput, authorization });
    const event = { ...plan.event, seq: state.nextSeq++, conversationId: plan.event.conversationId };
    await plan.project({ trx: {}, event, account: command.account, input: effectiveInput, authorization });
    const response = {
      ...plan.response,
      eventId: event.id,
      message: plan.response.message ? { ...plan.response.message, seq: event.seq } : undefined,
      responseCode: plan.responseCode || "OK",
    };
    state.commandReceipts.set(receiptKey, { fingerprint, response: structuredClone(response) });
    if (state.dropResponseForCommandId === command.clientCommandId) {
      state.dropResponseForCommandId = null;
      throw new Error("simulated ACK loss after durable commit");
    }
    return response;
  };
  const task4CommandRunner = async (command) => {
    state.commandInputs.push(structuredClone(command.input));
    const receiptKey = (identity) => `${identity.actorDeviceId}:${identity.commandType}:${identity.clientCommandId}`;
    const database = {
      transaction() {
        return {
          async execute(callback) {
            const snapshot = structuredClone(state);
            try { return await callback({}); } catch (error) { Object.assign(state, snapshot); throw error; }
          },
        };
      },
    };
    const operations = {
      async findReceipt(_trx, identity) {
        return structuredClone(state.commandReceipts.get(receiptKey(identity)) || null);
      },
      async claimReceipt(_trx, identity, requestFingerprint) {
        const key = receiptKey(identity);
        const existing = state.commandReceipts.get(key);
        if (existing) return { inserted: false, receipt: structuredClone(existing) };
        const receipt = { ...identity, requestFingerprint, state: "running", responsePayload: {} };
        state.commandReceipts.set(key, receipt);
        return { inserted: true, receipt: structuredClone(receipt) };
      },
      async allocateSequence() { return { conversation: { id: "conversation-1" }, seq: state.nextSeq++ }; },
      async writeEvent(_trx, event) { return event; },
      async fanout(_trx, { event, recipientUserIds }) { return recipientUserIds.map((userId, index) => ({ userId, cursor: index + 1, eventId: event.id })); },
      async completeReceipt(_trx, identity, completed) {
        const key = receiptKey(identity);
        state.commandReceipts.set(key, { ...state.commandReceipts.get(key), ...completed, state: "completed" });
      },
      async writeRealtimeOutbox() {},
    };
    return runCollaborationCommand({
      ...command, database, operations,
      afterCommit: async () => {
        if (state.dropResponseForCommandId === command.clientCommandId) {
          state.dropResponseForCommandId = null;
          throw new Error("simulated ACK loss after durable commit");
        }
      },
    });
  };
  const commandRunner = useTask4Kernel ? task4CommandRunner : fakeCommandRunner;
  let id = 0;
  const service = createCollaborationMessageService({
    commandRunner,
    repository,
    createId: (prefix) => `${prefix}-${++id}`,
    now,
    messageCrypto,
    bodyIntentSigner: providedBodyIntentSigner || createHmacMessageBodyIntentSigner({ key: Buffer.alloc(32, 7) }),
  });
  return { state, service, cryptoCalls, messageCrypto };
}

const account = { userId: "user-a", deviceId: "device-a" };
const authorized = async () => ({ ok: true, visibleAfterSeq: 0 });

{
  const { state, service, messageCrypto } = createHarness();
  const send = {
    account,
    clientCommandId: "send-1",
    conversationId: "conversation-1",
    bodyText: "plain-text-1",
    mentionUserIds: ["user-b"],
    attachmentIds: ["object-ready"],
    authorize: authorized,
  };
  const first = await service.sendMessage(send);
  const replay = await service.sendMessage(send);
  assert.equal(first.message.seq, 1, "the command runner allocates the authoritative first sequence");
  assert.deepEqual(replay, first, "the same client command id returns the original durable response");
  assert.equal(state.messages.size, 1, "a replay creates one message projection only");
  const saved = [...state.messages.values()][0];
  assert.equal(saved.replyToMessageId, null);
  assert.deepEqual(saved.mentionUserIds, ["user-b"]);
  assert.deepEqual(saved.attachmentIds, ["object-ready"]);
  assert.equal(Buffer.from(saved.bodyCiphertext).includes(Buffer.from("plain-text-1")), false, "the projection contains an envelope, never plaintext");
  assert.equal(saved.bodyKeyVersion, 1);
  assert.equal(JSON.stringify(state.commandInputs).includes("plain-text-1"), false, "the command kernel receives an opaque body intent, not plaintext");
  assert.match(state.commandInputs[0].bodyIntent, /^hmac-v1:/, "the persisted request input uses a server-keyed body intent instead of plain SHA-256");
}

{
  const keyV1 = Buffer.alloc(32, 3);
  const keyV2 = Buffer.alloc(32, 4);
  const signerBeforeRotation = createHmacMessageBodyIntentSigner({ currentKeyVersion: 1, keysByVersion: { 1: keyV1, 2: keyV2 } });
  const signerAfterRotation = createHmacMessageBodyIntentSigner({ currentKeyVersion: 2, keysByVersion: { 1: keyV1, 2: keyV2 } });
  for (const bodyText of ["a", "1"]) {
    const signed = signerBeforeRotation.sign({ bodyText, conversationId: "conversation-1", actorUserId: "user-a", commandType: "message.create", keyVersion: 1 });
    assert.match(signed, /^hmac-v1:[0-9a-f]{64}$/, "a body intent has a strict opaque versioned HMAC representation");
    assert.notEqual(signed, bodyText);
    assert.equal(Object.hasOwn({ bodyIntent: signed }, "bodyText"), false, "the persisted intent carries no plaintext field; one-character bodies remain valid");
    assert.equal(signerBeforeRotation.verify({ bodyIntent: signed, bodyText, conversationId: "conversation-1", actorUserId: "user-a", commandType: "message.create" }), true);
  }
  const preRotationIntent = signerBeforeRotation.sign({ bodyText: "retry-safe", conversationId: "conversation-1", actorUserId: "user-a", commandType: "message.create", keyVersion: 1 });
  const retryAfterRotation = signerAfterRotation.sign({ bodyText: "retry-safe", conversationId: "conversation-1", actorUserId: "user-a", commandType: "message.create", keyVersion: 1 });
  assert.equal(retryAfterRotation, preRotationIntent, "the explicit original key version keeps a receipt-window retry fingerprint stable across rotation");
  assert.throws(
    () => signerAfterRotation.sign({ bodyText: "retry-safe", conversationId: "conversation-1", actorUserId: "user-a", commandType: "message.create", keyVersion: 99 }),
    (error) => error?.code === "COLLAB_BODY_INTENT_KEY_VERSION_UNKNOWN",
  );
}

{
  const keyV1 = Buffer.alloc(32, 5);
  const keyV2 = Buffer.alloc(32, 6);
  const signerState = {
    active: createHmacMessageBodyIntentSigner({ currentKeyVersion: 1, keysByVersion: { 1: keyV1, 2: keyV2 } }),
  };
  const rotatingSigner = {
    sign(values) { return signerState.active.sign(values); },
    verify(values) { return signerState.active.verify(values); },
  };
  const { state, service } = createHarness({ bodyIntentSigner: rotatingSigner, useTask4Kernel: true });
  state.dropResponseForCommandId = "ack-loss-rotation";
  await assert.rejects(
    service.sendMessage({ account, clientCommandId: "ack-loss-rotation", conversationId: "conversation-1", bodyText: "retry-after-rotation", authorize: authorized }),
    /simulated ACK loss after durable commit/,
  );
  assert.equal(state.messages.size, 1, "the first command committed before its ACK was lost");
  signerState.active = createHmacMessageBodyIntentSigner({ currentKeyVersion: 2, keysByVersion: { 1: keyV1, 2: keyV2 } });
  const replay = await service.sendMessage({ account, clientCommandId: "ack-loss-rotation", conversationId: "conversation-1", bodyText: "retry-after-rotation", authorize: authorized });
  assert.equal(replay.bodyIntentKeyVersion, 1, "receipt pre-read restores the original signer version after rotation");
  assert.equal(state.messages.size, 1, "the retry replays the original durable message rather than creating a second projection");
}

{
  const now = () => new Date("2026-08-29T12:00:00.000Z");
  const { state, service } = createHarness({ now });
  const created = await service.sendMessage({
    account, clientCommandId: "age-send", conversationId: "conversation-1", bodyText: "first", authorize: authorized,
  });
  const message = state.messages.get(created.message.id);
  message.createdAt = "2026-08-29T11:44:59.999Z";
  await assert.rejects(
    service.editMessage({
      account, clientCommandId: "late-edit", conversationId: "conversation-1", messageId: message.id,
      expectedRevision: 1, bodyText: "too late", authorize: authorized,
    }),
    (error) => error?.code === "COLLAB_MESSAGE_EDIT_WINDOW_EXPIRED",
  );
  message.createdAt = "2026-08-28T11:59:59.999Z";
  await assert.rejects(
    service.revokeMessage({
      account, clientCommandId: "late-revoke", conversationId: "conversation-1", messageId: message.id,
      expectedRevision: 1, authorize: authorized,
    }),
    (error) => error?.code === "COLLAB_MESSAGE_REVOKE_WINDOW_EXPIRED",
  );
}

{
  const first = applyMessageActivityProjection({ lastReadSeq: 3, unreadCount: 0, mentionCount: 0, appliedEventIds: [] }, {
    id: "event-4", seq: 4, type: "message.created", payload: { mentionUserIds: ["user-b"] },
  }, "user-b");
  const replay = applyMessageActivityProjection(first, {
    id: "event-4", seq: 4, type: "message.created", payload: { mentionUserIds: ["user-b"] },
  }, "user-b");
  const alreadyRead = applyMessageActivityProjection(replay, {
    id: "event-3", seq: 3, type: "message.created", payload: { mentionUserIds: ["user-b"] },
  }, "user-b");
  const selfSent = applyMessageActivityProjection(alreadyRead, {
    id: "event-5", seq: 5, type: "message.created", actorUserId: "user-b", payload: { mentionUserIds: ["user-b"] },
  }, "user-b");
  assert.deepEqual(replay, first, "a duplicate durable event cannot double-count unread or @ activity");
  assert.equal(first.unreadCount, 1);
  assert.equal(first.mentionCount, 1);
  assert.equal(alreadyRead.unreadCount, 1, "events at or behind the read pointer are not unread");
  assert.equal(selfSent.unreadCount, 1, "the sender's own durable event is not an unread message");
  assert.equal(selfSent.mentionCount, 1, "the sender cannot add an @ badge to their own event");
}

{
  let projection = { lastReadSeq: 0, unreadCount: 0, mentionCount: 0, appliedEventIds: [] };
  for (const event of [
    { id: "message-1", seq: 1, type: "message.created", actorUserId: "user-a", payload: { mentionUserIds: ["user-b"] } },
    { id: "message-2", seq: 2, type: "message.created", actorUserId: "user-a", payload: { mentionUserIds: [] } },
    { id: "message-3", seq: 3, type: "message.created", actorUserId: "user-a", payload: { mentionUserIds: ["user-b"] } },
  ]) projection = applyMessageActivityProjection(projection, event, "user-b");
  projection = applyMessageActivityProjection(projection, {
    id: "read-device-a-2", type: "conversation.read", actorUserId: "user-b", payload: { lastReadSeq: 2 },
  }, "user-b");
  const staleOtherDevice = applyMessageActivityProjection(projection, {
    id: "read-device-b-1", type: "conversation.read", actorUserId: "user-b", payload: { lastReadSeq: 1 },
  }, "user-b");
  const replay = applyMessageActivityProjection(staleOtherDevice, {
    id: "read-device-b-1", type: "conversation.read", actorUserId: "user-b", payload: { lastReadSeq: 1 },
  }, "user-b");
  assert.equal(projection.lastReadSeq, 2);
  assert.equal(projection.unreadCount, 1, "a read event removes all activity at or below its monotonic sequence");
  assert.equal(projection.mentionCount, 1);
  assert.equal(staleOtherDevice.lastReadSeq, projection.lastReadSeq, "a stale read from another device cannot move the pointer backwards");
  assert.equal(staleOtherDevice.unreadCount, projection.unreadCount, "a stale read from another device cannot reintroduce activity");
  assert.equal(staleOtherDevice.mentionCount, projection.mentionCount);
  assert.deepEqual(replay, staleOtherDevice, "duplicate read events are idempotent");
}

{
  const { service } = createHarness();
  const base = {
    account,
    clientCommandId: "invalid-send",
    conversationId: "conversation-1",
    bodyText: "text",
    authorize: authorized,
  };
  const attachmentOnly = await service.sendMessage({
    ...base, clientCommandId: "attachment-empty-body", bodyText: null, attachmentIds: ["object-ready"],
  });
  assert.equal(attachmentOnly.message.id.startsWith("msg-"), true, "an attachment-only message has an explicit empty-body path");
  await assert.rejects(
    service.sendMessage({ ...base, bodyText: "x".repeat(MAX_MESSAGE_BODY_BYTES + 1) }),
    (error) => error?.code === "COLLAB_MESSAGE_BODY_TOO_LARGE",
  );
  await assert.rejects(
    service.sendMessage({ ...base, clientCommandId: "untrusted-ciphertext", bodyCiphertext: Buffer.from("forged"), bodyText: "text" }),
    (error) => error?.code === "COLLAB_MESSAGE_CIPHERTEXT_INPUT_FORBIDDEN",
    "callers cannot smuggle arbitrary ciphertext into durable message storage",
  );
  await assert.rejects(
    service.sendMessage({ ...base, clientCommandId: "bad-reply", replyToMessageId: "missing" }),
    (error) => error?.code === "COLLAB_REPLY_TARGET_INVALID",
  );
  await assert.rejects(
    service.sendMessage({ ...base, clientCommandId: "pending-attachment", attachmentIds: ["object-pending"] }),
    (error) => error?.code === "COLLAB_ATTACHMENT_NOT_READY",
  );
  await assert.rejects(
    service.sendMessage({ ...base, clientCommandId: "inactive-mention", mentionUserIds: ["user-z"] }),
    (error) => error?.code === "COLLAB_MENTION_MEMBER_INACTIVE",
  );
  await assert.rejects(
    service.sendMessage({ ...base, clientCommandId: "denied", authorize: async () => ({ ok: false, code: "COLLAB_BLOCKED" }) }),
    (error) => error?.code === "COLLAB_BLOCKED",
  );
}

{
  const { state, service, messageCrypto } = createHarness();
  const created = await service.sendMessage({
    account, clientCommandId: "send-edit", conversationId: "conversation-1", bodyText: "first", authorize: authorized,
  });
  const messageId = created.message.id;
  const edited = await service.editMessage({
    account, clientCommandId: "edit-1", conversationId: "conversation-1", messageId,
    expectedRevision: 1, bodyText: "second", authorize: authorized,
  });
  assert.equal(edited.message.revision, 2);
  assert.equal(state.revisions.length, 1, "an edit persists a single immutable revision projection");
  assert.equal(Buffer.from(state.messages.get(messageId).bodyCiphertext).includes(Buffer.from("second")), false, "edited projection never contains the new plaintext");
  assert.equal(JSON.stringify(state.commandInputs).includes("second"), false, "the edit command does not retain plaintext outside the encryption boundary");
  assert.deepEqual(
    messageCrypto.decrypt({
      ciphertext: state.messages.get(messageId).bodyCiphertext, keyVersion: state.messages.get(messageId).bodyKeyVersion,
      messageId, conversationId: "conversation-1", revision: 2,
    }),
    Buffer.from("second"),
    "the edit envelope is bound to its actual incremented revision",
  );
  assert.throws(
    () => messageCrypto.decrypt({
      ciphertext: state.messages.get(messageId).bodyCiphertext, keyVersion: state.messages.get(messageId).bodyKeyVersion,
      messageId, conversationId: "conversation-1", revision: 1,
    }),
    (error) => error?.code === "COLLAB_MESSAGE_CIPHERTEXT_INVALID",
    "the same edit ciphertext cannot be replayed under its prior revision",
  );
  await assert.rejects(
    service.editMessage({
      account, clientCommandId: "edit-race", conversationId: "conversation-1", messageId,
      expectedRevision: 1, bodyText: "lost", authorize: authorized,
    }),
    (error) => error?.code === "MESSAGE_REVISION_CONFLICT" && error.currentRevision === 2,
    "a stale second device edit receives the current revision instead of last-write-wins",
  );
  const revoked = await service.revokeMessage({
    account, clientCommandId: "revoke-1", conversationId: "conversation-1", messageId,
    expectedRevision: 2, authorize: authorized,
  });
  assert.equal(revoked.message.revoked, true);
  assert.equal(state.messages.get(messageId).bodyCiphertext, null, "a revoked projection no longer exposes its body ciphertext");
}

{
  const { state, service } = createHarness();
  const first = await service.markConversationRead({
    account, clientCommandId: "read-10", conversationId: "conversation-1", submittedSeq: 10, authorize: authorized,
  });
  const stale = await service.markConversationRead({
    account, clientCommandId: "read-5", conversationId: "conversation-1", submittedSeq: 5, authorize: authorized,
  });
  assert.equal(first.lastReadSeq, 10);
  assert.equal(stale.lastReadSeq, 10, "a stale device acknowledgement cannot move the read pointer backwards");
  assert.equal(state.reads.get("conversation-1:user-a"), 10);
}

{
  const { service, cryptoCalls } = createHarness();
  await service.sendMessage({ account, clientCommandId: "history-1", conversationId: "conversation-1", bodyText: "one", authorize: authorized });
  await service.sendMessage({ account, clientCommandId: "history-2", conversationId: "conversation-1", bodyText: "two", authorize: authorized });
  await assert.rejects(
    service.listMessageHistory({
      account, conversationId: "conversation-1", authorize: async () => ({ ok: false, code: "COLLAB_MEMBERSHIP_INACTIVE" }),
    }),
    (error) => error?.code === "COLLAB_MEMBERSHIP_INACTIVE",
    "history cannot be read without a current server-derived membership authorization",
  );
  assert.equal(cryptoCalls.decrypt, 0, "a denied history request must not decrypt any message");
  await assert.rejects(
    service.listMessageHistory({
      account, conversationId: "conversation-1", authorize: async () => ({
        ok: true, visibleAfterSeq: 0, conversationMembership: { status: "left", joinedSeq: 0 },
      }),
    }),
    (error) => error?.code === "COLLAB_MEMBERSHIP_INACTIVE",
    "a stale/left member is rejected even if a caller supplies a nominally successful authorization result",
  );
  assert.equal(cryptoCalls.decrypt, 0, "an inactive member must not cause a decryption attempt");
  const page = await service.listMessageHistory({
    account, conversationId: "conversation-1", beforeSeq: 2, limit: 50, authorize: authorized,
  });
  assert.equal(page.length, 1);
  assert.equal(page[0].createSeq, 1, "history uses beforeSeq keyset pagination rather than client timestamps");
  assert.equal(page[0].bodyText, "one", "an authorized history response decrypts into the controlled text view");
  assert.equal(page[0].bodyCiphertext, undefined, "history never returns raw ciphertext envelopes to its caller");
  assert.equal(page[0].accessToken, undefined, "history omits credentials and internal repository fields");
  const joinedLater = await service.listMessageHistory({
    account: { userId: "user-c", deviceId: "device-c" }, conversationId: "conversation-1", authorize: async () => ({
      ok: true, visibleAfterSeq: 1, conversationMembership: { status: "active", joinedSeq: 1 },
    }),
  });
  assert.deepEqual(joinedLater.map((message) => message.createSeq), [2], "a new member receives only messages strictly after its locked joined sequence");
  const targeted = await service.listMessageHistory({ account, conversationId: "conversation-1", messageIds: [page[0].id], authorize: authorized });
  assert.deepEqual(targeted.map((message) => message.id), [page[0].id], "target hydration retrieves an old message independent of the newest window");
  const invisibleTarget = await service.listMessageHistory({ account, conversationId: "conversation-1", messageIds: [page[0].id], authorize: async () => ({ ok: true, visibleAfterSeq: 1 }) });
  assert.deepEqual(invisibleTarget, [], "target IDs cannot bypass the current joined-sequence boundary");
  for (const messageIds of [[], [page[0].id, page[0].id], Array.from({ length: 201 }, (_, i) => `message-${i}`), [1]]) {
    await assert.rejects(service.listMessageHistory({ account, conversationId: "conversation-1", messageIds, authorize: authorized }), /message ids/i);
  }
  await assert.rejects(service.listMessageHistory({ account, conversationId: "conversation-1", messageIds: [page[0].id], beforeSeq: 2, authorize: authorized }), /message ids/i);
  await assert.rejects(service.listMessageHistory({ account, conversationId: "conversation-1", authorize: authorized, limit: 201 }), /between 1 and 200/);
}

console.log("collaboration messages: ok");
