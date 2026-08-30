import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";

import { verifyAccessToken } from "../../services/account-auth.js";
import { verifySignedDeviceRequest } from "../../services/device-identity.js";
import { db } from "../../db.js";
import { createCollaborationSyncService } from "../../services/collaboration/sync-service.js";
import { createCollaborationWsTicketService } from "../../services/collaboration/ws-ticket.js";
import { createCollaborationFriendService, createKyselyFriendRepository } from "../../services/collaboration/friends.js";
import { config } from "../../config.js";
import { createCollaborationMessageService, createHmacMessageBodyIntentSigner } from "../../services/collaboration/messages.js";
import { createCollaborationMessageCrypto } from "../../services/collaboration/message-crypto.js";
import { createKyselyMessageRepository, createLockedMessageAuthorizer } from "../../services/collaboration/message-repository.js";

const deviceBody = z.object({ deviceId: z.string().min(1).max(120) });
const commandBody = deviceBody.extend({ clientCommandId: z.string().min(1).max(200) });
const errorBody = (error, requestId) => ({ ok: false, code: error?.code || "COLLABORATION_REQUEST_FAILED", retryable: error?.retryable === true, requestId });
function defaultMessageService(database) { try { const raw = String(config.collaborationMessageKek || ""); const version = /^v(\d+)$/.exec(String(config.collaborationMessageKekVersion || "")); if (!version) return null; const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64"); if (key.length !== 32) return null; const current = Number(version[1]); const intent = createHash("sha256").update(`lily-collab-message-intent-v${current}`).update(key).digest(); return { service: createCollaborationMessageService({ repository: createKyselyMessageRepository(database), messageCrypto: createCollaborationMessageCrypto({ currentKekVersion: current, kekByVersion: { [current]: key } }), bodyIntentSigner: createHmacMessageBodyIntentSigner({ currentKeyVersion: current, keysByVersion: { [current]: intent } }) }), authorize: createLockedMessageAuthorizer() }; } catch { return null; } }

async function accountFor(request, reply, input, database = db) {
  const requestId = String(request.id || randomUUID());
  const token = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || ""))?.[1] || "";
  const verified = verifyAccessToken(token);
  if (!verified.ok || verified.deviceId !== input.deviceId) {
    reply.code(401).send({ ok: false, code: "ACCESS_TOKEN_INVALID", retryable: false, requestId }); return null;
  }
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
export function registerCollaborationRoutes(app, options = {}) { const { database = db, syncService = createCollaborationSyncService({ db: database }), ticketService = createCollaborationWsTicketService({ db: database }), friendService = createCollaborationFriendService({ repository: createKyselyFriendRepository(database) }) } = options; const defaults = options.messageService ? null : defaultMessageService(database); const messageService = options.messageService || defaults?.service || null; const authorizeMessage = options.authorizeMessage || defaults?.authorize || null;
  const post = (path, schema, handler, { config: routeConfig = {} } = {}) => app.post(path, { config: routeConfig, schema: { tags: ["public:collaboration"], summary: `Collaboration ${path.split("/").at(-1)}`, body: zodBody(schema), response: { 200: okResponse() } } }, async (request, reply) => {
    const requestId = String(request.id || randomUUID());
    if (!config.collaborationEnabled || config.collaborationKillSwitch) return reply.code(503).send({ ok: false, code: "COLLABORATION_UNAVAILABLE", retryable: false, requestId });
    try { return await handler(request, reply, requestId); } catch (error) { return reply.code(error?.code?.includes("DENIED") || error?.code?.includes("REVOKED") ? 403 : 400).send(errorBody(error, requestId)); }
  });
  post("/api/collaboration/v1/bootstrap", deviceBody, async (request, reply) => { const input = deviceBody.parse(request.body); const account = await accountFor(request, reply, input); if (!account) return; return reply.send({ ok: true, requestId: account.requestId, ...(await syncService.bootstrapCollaboration({ userId: account.userId, deviceId: input.deviceId })) }); });
  post("/api/collaboration/v1/sync", deviceBody.extend({ afterCursor: z.number().int().min(0), limit: z.number().int().min(1).max(2000).optional() }), async (request, reply) => { const input = z.object({ deviceId: z.string(), afterCursor: z.number().int().min(0), limit: z.number().int().min(1).max(2000).optional() }).parse(request.body); const account = await accountFor(request, reply, input); if (!account) return; return reply.send({ ok: true, requestId: account.requestId, ...(await syncService.syncAfterCursor({ userId: account.userId, deviceId: input.deviceId, afterCursor: input.afterCursor, limit: input.limit })) }); });
  post("/api/collaboration/v1/ack", commandBody.extend({ cursor: z.number().int().min(0), bootstrapCompletionToken: z.string().optional() }), async (request, reply) => { const input = z.object({ deviceId: z.string(), clientCommandId: z.string(), cursor: z.number().int().min(0), bootstrapCompletionToken: z.string().optional() }).parse(request.body); const account = await accountFor(request, reply, input); if (!account) return; return reply.send({ ok: true, requestId: account.requestId, ...(await syncService.ackDeviceCursor({ userId: account.userId, deviceId: input.deviceId, cursor: input.cursor, bootstrapCompletionToken: input.bootstrapCompletionToken })) }); });
  post("/api/collaboration/v1/ws-ticket", commandBody, async (request, reply) => { const input = commandBody.parse(request.body); const account = await accountFor(request, reply, input); if (!account) return; return reply.send({ ok: true, requestId: account.requestId, ...(await ticketService.issue({ userId: account.userId, deviceId: account.deviceId })) }); });
  post("/api/collaboration/v1/friends", commandBody.extend({ action: z.enum(["request", "respond", "remove", "block", "unblock"]), lilyId: z.string().optional(), requestId: z.string().optional(), accept: z.boolean().optional(), peerUserId: z.string().optional() }), async (request, reply) => { const input = commandBody.extend({ action: z.enum(["request", "respond", "remove", "block", "unblock"]), lilyId: z.string().optional(), requestId: z.string().optional(), accept: z.boolean().optional(), peerUserId: z.string().optional() }).parse(request.body); const account = await accountFor(request, reply, input); if (!account) return; const methods = { request: () => friendService.requestFriend({ account, clientCommandId: input.clientCommandId, lilyId: input.lilyId, ip: request.ip }), respond: () => friendService.respondToFriendRequest({ account, clientCommandId: input.clientCommandId, requestId: input.requestId, accept: input.accept }), remove: () => friendService.removeFriend({ account, clientCommandId: input.clientCommandId, peerUserId: input.peerUserId }), block: () => friendService.blockUser({ account, clientCommandId: input.clientCommandId, peerUserId: input.peerUserId }), unblock: () => friendService.unblockUser({ account, clientCommandId: input.clientCommandId, peerUserId: input.peerUserId }) }; return reply.send({ ok: true, requestId: account.requestId, ...(await methods[input.action]()) }); });
  post("/api/collaboration/v1/messages", commandBody.extend({ action: z.enum(["send", "edit", "revoke", "history"]), conversationId: z.string().min(1), messageId: z.string().optional(), bodyText: z.string().max(65536).optional(), expectedRevision: z.number().int().positive().optional(), beforeSeq: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() }), async (request, reply) => {
    const input = commandBody.extend({ action: z.enum(["send", "edit", "revoke", "history"]), conversationId: z.string().min(1), messageId: z.string().optional(), bodyText: z.string().max(65536).optional(), expectedRevision: z.number().int().positive().optional(), beforeSeq: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(request.body); const account = await accountFor(request, reply, input); if (!account) return;
    if (!messageService || typeof authorizeMessage !== "function") return reply.code(503).send({ ok: false, code: "COLLAB_MESSAGE_SERVICE_UNAVAILABLE", retryable: false, requestId: account.requestId });
    const common = { account, conversationId: input.conversationId, authorize: authorizeMessage, database };
    const result = input.action === "send" ? await messageService.sendMessage({ ...common, clientCommandId: input.clientCommandId, bodyText: input.bodyText })
      : input.action === "edit" ? await messageService.editMessage({ ...common, clientCommandId: input.clientCommandId, messageId: input.messageId, bodyText: input.bodyText, expectedRevision: input.expectedRevision })
        : input.action === "revoke" ? await messageService.revokeMessage({ ...common, clientCommandId: input.clientCommandId, messageId: input.messageId, expectedRevision: input.expectedRevision })
          : await messageService.listMessageHistory({ ...common, beforeSeq: input.beforeSeq, limit: input.limit, trx: database });
    return reply.send({ ok: true, requestId: account.requestId, result });
  });
  const unavailableObjectBody = commandBody.passthrough();
  const objectUnavailable = async (request, reply) => { const input = unavailableObjectBody.parse(request.body); const account = await accountFor(request, reply, input); if (!account) return; return reply.code(503).send({ ok: false, code: "COLLAB_OBJECTS_UNAVAILABLE", retryable: false, requestId: account.requestId }); };
  post("/api/collaboration/objects/init", unavailableObjectBody, objectUnavailable, { config: { redact: ["body.dek", "body.wrappedDek", "body.token"] } });
  post("/api/collaboration/objects/:id/download-ticket", unavailableObjectBody, objectUnavailable, { config: { redact: ["body.token", "response.ticket"] } });
}
