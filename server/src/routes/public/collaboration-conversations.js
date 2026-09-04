import { z } from "zod";
import { createCollaborationConversationService } from "../../services/collaboration/conversations.js";
import { createKyselyConversationRepository } from "../../services/collaboration/conversation-repository.js";
import { createCollaborationConversationProjectionService } from "../../services/collaboration/conversation-projection.js";

const id = z.string().min(1).max(200).regex(/^[^\x00-\x20\x7f]+$/);
const command = { deviceId: id.max(120), clientCommandId: id };
const create = { ...command, action: z.literal("create"), title: z.string().max(200).optional() };
// Closed variants reject forged authority and invalid scope combinations.
export const conversationCommandBody = z.union([
  z.object({ ...create, scopeType: z.literal("personal"), kind: z.literal("group"), memberUserIds: z.array(id).max(200).optional() }).strict(),
  z.object({ ...create, scopeType: z.literal("organization"), organizationId: id, kind: z.literal("direct"), memberUserIds: z.array(id).min(1).max(2) }).strict(),
  z.object({ ...create, scopeType: z.literal("organization"), organizationId: id, kind: z.literal("channel"), visibility: z.literal("public"), memberUserIds: z.array(id).max(0).optional() }).strict(),
  z.object({ ...create, scopeType: z.literal("organization"), organizationId: id, kind: z.literal("channel"), visibility: z.literal("private"), memberUserIds: z.array(id).max(500).optional() }).strict(),
  z.object({ ...command, action: z.literal("member"), conversationId: id, targetUserId: id, operation: z.enum(["add", "remove"]) }).strict(),
  z.object({ ...command, action: z.literal("member"), conversationId: id, targetUserId: id, operation: z.literal("role"), role: z.enum(["admin", "member"]) }).strict(),
  z.object({ ...command, action: z.literal("dissolve"), conversationId: id }).strict(),
]);
export const conversationGetBody = z.object({ deviceId: id.max(120), conversationId: id }).strict();

/** Reuse the parent route's account/signature/rollout and error boundary. */
export function registerCollaborationConversationRoutes({ post, accountFor, database, conversationService = createCollaborationConversationService({ repository: createKyselyConversationRepository(database) }), projectionService = createCollaborationConversationProjectionService({ database }) }) {
  post("/api/collaboration/v1/conversations", conversationCommandBody, async (request, reply) => {
    const input = conversationCommandBody.parse(request.body);
    const account = await accountFor(request, reply, input, database); if (!account) return;
    const { deviceId, action, ...commandInput } = input;
    const result = action === "create" ? await conversationService.createConversation({ account, ...commandInput })
      : action === "dissolve" ? await conversationService.dissolveConversation({ account, ...commandInput })
      : await conversationService.mutateMember({ account, ...commandInput });
    return reply.send({ ok: true, requestId: account.requestId, result });
  });
  post("/api/collaboration/v1/conversations/get", conversationGetBody, async (request, reply) => {
    const input = conversationGetBody.parse(request.body);
    const account = await accountFor(request, reply, input, database); if (!account) return;
    return reply.send({ ok: true, requestId: account.requestId, result: await projectionService.getConversation({ account, conversationId: input.conversationId }) });
  });
}
