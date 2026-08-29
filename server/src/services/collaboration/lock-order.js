// Every collaboration write uses this module for row locks. The fixed order is
// authorization (organization, friendship) -> conversation -> message/object
// -> user_sync_state. Sorting prevents two otherwise identical writes from
// acquiring rows in opposite orders.

function orderedUniqueIds(values) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(source.map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

export function canonicalFriendshipPair(userA, userB) {
  const ids = [String(userA || "").trim(), String(userB || "").trim()];
  if (!ids[0] || !ids[1] || ids[0] === ids[1]) {
    throw new Error("Friendship users must be distinct non-empty identifiers.");
  }
  ids.sort();
  return { lowUserId: ids[0], highUserId: ids[1], key: `${ids[0]}:${ids[1]}` };
}

function orderedFriendshipPairs(pairs) {
  const source = Array.isArray(pairs) ? pairs : [];
  const normalized = source.map((pair) => {
    if (Array.isArray(pair)) return canonicalFriendshipPair(pair[0], pair[1]);
    return canonicalFriendshipPair(pair?.lowUserId ?? pair?.userA, pair?.highUserId ?? pair?.userB);
  });
  return [...new Map(normalized.map((pair) => [pair.key, pair])).values()].sort((left, right) => left.key.localeCompare(right.key));
}

function orderedMemberships(memberships) {
  const source = Array.isArray(memberships) ? memberships : [];
  const normalized = source
    .map((membership) => ({
      organizationId: String(membership?.organizationId || "").trim(),
      userId: String(membership?.userId || "").trim(),
    }))
    .filter((membership) => membership.organizationId && membership.userId);
  return [...new Map(normalized.map((membership) => [`${membership.organizationId}:${membership.userId}`, membership])).values()]
    .sort((left, right) => `${left.organizationId}:${left.userId}`.localeCompare(`${right.organizationId}:${right.userId}`));
}

/** Return the canonical lock order without issuing database calls. */
export function orderCollaborationLocks(scope = {}) {
  const blockPairs = orderedFriendshipPairs(scope.blockPairs);
  return {
    organizationIds: orderedUniqueIds(scope.organizationIds),
    friendshipPairs: orderedFriendshipPairs(scope.friendshipPairs),
    blockPairs,
    // These rows always exist, unlike user_blocks. Locking the canonical pair
    // serializes a first block with concurrent send/download authorization.
    blockUserIds: orderedUniqueIds(blockPairs.flatMap((pair) => [pair.lowUserId, pair.highUserId])),
    conversationId: String(scope.conversationId || "").trim() || null,
    messageIds: orderedUniqueIds(scope.messageIds),
    objectIds: orderedUniqueIds(scope.objectIds),
    userIds: orderedUniqueIds(scope.userIds),
    organizationMemberships: orderedMemberships(scope.organizationMemberships),
    conversationMemberUserIds: orderedUniqueIds(scope.conversationMemberUserIds),
  };
}

function assertTransaction(trx) {
  if (!trx || typeof trx.selectFrom !== "function") throw new TypeError("A Kysely transaction is required for collaboration row locks.");
}

async function lockByIds(trx, table, column, ids) {
  if (ids.length === 0) return [];
  return trx.selectFrom(table).selectAll().where(column, "in", ids).orderBy(column, "asc").forUpdate().execute();
}

/**
 * Lock all authorization and entity rows in the global order. Callers retain
 * the returned rows to build a server-derived authorization context; no route
 * may replace those facts with a client-supplied role or membership flag.
 */
export async function lockAuthorizationRows(trx, scope = {}) {
  assertTransaction(trx);
  const ordered = orderCollaborationLocks(scope);
  const rows = {
    organization: await lockByIds(trx, "organizations", "id", ordered.organizationIds),
    organizationMembership: [],
    friendship: [],
    blockUsers: [],
    block: [],
    conversation: [],
    conversationMembership: [],
    message: [],
    object: [],
    order: ["organization", "organizationMembership", "friendship", "blockUsers", "block", "conversation", "conversationMembership", "message", "object"],
  };

  if (ordered.organizationMemberships.length > 0) {
    rows.organizationMembership = await trx.selectFrom("organization_members").selectAll().where((eb) => eb.or(
      ordered.organizationMemberships.map((membership) => eb.and([
        eb("organization_id", "=", membership.organizationId),
        eb("user_id", "=", membership.userId),
      ])),
    )).orderBy("organization_id", "asc").orderBy("user_id", "asc").forUpdate().execute();
  }

  if (ordered.friendshipPairs.length > 0) {
    rows.friendship = await trx.selectFrom("friendships").selectAll().where((eb) => eb.or(
      ordered.friendshipPairs.map((pair) => eb.and([
        eb("user_low_id", "=", pair.lowUserId),
        eb("user_high_id", "=", pair.highUserId),
      ])),
    )).orderBy("user_low_id", "asc").orderBy("user_high_id", "asc").forUpdate().execute();
  }
  if (ordered.blockPairs.length > 0) {
    rows.blockUsers = await lockByIds(trx, "users", "id", ordered.blockUserIds);
    rows.block = await trx.selectFrom("user_blocks").selectAll().where((eb) => eb.or(
      ordered.blockPairs.flatMap((pair) => [
        eb.and([eb("blocker_user_id", "=", pair.lowUserId), eb("blocked_user_id", "=", pair.highUserId)]),
        eb.and([eb("blocker_user_id", "=", pair.highUserId), eb("blocked_user_id", "=", pair.lowUserId)]),
      ]),
    )).orderBy("blocker_user_id", "asc").orderBy("blocked_user_id", "asc").forUpdate().execute();
  }
  if (ordered.conversationId) {
    rows.conversation = await trx.selectFrom("conversations").selectAll().where("id", "=", ordered.conversationId).orderBy("id", "asc").forUpdate().execute();
  }
  if (ordered.conversationId && ordered.conversationMemberUserIds.length > 0) {
    rows.conversationMembership = await trx.selectFrom("conversation_members").selectAll()
      .where("conversation_id", "=", ordered.conversationId)
      .where("user_id", "in", ordered.conversationMemberUserIds)
      .orderBy("conversation_id", "asc").orderBy("user_id", "asc").forUpdate().execute();
  }
  rows.message = await lockByIds(trx, "messages", "id", ordered.messageIds);
  // stored_objects is introduced with attachment support. Keeping its lock
  // here establishes the same order before that feature starts issuing writes.
  rows.object = await lockByIds(trx, "stored_objects", "id", ordered.objectIds);
  return rows;
}

/** Lock per-user sync cursors last, sorted by immutable user id. */
export async function lockSyncStates(trx, userIds) {
  assertTransaction(trx);
  const ordered = orderedUniqueIds(userIds);
  return lockByIds(trx, "user_sync_state", "user_id", ordered);
}
