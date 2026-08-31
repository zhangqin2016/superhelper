import { randomUUID } from "node:crypto";

import { runCollaborationCommand } from "./command-runner.js";
import {
  commandError, requiredId, requiredPositiveInteger, normalizeIdList,
  normalizedBodyText, signedBodyIntent, resolveStableBodyIntent,
} from "./message-input.js";

export { MAX_MESSAGE_BODY_BYTES, createHmacMessageBodyIntentSigner } from "./message-input.js";

export const DEFAULT_MESSAGE_HISTORY_LIMIT = 50;
export const MAX_MESSAGE_HISTORY_LIMIT = 200;
export const MAX_MESSAGE_EDIT_AGE_MS = 15 * 60 * 1_000;
export const MAX_MESSAGE_REVOKE_AGE_MS = 24 * 60 * 60 * 1_000;

function encryptBody(messageCrypto, bodyText, { messageId, conversationId, revision }) {
  if (bodyText == null) return { ciphertext: null, keyVersion: null };
  const encrypted = messageCrypto.encrypt({
    plaintext: Buffer.from(bodyText, "utf8"), messageId, conversationId, revision,
  });
  if (!Buffer.isBuffer(encrypted?.ciphertext) && !(encrypted?.ciphertext instanceof Uint8Array)) {
    throw new Error("Message crypto did not return ciphertext bytes.");
  }
  return {
    ciphertext: Buffer.from(encrypted.ciphertext),
    keyVersion: requiredPositiveInteger(encrypted.keyVersion, "Encrypted message body key version"),
  };
}

function normalizedMembers(memberIds) {
  const normalized = normalizeIdList(memberIds, "Active conversation member ids");
  if (normalized.length === 0) throw new Error("A collaboration conversation must have active members.");
  return normalized.sort();
}

function requireRepositoryMethod(repository, method) {
  if (typeof repository?.[method] !== "function") {
    throw new TypeError(`Collaboration message repository must implement ${method}().`);
  }
  return repository[method].bind(repository);
}

async function validatedRecipients(repository, trx, conversationId) {
  const memberIds = await requireRepositoryMethod(repository, "activeConversationMemberIds")(trx, { conversationId });
  return normalizedMembers(memberIds);
}

async function validateReplyTarget(repository, trx, { conversationId, replyToMessageId }) {
  if (!replyToMessageId) return null;
  const reply = await requireRepositoryMethod(repository, "findReplyTarget")(trx, { conversationId, replyToMessageId });
  if (!reply || reply.conversationId !== conversationId || reply.revokedAt) {
    throw commandError("COLLAB_REPLY_TARGET_INVALID", "The replied-to message is not available in this conversation.");
  }
  return reply.id;
}

async function validateAttachments(repository, trx, { attachmentIds, account }) {
  if (attachmentIds.length === 0) return [];
  const found = await requireRepositoryMethod(repository, "findAttachments")(trx, { attachmentIds, account });
  const byId = new Map((Array.isArray(found) ? found : []).map((attachment) => [attachment?.id, attachment]));
  for (const attachmentId of attachmentIds) {
    const attachment = byId.get(attachmentId);
    if (!attachment || attachment.state !== "verified" || attachment.ownerUserId !== account.userId) {
      throw commandError("COLLAB_ATTACHMENT_NOT_READY", "Every attached object must be verified and owned by the sender before sending.");
    }
  }
  return attachmentIds;
}

async function validateMentions(repository, trx, { conversationId, mentionUserIds }) {
  if (mentionUserIds.length === 0) return [];
  const activeIds = new Set(await validatedRecipients(repository, trx, conversationId));
  if (mentionUserIds.some((userId) => !activeIds.has(userId))) {
    throw commandError("COLLAB_MENTION_MEMBER_INACTIVE", "Mentions may only target current active conversation members.");
  }
  return mentionUserIds;
}

function responseMessage({ id, conversationId, revision = 1, revoked = false }) {
  return { id, conversationId, revision, revoked };
}

function assertMutationWindow(message, maximumAgeMs, code, now) {
  const createdAt = message?.createdAt ?? message?.created_at;
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs) || now().getTime() - createdMs > maximumAgeMs) {
    throw commandError(code, "The message is outside the allowed mutation window.");
  }
}

