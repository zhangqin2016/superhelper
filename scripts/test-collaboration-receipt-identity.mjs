import assert from "node:assert/strict";
import { assertCollaborationReceiptIdentity } from "../server/src/services/collaboration/receipt-identity.js";
const event = { actor_user_id: "alice", conversation_id: "actual" };
assert.doesNotThrow(() => assertCollaborationReceiptIdentity({ event, accountUserId: "alice", expectedConversationId: "actual" }));
for (const input of [
  { event, accountUserId: "bob", expectedConversationId: "actual" },
  { event, accountUserId: "alice", expectedConversationId: "another" },
  { event: {}, accountUserId: "alice", expectedConversationId: "actual" },
]) assert.throws(() => assertCollaborationReceiptIdentity(input), (error) => error.code === "COLLAB_RECEIPT_IDENTITY_DENIED");
console.log("collaboration receipt actor/conversation binding passed");
