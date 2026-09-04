import { sql } from "kysely";
import { authorizeCollaborationAction } from "./authorization.js";
import { canonicalFriendshipPair, lockAuthorizationRows } from "./lock-order.js";

const deny = (code) => ({ ok: false, code, auditReason: code.toLowerCase(), retryable: false });
function requireId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError("Collaboration id is invalid.");
  return value.trim();
}
function conversationView(row) {
  return row && { id: row.id, scopeType: row.scope_type, organizationId: row.organization_id, kind: row.kind, visibility: row.visibility, status: row.status, title: row.title };
}

export function createKyselyConversationRepository(database) {
  if (!database?.transaction) throw new TypeError("A Kysely database is required.");
  async function lockDevice(trx, account) {
    const device = await trx.selectFrom("user_devices").select("device_id").where("user_id", "=", account.userId).where("device_id", "=", account.deviceId).where("status", "=", "active").forUpdate().executeTakeFirst();
    return device ? { ok: true } : deny("COLLAB_DEVICE_REVOKED");
  }
  async function lockTeamScope(trx, organizationId) {
    // The organization row serializes roster changes, including absent member
    // rows. All enterprise mutation entry points must take this same lock.
    const rows = await lockAuthorizationRows(trx, { organizationIds: [organizationId] });
    const organizationMembers = rows.organization[0] ? await trx.selectFrom("organization_members").selectAll().where("organization_id", "=", organizationId).orderBy("user_id", "asc").forUpdate().execute() : [];
    return { organization: rows.organization[0], organizationMembers };
  }
  async function lockConversationContext(trx, { actorUserId, conversationId }) {
    // Only immutable routing fields are read optimistically. No permission is
    // granted until the row is locked and its routing fields match the hint.
    const hint = await trx.selectFrom("conversations").selectAll().where("id", "=", conversationId).executeTakeFirst();
    if (!hint) return { decision: deny("COLLAB_CONVERSATION_UNAVAILABLE") };
    const team = hint.scope_type === "organization" ? await lockTeamScope(trx, hint.organization_id) : {};
    const direct = hint.kind === "direct";
    const pair = direct ? [hint.direct_user_low_id, hint.direct_user_high_id] : null;
    const locks = await lockAuthorizationRows(trx, {
      friendshipPairs: direct && hint.scope_type === "personal" ? [pair] : [],
      blockPairs: direct ? [pair] : [], conversationId,
    });
    const row = locks.conversation[0];
    if (!row || ["scope_type", "organization_id", "kind", "direct_user_low_id", "direct_user_high_id"].some((key) => row[key] !== hint[key]) || row.status !== "active") return { decision: deny("COLLAB_CONVERSATION_UNAVAILABLE") };
    const members = await trx.selectFrom("conversation_members").selectAll().where("conversation_id", "=", conversationId).orderBy("user_id", "asc").forUpdate().execute();
    const membership = members.find((entry) => entry.user_id === actorUserId);
    const peer = pair?.find((id) => id !== actorUserId);
    return {
      actorUserId, conversation: conversationView(row), row, members, ...team,
      authorization: {
        conversationMembership: membership,
        organizationStatus: team.organization?.status,
        organizationMembership: team.organizationMembers?.find((entry) => entry.user_id === actorUserId),
        peerOrganizationMembershipStatus: team.organizationMembers?.find((entry) => entry.user_id === peer)?.status,
        friendshipStatus: locks.friendship[0]?.status, blocked: locks.block.length > 0,
      },
    };
  }
  async function authorizeAction({ trx, account, input, action = "send" }) {
    const device = await lockDevice(trx, account);
    if (!device.ok) return device;
    const context = await lockConversationContext(trx, { actorUserId: account.userId, conversationId: input.conversationId });
    if (context.decision) return context.decision;
    const decision = authorizeCollaborationAction(context, action);
    return decision.ok ? { ...decision, visibleAfterSeq: context.conversation.visibility === "public" ? 0 : Number(context.authorization.conversationMembership?.joined_seq || 0) } : decision;
  }
  async function activeConversationMemberIds(trx, input) {
    const conversationId = typeof input === "string" ? input : input.conversationId;
    const conversation = await trx.selectFrom("conversations").selectAll().where("id", "=", conversationId).executeTakeFirst();
    if (!conversation || conversation.status !== "active") return [];
    if (conversation.scope_type === "organization") {
      let query = trx.selectFrom("organization_members as om").innerJoin("organizations as o", "o.id", "om.organization_id").select("om.user_id")
        .where("om.organization_id", "=", conversation.organization_id).where("om.status", "=", "active").where("o.status", "=", "active");
      if (conversation.visibility !== "public") query = query.innerJoin("conversation_members as cm", "cm.user_id", "om.user_id").where("cm.conversation_id", "=", conversationId).where("cm.status", "=", "active");
      return (await query.orderBy("om.user_id", "asc").execute()).map((row) => row.user_id);
    }
    return (await trx.selectFrom("conversation_members").select("user_id").where("conversation_id", "=", conversationId).where("status", "=", "active").orderBy("user_id", "asc").execute()).map((row) => row.user_id);
  }
  return Object.freeze({ database, requireId, lockDevice, lockTeamScope, lockConversationContext, authorizeAction, activeConversationMemberIds,
    async findUsers(trx, ids) { return (await trx.selectFrom("users").select("id").where("id", "in", ids).execute()).map((row) => row.id); },
    async findTeamDirect(trx, organizationId, userIds) {
      const pair = canonicalFriendshipPair(...userIds);
      return trx.selectFrom("conversations").selectAll().where("organization_id", "=", organizationId).where("kind", "=", "direct").where("direct_pair_key", "=", pair.key).where("status", "=", "active").forUpdate().executeTakeFirst();
    },
    async insertConversation(trx, input) {
      const pair = input.kind === "direct" ? canonicalFriendshipPair(...input.memberUserIds) : null;
      return trx.insertInto("conversations").values({ id: input.id, scope_type: input.scopeType, organization_id: input.organizationId, kind: input.kind, visibility: input.visibility, title: input.title, created_by: input.actorUserId, direct_pair_key: pair?.key ?? null, direct_user_low_id: pair?.lowUserId ?? null, direct_user_high_id: pair?.highUserId ?? null }).returningAll().executeTakeFirstOrThrow();
    },
    async addMember(trx, { conversationId, userId, role = "member", joinedSeq }) {
      await trx.insertInto("conversation_members").values({ conversation_id: conversationId, user_id: userId, role, status: "active", joined_seq: joinedSeq })
        .onConflict((conflict) => conflict.columns(["conversation_id", "user_id"]).doUpdateSet({ status: "active", role, joined_seq: joinedSeq, joined_at: sql`now()`, left_at: null })).execute();
    },
    async changeMember(trx, { conversationId, userId, operation, role, status }) {
      const patch = operation === "remove" ? { status: status || "removed", left_at: sql`now()` } : { role };
      await trx.updateTable("conversation_members").set(patch).where("conversation_id", "=", conversationId).where("user_id", "=", userId).execute();
    },
    async archiveConversation(trx, conversationId) {
      await trx.updateTable("conversations").set({ status: "archived" }).where("id", "=", conversationId).execute();
    },
    async removeAllMembers(trx, conversationId) {
      await trx.updateTable("conversation_members").set({ status: "removed", left_at: sql`now()` }).where("conversation_id", "=", conversationId).where("status", "=", "active").execute();
    },
    async disableTeamMember(trx, organizationId, userId) {
      await trx.updateTable("organization_members").set({ status: "disabled" }).where("organization_id", "=", organizationId).where("user_id", "=", userId).execute();
    },
  });
}
