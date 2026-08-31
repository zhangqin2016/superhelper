import { createKyselyRepository } from "./sync-repository.js";
import { createLockedMessageAuthorizer } from "./message-repository.js";
import { buildBootstrapSnapshot } from "./sync-service.js";
import { sql } from "kysely";

const unavailable = () => Object.assign(new Error("Conversation unavailable."), { code: "COLLAB_CONVERSATION_UNAVAILABLE", status: 403 });

/** Hydrate an unknown joined/created conversation without resetting sync. */
export function createCollaborationConversationProjectionService({ database, repository = createKyselyRepository(database), authorize = createLockedMessageAuthorizer() }) {
  return {
    async getConversation({ account, conversationId }) {
      // Authorization and projection share the ordinary Device -> Organization
      // -> Conversation locks. Audit rights never substitute for read rights.
      return repository.withWriteTransaction(async (trx) => {
        await sql`set local lock_timeout = '2s'`.execute(trx);
        await sql`set local statement_timeout = '8s'`.execute(trx);
        const permission = await authorize({ trx, account, input: { conversationId }, action: "read" });
        if (!permission?.ok) throw unavailable();
        const conversations = await repository.listBootstrapConversations(trx, account.userId, conversationId);
        if (conversations.length !== 1) throw unavailable();
        const members = await repository.listBootstrapConversationMembers(trx, [conversationId]);
        const profiles = await repository.listBootstrapProfiles(trx, [...new Set([account.userId, ...members.map((member) => member.user_id)])].sort());
        const snapshot = buildBootstrapSnapshot({ conversations, members, profiles });
        return { conversation: snapshot.conversations[0], members, profiles };
      });
    },
  };
}
