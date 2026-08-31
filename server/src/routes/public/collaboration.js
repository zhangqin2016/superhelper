import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";

import { requireAccountSession } from "../../services/account-session-guard.js";
import { verifySignedDeviceRequest } from "../../services/device-identity.js";
import { db } from "../../db.js";
import { createCollaborationSyncService } from "../../services/collaboration/sync-service.js";
import { createCollaborationWsTicketService } from "../../services/collaboration/ws-ticket.js";
import { createCollaborationFriendService, createKyselyFriendRepository } from "../../services/collaboration/friends.js";
import { config } from "../../config.js";
import { createCollaborationMessageService, createHmacMessageBodyIntentSigner } from "../../services/collaboration/messages.js";
import { createCollaborationMessageCrypto } from "../../services/collaboration/message-crypto.js";
import { createKyselyMessageRepository, createLockedMessageAuthorizer } from "../../services/collaboration/message-repository.js";
import { assertCollaborationReceiptIdentity } from "../../services/collaboration/receipt-identity.js";
import { registerCollaborationConversationRoutes } from "./collaboration-conversations.js";
import { registerCollaborationObjectRoutes, objectRouteOptions } from "./collaboration-objects.js";
import { createConfiguredCollaborationObjectService } from "../../services/collaboration/object-config.js";