/**
 * Apply message activity once to a user's sync projection. The durable sync
 * layer owns the persisted applied-event set; this pure helper makes the
 * unread/@ arithmetic deterministic when a page is replayed after a crash.
 */
export function applyMessageActivityProjection(state = {}, event = {}, userId) {
  const eventId = requiredId(event?.id, "Collaboration event id");
  const appliedEventIds = normalizeIdList(state.appliedEventIds, "Applied event ids");
  const lastReadSeq = Math.max(0, Number(state.lastReadSeq) || 0);
  const unreadActivities = Array.isArray(state.unreadActivities)
    ? state.unreadActivities.map((activity) => ({
      eventId: requiredId(activity?.eventId, "Unread activity event id"),
      seq: requiredPositiveInteger(activity?.seq, "Unread activity sequence"),
      mentioned: activity?.mentioned === true,
    }))
    : [];
  const activityState = (nextLastReadSeq, nextActivities, nextAppliedEventIds) => ({
    lastReadSeq: nextLastReadSeq,
    unreadCount: nextActivities.length,
    mentionCount: nextActivities.filter((activity) => activity.mentioned).length,
    appliedEventIds: nextAppliedEventIds,
    unreadActivities: nextActivities,
  });
  if (appliedEventIds.includes(eventId)) {
    return activityState(lastReadSeq, unreadActivities, appliedEventIds);
  }
  const nextAppliedEventIds = [...appliedEventIds, eventId];
  const actorUserId = String(event?.actorUserId ?? event?.actor_user_id ?? "");
  if (event?.type === "conversation.read") {
    const submittedSeq = Math.max(0, Number(event?.payload?.lastReadSeq ?? event?.lastReadSeq) || 0);
    if (!Number.isSafeInteger(submittedSeq) || actorUserId !== String(userId || "")) {
      return activityState(lastReadSeq, unreadActivities, nextAppliedEventIds);
    }
    const eventSeq = Number(event.seq);
    const boundedSeq = Number.isSafeInteger(eventSeq) && eventSeq > 0 ? Math.min(submittedSeq, eventSeq - 1) : submittedSeq;
    const nextLastReadSeq = Math.max(lastReadSeq, boundedSeq);
    return activityState(nextLastReadSeq, unreadActivities.filter((activity) => activity.seq > nextLastReadSeq), nextAppliedEventIds);
  }
  const seq = Number(event?.seq);
  const isOwnEvent = actorUserId === String(userId || "");
  const isNewMessage = event?.type === "message.created" && !isOwnEvent && Number.isSafeInteger(seq) && seq > lastReadSeq;
  const mentions = Array.isArray(event?.payload?.mentionUserIds) ? event.payload.mentionUserIds.map(String) : [];
  const nextActivities = isNewMessage
    ? [...unreadActivities, { eventId, seq, mentioned: mentions.includes(String(userId || "")) }]
    : unreadActivities;
  return activityState(lastReadSeq, nextActivities, nextAppliedEventIds);
}

function historyMessageView(message, messageCrypto) {
  const id = String(message?.id || "");
  const conversationId = String(message?.conversationId ?? message?.conversation_id ?? "");
  const revision = Number(message?.revision || 1);
  const ciphertext = message?.bodyCiphertext ?? message?.body_ciphertext ?? null;
  const keyVersion = message?.bodyKeyVersion ?? message?.body_key_version ?? null;
  const bodyText = ciphertext == null ? null : messageCrypto.decrypt({
    ciphertext, keyVersion, messageId: id, conversationId, revision,
  }).toString("utf8");
  return {
    id,
    conversationId,
    createSeq: Number(message?.createSeq ?? message?.create_seq),
    senderUserId: String(message?.senderUserId ?? message?.sender_user_id ?? ""),
    kind: String(message?.kind || "text"),
    bodyText,
    revision,
    replyToMessageId: message?.replyToMessageId ?? message?.reply_to_message_id ?? null,
    editedAt: message?.editedAt ?? message?.edited_at ?? null,
    revokedAt: message?.revokedAt ?? message?.revoked_at ?? null,
    createdAt: message?.createdAt ?? message?.created_at ?? null,
    attachmentIds: Array.isArray(message?.attachmentIds) ? [...message.attachmentIds] : [],
  };
}

