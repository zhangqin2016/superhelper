"use strict";

const { CREATE } = require("./message-mutation-outbox");

/** Sync may only reconcile an optimistic create; mutation receipts are typed. */
function settleCreatedSyncEvent(store, event) {
  const command = event?.clientCommandId ?? event?.client_command_id ?? event?.payload?.clientCommandId ?? event?.payload?.client_command_id;
  if (!command || event?.type !== "message.created" || (event?.actorUserId ?? event?.actor_user_id) !== store.accountId) return;
  const intent = store.getOutbox({ outboxId: String(command) });
  if (intent?.commandType !== CREATE) return;
  if (intent.conversationId !== (event.conversationId ?? event.conversation_id)) throw new Error("collaboration store: command conversation mismatch");
  store._settleOptimisticCommand({ clientCommandId: String(command), event });
}

module.exports = { settleCreatedSyncEvent };