const deviceBody = z.object({ deviceId: z.string().min(1).max(120) });
const commandBody = deviceBody.extend({ clientCommandId: z.string().min(1).max(200) });
// Reject server-owned quote authority explicitly without making legacy input
// globally strict: unrelated unknown fields keep their existing strip behavior.
const messageCommandBody = commandBody.extend({ replySnapshot: z.never().optional(), replySnapshotCiphertext: z.never().optional(), replySnapshotKeyVersion: z.never().optional() });
const errorBody = (error, requestId) => ({ ok: false, code: error?.code || "COLLABORATION_REQUEST_FAILED", retryable: error?.retryable === true, requestId });
function receiptPayload(value) { if (value && typeof value === "object") return value; try { return JSON.parse(String(value || "{}")); } catch { return {}; } }
function commandReceiptView(receipt, event, commandType) {
  if (!receipt) return { state: "unknown", committed: false, deliveryUnknown: true };
  const payload = receiptPayload(receipt.response_payload);
  const result = payload?.result && typeof payload.result === "object" ? payload.result : payload;
  const message = result?.message && typeof result.message === "object" ? result.message : {};
  const eventPayload = receiptPayload(event?.payload);
  const eventMessageId = eventPayload?.messageId ?? eventPayload?.message_id ?? message?.id;
  const revision = Number(eventPayload?.revision ?? message?.revision);
  return {
    state: String(receipt.state || "unknown"),
    committed: String(receipt.state || "") === "completed",
    commandType,
    ...(event?.conversation_id ? { conversationId: event.conversation_id } : {}),
    ...(result?.eventId || receipt.result_event_id ? { eventId: result.eventId || receipt.result_event_id } : {}),
    ...(eventMessageId ? { messageId: eventMessageId } : {}),
    ...(Number.isSafeInteger(revision) ? { revision } : {}),
    ...(message?.revoked === true ? { revoked: true } : {}),
    ...(Number.isSafeInteger(Number(event?.seq)) ? { eventSequence: Number(event.seq), sequence: Number(event.seq) } : {}),
    ...(String(receipt.state || "") === "running" ? { pending: true } : {}),
  };
}
function receiptAuthorizationError(decision) { const error = new Error(decision?.auditReason || "receipt authorization denied"); error.code = decision?.code || "COLLAB_AUTHORIZATION_DENIED"; error.status = 403; return error; }
function defaultMessageService(database, objectService) { try { const raw = String(config.collaborationMessageKek || ""); const version = /^v(\d+)$/.exec(String(config.collaborationMessageKekVersion || "")); if (!version) return null; const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64"); if (key.length !== 32) return null; const current = Number(version[1]); const intent = createHash("sha256").update(`lily-collab-message-intent-v${current}`).update(key).digest(); return { service: createCollaborationMessageService({ objectService, repository: createKyselyMessageRepository(database), messageCrypto: createCollaborationMessageCrypto({ currentKekVersion: current, kekByVersion: { [current]: key } }), bodyIntentSigner: createHmacMessageBodyIntentSigner({ currentKeyVersion: current, keysByVersion: { [current]: intent } }) }), authorize: createLockedMessageAuthorizer() }; } catch { return null; } }

async function accountFor(request, reply, input, database = db) {
  const requestId = String(request.id || randomUUID());
  const authReply = { code(status) { return { send(body) { return reply.code(status).send({ ...body, retryable: false, requestId }); } }; } };
  const verified = await requireAccountSession(request, authReply, input, database);
  if (!verified) return null;
  const signed = await verifySignedDeviceRequest(request, input);
  if (!signed.ok) { reply.code(401).send({ ok: false, code: signed.code, retryable: false, requestId }); return null; }
  if (config.collaborationRolloutOrganizations.length > 0) {
    const memberships = await database.selectFrom("organization_members").select("organization_id").where("user_id", "=", verified.userId).where("status", "=", "active").execute();
    const eligible = memberships.some((member) => config.collaborationRolloutOrganizations.includes(String(member.organization_id)));
    if (!eligible) { reply.code(404).send({ ok: false, code: "COLLABORATION_UNAVAILABLE", retryable: false, requestId }); return null; }
  }
  return { userId: verified.userId, deviceId: verified.deviceId, requestId };
}

/** Versioned HTTP edge: parsing/auth/error mapping only; domain services own writes. */
export function registerCollaborationRoutes(app, options = {}) { const { database = db, syncService = createCollaborationSyncService({ db: database }), ticketService = createCollaborationWsTicketService({ db: database }), friendService = createCollaborationFriendService({ repository: createKyselyFriendRepository(database) }) } = options; const objectService = options.objectService || createConfiguredCollaborationObjectService({ database, config }); const defaults = options.messageService ? null : defaultMessageService(database, objectService); const messageService = options.messageService || defaults?.service || null; const authorizeMessage = options.authorizeMessage || defaults?.authorize || null; const authorizeReceipt = options.authorizeReceipt || authorizeMessage || createLockedMessageAuthorizer();
  const post = (path, schema, handler, { config: routeConfig = {}, ...routeOptions } = {}) => app.post(path, { ...routeOptions, config: routeConfig, schema: { tags: ["public:collaboration"], summary: `Collaboration ${path.split("/").at(-1)}`, body: zodBody(schema), response: { 200: okResponse() } } }, async (request, reply) => {
    const requestId = String(request.id || randomUUID());
    if (!config.collaborationEnabled || config.collaborationKillSwitch) return reply.code(503).send({ ok: false, code: "COLLABORATION_UNAVAILABLE", retryable: false, requestId });
    try { return await handler(request, reply, requestId); } catch (error) { return reply.code(error?.status === 403 || error?.code?.includes("DENIED") || error?.code?.includes("REVOKED") ? 403 : 400).send(errorBody(error, requestId)); }
  });
  post("/api/collaboration/v1/bootstrap", deviceBody, async (request, reply) => { const input = deviceBody.parse(request.body); const account = await accountFor(request, reply, input, database); if (!account) return; return reply.send({ ok: true, requestId: account.requestId, ...(await syncService.bootstrapCollaboration({ userId: account.userId, deviceId: input.deviceId })) }); });
  post("/api/collaboration/v1/sync", deviceBody.extend({ afterCursor: z.number().int().min(0), limit: z.number().int().min(1).max(2000).optional() }), async (request, reply) => { const input = z.object({ deviceId: z.string(), afterCursor: z.number().int().min(0), limit: z.number().int().min(1).max(2000).optional() }).parse(request.body); const account = await accountFor(request, reply, input, database); if (!account) return; return reply.send({ ok: true, requestId: account.requestId, ...(await syncService.syncAfterCursor({ userId: account.userId, deviceId: input.deviceId, afterCursor: input.afterCursor, limit: input.limit })) }); });
  post("/api/collaboration/v1/ack", commandBody.extend({ cursor: z.number().int().min(0), bootstrapCompletionToken: z.string().optional() }), async (request, reply) => { const input = z.object({ deviceId: z.string(), clientCommandId: z.string(), cursor: z.number().int().min(0), bootstrapCompletionToken: z.string().optional() }).parse(request.body); const account = await accountFor(request, reply, input, database); if (!account) return; return reply.send({ ok: true, requestId: account.requestId, ...(await syncService.ackDeviceCursor({ userId: account.userId, deviceId: input.deviceId, cursor: input.cursor, bootstrapCompletionToken: input.bootstrapCompletionToken })) }); });
  post("/api/collaboration/v1/command-receipt", commandBody.extend({ commandType: z.enum(["message.create", "message.edit", "message.revoke"]), expectedConversationId: z.string().min(1).max(200), expectedMessageId: z.string().min(1).max(200).optional(), expectedRevision: z.number().int().positive().optional() }), async (request, reply) => {
    const input = commandBody.extend({ commandType: z.enum(["message.create", "message.edit", "message.revoke"]), expectedConversationId: z.string().min(1).max(200), expectedMessageId: z.string().min(1).max(200).optional(), expectedRevision: z.number().int().positive().optional() }).parse(request.body);
    const account = await accountFor(request, reply, input, database); if (!account) return;
    const response = await database.transaction().execute(async (trx) => {
      // JWT/device signatures are necessary but insufficient: a device id can
      // be re-used after account changes. Lock its active account binding
      // before even reporting an unknown/pending receipt state.
      const device = await trx.selectFrom("user_devices").select("device_id")
        .where("user_id", "=", account.userId).where("device_id", "=", account.deviceId).where("status", "=", "active").forUpdate().executeTakeFirst();
      if (!device) throw receiptAuthorizationError({ code: "COLLAB_DEVICE_REVOKED", auditReason: "device-inactive" });
      const receipt = await trx.selectFrom("command_receipts").select(["state", "result_event_id", "response_payload"])
        .where("actor_device_id", "=", account.deviceId).where("command_type", "=", input.commandType)
        .where("client_command_id", "=", input.clientCommandId).executeTakeFirst();
      if (!receipt || receipt.state !== "completed" || !receipt.result_event_id) return { state: "unknown", committed: false, deliveryUnknown: true };
      // The event is the sole authority for the conversation. Never use an
      // untrusted request value or stale receipt payload to choose scope.
      const event = await trx.selectFrom("collaboration_events").select(["conversation_id", "actor_user_id", "actor_device_id", "payload", "seq"])
        .where("id", "=", receipt.result_event_id).executeTakeFirst();
      if (!event?.conversation_id) return { state: "unknown", committed: false, deliveryUnknown: true };
      assertCollaborationReceiptIdentity({ event, accountUserId: account.userId, expectedConversationId: input.expectedConversationId });
      if (event.actor_device_id != null && event.actor_device_id !== account.deviceId) throw receiptAuthorizationError({ code: "COLLAB_RECEIPT_IDENTITY_DENIED", auditReason: "receipt-device-mismatch" });
      const eventPayload = receiptPayload(event.payload);
      if (input.commandType !== "message.create" && (eventPayload?.messageId !== input.expectedMessageId || Number(eventPayload?.revision) !== Number(input.expectedRevision) + 1)) {
        throw receiptAuthorizationError({ code: "COLLAB_RECEIPT_IDENTITY_DENIED", auditReason: "receipt-target-mismatch" });
      }
      const decision = await authorizeReceipt({ trx, account, input: { conversationId: event.conversation_id }, action: "read" });
      if (!decision?.ok) throw receiptAuthorizationError(decision);
      return commandReceiptView(receipt, event, input.commandType);
    });
    return reply.send({ ok: true, requestId: account.requestId, ...response });
  });
  post("/api/collaboration/v1/ws-ticket", commandBody, async (request, reply) => { const input = commandBody.parse(request.body); const account = await accountFor(request, reply, input, database); if (!account) return; return reply.send({ ok: true, requestId: account.requestId, ...(await ticketService.issue({ userId: account.userId, deviceId: account.deviceId })) }); });
  post("/api/collaboration/v1/friends", commandBody.extend({ action: z.enum(["request", "respond", "remove", "block", "unblock"]), lilyId: z.string().optional(), requestId: z.string().optional(), accept: z.boolean().optional(), peerUserId: z.string().optional() }), async (request, reply) => { const input = commandBody.extend({ action: z.enum(["request", "respond", "remove", "block", "unblock"]), lilyId: z.string().optional(), requestId: z.string().optional(), accept: z.boolean().optional(), peerUserId: z.string().optional() }).parse(request.body); const account = await accountFor(request, reply, input, database); if (!account) return; const methods = { request: () => friendService.requestFriend({ account, clientCommandId: input.clientCommandId, lilyId: input.lilyId, ip: request.ip }), respond: () => friendService.respondToFriendRequest({ account, clientCommandId: input.clientCommandId, requestId: input.requestId, accept: input.accept }), remove: () => friendService.removeFriend({ account, clientCommandId: input.clientCommandId, peerUserId: input.peerUserId }), block: () => friendService.blockUser({ account, clientCommandId: input.clientCommandId, peerUserId: input.peerUserId }), unblock: () => friendService.unblockUser({ account, clientCommandId: input.clientCommandId, peerUserId: input.peerUserId }) }; return reply.send({ ok: true, requestId: account.requestId, ...(await methods[input.action]()) }); });
  post("/api/collaboration/v1/messages", messageCommandBody.extend({ action: z.enum(["send", "edit", "revoke", "read", "history"]), attachmentIds: z.array(z.string().min(1).max(200)).max(20).optional(), attachmentPurpose: z.enum(["attachment", "workspace"]).optional(), replyToMessageId: z.string().min(1).max(200).optional(), mentionUserIds: z.array(z.string().min(1).max(200)).max(1000).optional(), conversationId: z.string().min(1), messageId: z.string().optional(), messageIds: z.array(z.string().min(1).max(200)).min(1).max(200).optional(), bodyText: z.string().max(65536).optional(), expectedRevision: z.number().int().positive().optional(), seq: z.number().int().min(0).optional(), beforeSeq: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() }), async (request, reply) => {
    const input = messageCommandBody.extend({ action: z.enum(["send", "edit", "revoke", "read", "history"]), attachmentIds: z.array(z.string().min(1).max(200)).max(20).optional(), attachmentPurpose: z.enum(["attachment", "workspace"]).optional(), replyToMessageId: z.string().min(1).max(200).optional(), mentionUserIds: z.array(z.string().min(1).max(200)).max(1000).optional(), conversationId: z.string().min(1), messageId: z.string().optional(), messageIds: z.array(z.string().min(1).max(200)).min(1).max(200).optional(), bodyText: z.string().max(65536).optional(), expectedRevision: z.number().int().positive().optional(), seq: z.number().int().min(0).optional(), beforeSeq: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(request.body); const account = await accountFor(request, reply, input, database); if (!account) return;
    if (!messageService || typeof authorizeMessage !== "function") return reply.code(503).send({ ok: false, code: "COLLAB_MESSAGE_SERVICE_UNAVAILABLE", retryable: false, requestId: account.requestId });
    const common = { account, conversationId: input.conversationId, authorize: authorizeMessage, database };
    const result = input.action === "send" ? await messageService.sendMessage({ ...common, clientCommandId: input.clientCommandId, bodyText: input.bodyText, attachmentIds: input.attachmentIds, attachmentPurpose: input.attachmentPurpose, replyToMessageId: input.replyToMessageId, mentionUserIds: input.mentionUserIds })
      : input.action === "edit" ? await messageService.editMessage({ ...common, clientCommandId: input.clientCommandId, messageId: input.messageId, bodyText: input.bodyText, expectedRevision: input.expectedRevision })
        : input.action === "revoke" ? await messageService.revokeMessage({ ...common, clientCommandId: input.clientCommandId, messageId: input.messageId, expectedRevision: input.expectedRevision })
          : input.action === "read" ? await messageService.markConversationRead({ ...common, clientCommandId: input.clientCommandId, submittedSeq: input.seq })
          : await database.transaction().execute((trx) => messageService.listMessageHistory({ ...common, beforeSeq: input.beforeSeq, messageIds: input.messageIds, limit: input.limit, trx }));
    const historyResult = input.action === "history" && input.messageIds ? {
      messages: result, unavailableMessageIds: input.messageIds.filter((id) => !result.some((message) => message.id === id)),
    } : result;
    return reply.send({ ok: true, requestId: account.requestId, result: historyResult });
  });
  registerCollaborationConversationRoutes({ post, accountFor, database, conversationService: options.conversationService, projectionService: options.conversationProjectionService });
  registerCollaborationObjectRoutes({ post, accountFor, database, config, objectService });
  const unavailableObjectBody = commandBody.passthrough();
  const objectUnavailable = async (request, reply) => { const input = unavailableObjectBody.parse(request.body); const account = await accountFor(request, reply, input, database); if (!account) return; return reply.code(503).send({ ok: false, code: "COLLAB_OBJECTS_UNAVAILABLE", retryable: false, requestId: account.requestId }); };
  post("/api/collaboration/objects/init", unavailableObjectBody, objectUnavailable, objectRouteOptions);
  post("/api/collaboration/objects/:id/download-ticket", unavailableObjectBody, objectUnavailable, objectRouteOptions);
}