function lockedVisibleAfterSeq(authorization) {
  const membership = authorization?.conversationMembership || authorization?.membership || null;
  const membershipStatus = membership?.status ?? authorization?.membershipStatus ?? "active";
  if (membershipStatus !== "active") {
    throw commandError("COLLAB_MEMBERSHIP_INACTIVE", "The current conversation membership is no longer active.");
  }
  const visibleAfterSeq = authorization?.visibleAfterSeq
    ?? authorization?.visible_after_seq
    ?? membership?.visibleAfterSeq
    ?? membership?.visible_after_seq
    ?? membership?.joinedSeq
    ?? membership?.joined_seq
    ?? authorization?.joinedSeq
    ?? authorization?.joined_seq;
  const sequence = Number(visibleAfterSeq);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw commandError("COLLAB_HISTORY_VISIBILITY_CONTEXT_REQUIRED", "History authorization must include a locked visibility sequence.");
  }
  return sequence;
}

function commandOptions({ account, commandType, clientCommandId, input, authorize, database, maxTransactionRetries, commandRunner, resolveInput, project }) {
  if (typeof authorize !== "function") throw new TypeError("Collaboration message commands require authorize().");
  return {
    account,
    commandType,
    clientCommandId: requiredId(clientCommandId, "Client command id"),
    input,
    authorize,
    database,
    maxTransactionRetries,
    resolveInput,
    project,
    // The Task 4 kernel is the sole durable write path. It is injectable only
    // for deterministic tests; production defaults to that kernel directly.
    commandRunner,
  };
}

/**
 * Build the collaboration message domain service. Repository methods are
 * transaction-scoped and deliberately injected: routes assemble their locked
 * authorization snapshot separately, while every persistent mutation still
 * goes through Task 4's idempotent command kernel.
 */
