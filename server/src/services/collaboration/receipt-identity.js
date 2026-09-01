import { CollaborationCommandError } from "./idempotency.js";

// The event supplies authority. The expected conversation is only an equality
// constraint, never a replacement authorization scope from the requester.
export function assertCollaborationReceiptIdentity({ event, accountUserId, expectedConversationId }) {
  if (!accountUserId || !expectedConversationId || event?.actor_user_id !== accountUserId || event?.conversation_id !== expectedConversationId) {
    throw new CollaborationCommandError("COLLAB_RECEIPT_IDENTITY_DENIED", "Receipt identity does not match the command owner.");
  }
}
