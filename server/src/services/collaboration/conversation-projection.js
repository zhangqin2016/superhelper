import { createKyselyRepository } from "./sync-repository.js";
import { createLockedMessageAuthorizer } from "./message-repository.js";
import { buildBootstrapSnapshot } from "./sync-service.js";
import { sql } from "kysely";
import { createKyselyConversationRepository } from "./conversation-repository.js";

const unavailable = () => Object.assign(new Error("Conversation unavailable."), { code: "COLLAB_CONVERSATION_UNAVAILABLE", status: 403 });

/** Hydrate an unknown joined/created conversation without resetting sync. */
export function createCollaborationConversationProjectionService({ database, repository = createKyselyRepository(database), authorize = createLockedMessageAuthorizer(), conversationRepository = createKyselyConversationRepository(database) }) {
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
        // Exactly the recipient authority used by message.send, under these
        // same locks. Public Team candidates do not require a channel row.
        const candidateIds = [...new Set(await conversationRepository.activeConversationMemberIds(trx, conversationId))].sort();
        if (candidateIds.length > 1000) throw Object.assign(new Error("Mention candidate limit exceeded."), { code: "COLLAB_MENTION_CANDIDATES_LIMIT", status: 400 });
        const candidateProfiles = new Map((await repository.listBootstrapProfiles(trx, candidateIds)).map((profile) => [profile.user_id, profile]));
        const mentionCandidates = { status: "complete", items: candidateIds.map((userId) => {
          const profile = candidateProfiles.get(userId);
          return { userId, lilyId: profile?.lily_id ?? "", displayName: profile?.display_name ?? "", avatarObjectId: profile?.avatar_object_id ?? null };
        }) };
        const snapshot = buildBootstrapSnapshot({ conversations, members, profiles });
        return { conversation: snapshot.conversations[0], members, profiles, mentionCandidates };
      });
    },
  };
}