export function createCollaborationMessageService({
  commandRunner = runCollaborationCommand,
  repository,
  createId = (prefix) => `${prefix}_${randomUUID()}`,
  now = () => new Date(),
  messageCrypto,
  bodyIntentSigner,
} = {}) {
  if (typeof commandRunner !== "function") throw new TypeError("A collaboration command runner is required.");
  if (typeof createId !== "function") throw new TypeError("A collaboration message id factory is required.");
  if (typeof now !== "function") throw new TypeError("A collaboration clock is required.");
  if (typeof messageCrypto?.encrypt !== "function" || typeof messageCrypto?.decrypt !== "function") {
    throw new TypeError("Collaboration message service requires message encryption and decryption.");
  }
  if (typeof bodyIntentSigner?.sign !== "function") throw new TypeError("Collaboration message service requires a server-only body intent signer.");

  async function sendMessage({
    account,
    clientCommandId,
    conversationId: rawConversationId,
    bodyText,
    bodyCiphertext,
    bodyKeyVersion,
    bodyIntentKeyVersion,
    replyToMessageId: rawReplyToMessageId,
    attachmentIds: rawAttachmentIds,
    mentionUserIds: rawMentionUserIds,
    authorize,
    database,
    maxTransactionRetries,
  } = {}) {
    const conversationId = requiredId(rawConversationId, "Conversation id");
    const replyToMessageId = rawReplyToMessageId == null ? null : requiredId(rawReplyToMessageId, "Reply-to message id");
    if (bodyCiphertext != null || bodyKeyVersion != null) {
      throw commandError("COLLAB_MESSAGE_CIPHERTEXT_INPUT_FORBIDDEN", "Message ciphertext is created only by the collaboration message service.");
    }
    const attachmentIds = normalizeIdList(rawAttachmentIds, "Attachment ids");
    const mentionUserIds = normalizeIdList(rawMentionUserIds, "Mention user ids");
    const normalizedText = normalizedBodyText(bodyText, { required: attachmentIds.length === 0 });
    const actorUserId = requiredId(account?.userId ?? account?.user_id ?? account?.id, "Account user id");
    const messageId = requiredId(createId("msg"), "Generated message id");
    const eventId = requiredId(createId("evt"), "Generated message event id");
    const createdAt = now().toISOString();
    const signedIntent = signedBodyIntent(bodyIntentSigner, {
      bodyText: normalizedText, conversationId, actorUserId, commandType: "message.create", keyVersion: bodyIntentKeyVersion,
    });
    const input = {
      conversationId,
      bodyIntent: signedIntent?.value ?? null,
      bodyIntentKeyVersion: signedIntent?.keyVersion ?? null,
      replyToMessageId, attachmentIds, mentionUserIds,
    };
    const resolveInput = resolveStableBodyIntent({
      bodyIntentSigner, originalInput: input, bodyText: normalizedText, conversationId, actorUserId, commandType: "message.create",
    });
    return commandRunner(commandOptions({
      account, commandType: "message.create", clientCommandId, input, authorize, database, maxTransactionRetries, commandRunner, resolveInput,
      project: async ({ trx, account: actor }) => {
        const replyId = await validateReplyTarget(repository, trx, { conversationId, replyToMessageId });
        const readyAttachmentIds = await validateAttachments(repository, trx, { attachmentIds, account: actor });
        const activeMentionUserIds = await validateMentions(repository, trx, { conversationId, mentionUserIds });
        const recipientUserIds = await validatedRecipients(repository, trx, conversationId);
        const encrypted = encryptBody(messageCrypto, normalizedText, { messageId, conversationId, revision: 1 });
        const response = { eventId, bodyIntentKeyVersion: signedIntent?.keyVersion ?? null, message: responseMessage({ id: messageId, conversationId }) };
        return {
          event: { id: eventId, conversationId, type: "message.created", payload: { messageId, mentionUserIds: activeMentionUserIds } },
          recipientUserIds,
          response,
          project: async ({ trx: projectionTrx, event }) => {
            response.eventId = event.id;
            response.message.seq = event.seq;
            await requireRepositoryMethod(repository, "insertMessage")(projectionTrx, {
              id: messageId, eventId: event.id, conversationId, createSeq: event.seq,
              senderUserId: actor.userId, kind: readyAttachmentIds.length > 0 && !encrypted.ciphertext ? "attachment" : "text",
              bodyCiphertext: encrypted.ciphertext, bodyKeyVersion: encrypted.keyVersion, revision: 1,
              replyToMessageId: replyId, attachmentIds: readyAttachmentIds, mentionUserIds: activeMentionUserIds,
              createdAt,
            });
          },
        };
      },
    }));
  }

  async function editMessage({
    account, clientCommandId, conversationId: rawConversationId, messageId: rawMessageId, expectedRevision,
    bodyText, bodyCiphertext, bodyKeyVersion, bodyIntentKeyVersion, authorize, database, maxTransactionRetries,
  } = {}) {
    const conversationId = requiredId(rawConversationId, "Conversation id");
    const messageId = requiredId(rawMessageId, "Message id");
    const revision = requiredPositiveInteger(expectedRevision, "Expected message revision");
    if (bodyCiphertext != null || bodyKeyVersion != null) {
      throw commandError("COLLAB_MESSAGE_CIPHERTEXT_INPUT_FORBIDDEN", "Message ciphertext is created only by the collaboration message service.");
    }
    const normalizedText = normalizedBodyText(bodyText);
    const actorUserId = requiredId(account?.userId ?? account?.user_id ?? account?.id, "Account user id");
    const eventId = requiredId(createId("evt"), "Generated message event id");
    const signedIntent = signedBodyIntent(bodyIntentSigner, {
      bodyText: normalizedText, conversationId, actorUserId, commandType: "message.edit", expectedRevision: revision, keyVersion: bodyIntentKeyVersion,
    });
    const input = {
      conversationId, messageId, expectedRevision: revision,
      bodyIntent: signedIntent?.value ?? null,
      bodyIntentKeyVersion: signedIntent?.keyVersion ?? null,
    };
    const resolveInput = resolveStableBodyIntent({
      bodyIntentSigner, originalInput: input, bodyText: normalizedText, conversationId, actorUserId,
      commandType: "message.edit", expectedRevision: revision,
    });
    return commandRunner(commandOptions({
      account, commandType: "message.edit", clientCommandId, input, authorize, database, maxTransactionRetries, commandRunner, resolveInput,
      project: async ({ trx, account: actor }) => {
        const current = await requireRepositoryMethod(repository, "findMessageForUpdate")(trx, { conversationId, messageId });
        if (!current || current.senderUserId !== actor.userId || current.revokedAt) {
          throw commandError("COLLAB_MESSAGE_EDIT_FORBIDDEN", "This message cannot be edited by the current sender.");
        }
        assertMutationWindow(current, MAX_MESSAGE_EDIT_AGE_MS, "COLLAB_MESSAGE_EDIT_WINDOW_EXPIRED", now);
        if (current.revision !== revision) {
          throw commandError("MESSAGE_REVISION_CONFLICT", "The message has changed on another device.", { currentRevision: current.revision });
        }
        const recipientUserIds = await validatedRecipients(repository, trx, conversationId);
        const encrypted = encryptBody(messageCrypto, normalizedText, { messageId, conversationId, revision: revision + 1 });
        const response = { eventId, bodyIntentKeyVersion: signedIntent?.keyVersion ?? null, message: responseMessage({ id: messageId, conversationId, revision: revision + 1 }) };
        return {
          event: { id: eventId, conversationId, type: "message.edited", payload: { messageId, revision: revision + 1 } },
          recipientUserIds,
          response,
          project: async ({ trx: projectionTrx, event }) => {
            const edited = await requireRepositoryMethod(repository, "compareAndSwapMessage")(projectionTrx, {
              conversationId, messageId, expectedRevision: revision,
              patch: { bodyCiphertext: encrypted.ciphertext, bodyKeyVersion: encrypted.keyVersion, editedAt: now().toISOString() },
            });
            if (!edited) {
              const latest = await requireRepositoryMethod(repository, "findMessageForUpdate")(projectionTrx, { conversationId, messageId });
              throw commandError("MESSAGE_REVISION_CONFLICT", "The message has changed on another device.", { currentRevision: latest?.revision || null });
            }
            await requireRepositoryMethod(repository, "insertMessageRevision")(projectionTrx, {
              id: requiredId(createId("rev"), "Generated message revision id"), messageId, eventId: event.id,
              conversationId, eventSeq: event.seq, bodyCiphertext: encrypted.ciphertext, keyVersion: encrypted.keyVersion,
            });
            response.eventId = event.id;
            response.message = responseMessage({ id: messageId, conversationId, revision: edited.revision });
            response.message.seq = event.seq;
          },
        };
      },
    }));
  }

  async function revokeMessage({
    account, clientCommandId, conversationId: rawConversationId, messageId: rawMessageId, expectedRevision,
    authorize, database, maxTransactionRetries,
  } = {}) {
    const conversationId = requiredId(rawConversationId, "Conversation id");
    const messageId = requiredId(rawMessageId, "Message id");
    const revision = requiredPositiveInteger(expectedRevision, "Expected message revision");
    const eventId = requiredId(createId("evt"), "Generated message event id");
    const input = { conversationId, messageId, expectedRevision: revision };
    return commandRunner(commandOptions({
      account, commandType: "message.revoke", clientCommandId, input, authorize, database, maxTransactionRetries, commandRunner,
      project: async ({ trx, account: actor }) => {
        const current = await requireRepositoryMethod(repository, "findMessageForUpdate")(trx, { conversationId, messageId });
        if (!current || current.senderUserId !== actor.userId || current.revokedAt) {
          throw commandError("COLLAB_MESSAGE_REVOKE_FORBIDDEN", "This message cannot be revoked by the current sender.");
        }
        assertMutationWindow(current, MAX_MESSAGE_REVOKE_AGE_MS, "COLLAB_MESSAGE_REVOKE_WINDOW_EXPIRED", now);
        if (current.revision !== revision) {
          throw commandError("MESSAGE_REVISION_CONFLICT", "The message has changed on another device.", { currentRevision: current.revision });
        }
        const recipientUserIds = await validatedRecipients(repository, trx, conversationId);
        const response = { eventId, message: responseMessage({ id: messageId, conversationId, revision: revision + 1, revoked: true }) };
        return {
          event: { id: eventId, conversationId, type: "message.revoked", payload: { messageId, revision: revision + 1 } },
          recipientUserIds,
          response,
          project: async ({ trx: projectionTrx, event }) => {
            const revoked = await requireRepositoryMethod(repository, "compareAndSwapMessage")(projectionTrx, {
              conversationId, messageId, expectedRevision: revision,
              patch: { bodyCiphertext: null, bodyKeyVersion: null, revokedAt: now().toISOString() },
            });
            if (!revoked) {
              const latest = await requireRepositoryMethod(repository, "findMessageForUpdate")(projectionTrx, { conversationId, messageId });
              throw commandError("MESSAGE_REVISION_CONFLICT", "The message has changed on another device.", { currentRevision: latest?.revision || null });
            }
            response.eventId = event.id;
            response.message = responseMessage({ id: messageId, conversationId, revision: revoked.revision, revoked: true });
            response.message.seq = event.seq;
          },
        };
      },
    }));
  }

  async function markConversationRead({
    account, clientCommandId, conversationId: rawConversationId, submittedSeq, authorize, database, maxTransactionRetries,
  } = {}) {
    const conversationId = requiredId(rawConversationId, "Conversation id");
    const readSeq = Number(submittedSeq);
    if (!Number.isSafeInteger(readSeq) || readSeq < 0) throw new TypeError("Submitted read sequence must be a non-negative integer.");
    const eventId = requiredId(createId("evt"), "Generated read event id");
    const input = { conversationId, submittedSeq: readSeq };
    return commandRunner(commandOptions({
      account, commandType: "conversation.read", clientCommandId, input, authorize, database, maxTransactionRetries, commandRunner,
      project: async ({ trx, account: actor }) => {
        const recipientUserIds = await validatedRecipients(repository, trx, conversationId);
        // Authorization retains the conversation lock. Resolve before allocating
        // the read event, while keeping the actual write after the durable event.
        const effectiveReadSeq = await requireRepositoryMethod(repository, "resolveLastReadSeq")(trx, {
          conversationId, userId: actor.userId, submittedSeq: readSeq,
        });
        const response = { eventId, lastReadSeq: effectiveReadSeq };
        return {
          event: { id: eventId, conversationId, type: "conversation.read", payload: { lastReadSeq: effectiveReadSeq } },
          recipientUserIds,
          response,
          project: async ({ trx: projectionTrx, event }) => {
            const result = await requireRepositoryMethod(repository, "advanceLastReadSeq")(projectionTrx, {
              conversationId, userId: actor.userId, submittedSeq: effectiveReadSeq,
            });
            if (Number(result?.lastReadSeq) !== effectiveReadSeq) throw new Error("Collaboration read projection diverged from its event.");
            response.eventId = event.id;
            response.lastReadSeq = Number(result?.lastReadSeq);
          },
        };
      },
    }));
  }

  async function listMessageHistory({
    account, conversationId: rawConversationId, beforeSeq = null, messageIds = null, limit = DEFAULT_MESSAGE_HISTORY_LIMIT, trx, authorize,
  } = {}) {
    const conversationId = requiredId(rawConversationId, "Conversation id");
    const actorUserId = requiredId(account?.userId ?? account?.user_id ?? account?.id, "Account user id");
    if (typeof authorize !== "function") throw new TypeError("Collaboration message history requires authorize().");
    if (messageIds != null && (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > MAX_MESSAGE_HISTORY_LIMIT
        || messageIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)
        || new Set(messageIds).size !== messageIds.length || beforeSeq != null)) throw new TypeError("History message ids are invalid.");
    const normalizedLimit = messageIds == null ? Number(limit) : messageIds.length;
    if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > MAX_MESSAGE_HISTORY_LIMIT) {
      throw new RangeError(`Message history limit must be between 1 and ${MAX_MESSAGE_HISTORY_LIMIT}.`);
    }
    const normalizedBeforeSeq = beforeSeq == null ? null : requiredPositiveInteger(beforeSeq, "History before sequence");
    const authorization = await authorize({
      trx, account: { ...account, userId: actorUserId }, input: { conversationId, beforeSeq: normalizedBeforeSeq, messageIds, limit: normalizedLimit }, action: "read",
    });
    if (!authorization?.ok) {
      throw commandError(authorization?.code || "COLLAB_AUTHORIZATION_DENIED", authorization?.auditReason || "Collaboration history authorization was denied.");
    }
    const visibleAfterSeq = lockedVisibleAfterSeq(authorization);
    const rows = await requireRepositoryMethod(repository, "listHistory")(trx, {
      conversationId, beforeSeq: normalizedBeforeSeq, messageIds, limit: normalizedLimit, visibleAfterSeq,
      account: { ...account, userId: actorUserId }, authorization,
    });
    return (Array.isArray(rows) ? rows : [])
      .filter((message) => Number(message?.createSeq ?? message?.create_seq) > visibleAfterSeq)
      .filter((message) => messageIds == null || messageIds.includes(message.id))
      .map((message) => historyMessageView(message, messageCrypto));
  }

  return Object.freeze({ sendMessage, editMessage, revokeMessage, markConversationRead, listMessageHistory });
}
