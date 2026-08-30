import { randomUUID } from "node:crypto";
import { sql } from "kysely";

import { canonicalFriendshipPair } from "./lock-order.js";
import { runCollaborationCommand } from "./command-runner.js";

const LILY_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

function commandError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function requiredId(value, label) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${label} is required.`);
  return id;
}

function accountIdentity(account) {
  return {
    userId: requiredId(account?.userId ?? account?.user_id ?? account?.id, "Account user id"),
    deviceId: requiredId(account?.deviceId ?? account?.device_id, "Account device id"),
  };
}

function lilyId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!LILY_ID_RE.test(normalized)) throw commandError("COLLAB_FRIEND_TARGET_UNAVAILABLE", "The requested contact is unavailable.");
  return normalized;
}

function unavailableTarget() {
  return commandError("COLLAB_FRIEND_TARGET_UNAVAILABLE", "The requested contact is unavailable.");
}

function requireRepositoryMethod(repository, method) {
  if (typeof repository?.[method] !== "function") {
    throw new TypeError(`Collaboration friend repository must implement ${method}().`);
  }
  return repository[method].bind(repository);
}

function profileView(profile) {
  return {
    userId: requiredId(profile?.userId ?? profile?.user_id, "Profile user id"),
    lilyId: lilyId(profile?.lilyId ?? profile?.lily_id),
    displayName: String(profile?.displayName ?? profile?.display_name ?? ""),
    avatarObjectId: profile?.avatarObjectId ?? profile?.avatar_object_id ?? null,
  };
}

function responseForActive({ requestId = null, friendship, conversation }) {
  return {
    status: "active",
    requestId,
    friendship: {
      userLowId: friendship.userLowId ?? friendship.user_low_id,
      userHighId: friendship.userHighId ?? friendship.user_high_id,
      status: friendship.status,
    },
    conversationId: requiredId(conversation?.id, "Direct conversation id"),
  };
}

/**
 * In-memory sliding-window limiter with independent sender, receiver, device
 * and IP buckets. Production callers may inject the same `consume` contract
 * backed by Redis; the domain code never treats a missing bucket as permission.
 */
export function createFriendRequestRateLimiter({ limit = 20, windowMs = 60_000, now = () => Date.now() } = {}) {
  const buckets = new Map();
  const max = Math.max(1, Math.min(Number(limit) || 20, 500));
  const window = Math.max(1_000, Math.min(Number(windowMs) || 60_000, 24 * 60 * 60 * 1_000));
  const consumeKey = (key, timestamp) => {
    const active = (buckets.get(key) || []).filter((value) => value > timestamp - window);
    if (active.length >= max) return false;
    active.push(timestamp);
    buckets.set(key, active);
    return true;
  };
  return Object.freeze({
    consume({ senderUserId, receiverUserId, deviceId, ip } = {}) {
      const timestamp = Number(now());
      if (!Number.isFinite(timestamp)) return { ok: false, code: "COLLAB_FRIEND_RATE_LIMITED" };
      const values = [
        ["sender", requiredId(senderUserId, "Friend request sender user id")],
        ["receiver", requiredId(receiverUserId, "Friend request receiver user id")],
        ["device", requiredId(deviceId, "Friend request device id")],
        ["ip", requiredId(ip, "Friend request IP")],
      ];
      // Check all buckets before consuming any, avoiding a denied request
      // poisoning another dimension's counter.
      for (const [dimension, id] of values) {
        const active = (buckets.get(`${dimension}:${id}`) || []).filter((value) => value > timestamp - window);
        buckets.set(`${dimension}:${id}`, active);
        if (active.length >= max) return { ok: false, code: "COLLAB_FRIEND_RATE_LIMITED" };
      }
      for (const [dimension, id] of values) consumeKey(`${dimension}:${id}`, timestamp);
      return { ok: true };
    },
  });
}

/** PostgreSQL adapter: every relation transition and receipt is one transaction. */
export function createKyselyFriendRepository(db) {
  if (!db || typeof db.transaction !== "function") throw new TypeError("A Kysely database is required for collaboration friends.");
  const pair = (userId, peerUserId) => canonicalFriendshipPair(userId, peerUserId);
  const activeDirect = async (trx, key) => trx.selectFrom("conversations").selectAll()
    .where("scope_type", "=", "personal").where("kind", "=", "direct").where("direct_pair_key", "=", key)
    .orderBy("created_at", "asc").forUpdate().executeTakeFirst();
  const ensureActiveMembers = async (trx, conversationId, userIds) => {
    for (const userId of userIds) {
      await trx.insertInto("conversation_members").values({ conversation_id: conversationId, user_id: userId, status: "active", role: "member", joined_seq: 0, last_read_seq: 0 })
        .onConflict((conflict) => conflict.columns(["conversation_id", "user_id"]).doUpdateSet({ status: "active", left_at: null })).execute();
    }
  };
  const relationshipPlan = ({ account, commandType, input, response }) => {
    const { noEvent = false, ...safeResponse } = response || {};
    if (noEvent) return { noEvent: true, event: { id: `noop_${randomUUID()}` }, response: safeResponse, project: async () => {} };
    let peerUserId = response?.profile?.userId ?? response?.peerUserId ?? input?.peerUserId ?? null;
    if (!peerUserId && response?.friendship?.userLowId) {
      peerUserId = response.friendship.userLowId === account.userId
        ? response.friendship.userHighId
        : response.friendship.userLowId;
    }
    const recipients = [...new Set([account.userId, peerUserId].filter(Boolean))].sort();
    if (recipients.length === 0) throw new Error("A relationship command requires recipients.");
    const conversationId = response?.conversationId || null;
    const participantUserIds = [...new Set([account.userId, peerUserId].filter(Boolean))].sort();
    const profilesByUserId = Object.fromEntries((response?.profiles || response?.profile ? (response.profiles || [response.profile]) : [])
      .filter(Boolean).map((profile) => [profile.userId, { userId: profile.userId, lilyId: profile.lilyId, displayName: profile.displayName, avatarObjectId: profile.avatarObjectId ?? null }]));
    const eventType = commandType === "friend.request" ? (response?.status === "active" ? "friend.accepted" : "friend.requested")
      : commandType === "friend.respond" ? (response?.status === "active" ? "friend.accepted" : "friend.declined")
        : commandType === "friend.remove" ? "friend.removed"
          : commandType === "user.block" ? "user.blocked" : "user.unblocked";
    return {
      event: {
      id: `evt_${randomUUID()}`, conversationId, type: eventType,
      actorUserId: account.userId, actorDeviceId: account.deviceId, clientCommandId: input.clientCommandId || commandType,
      payload: {
        scope: "relationship", participantUserIds, profilesByUserId, status: response?.status || "completed", requestId: response?.requestId || null,
        // A recipient who only sees sync (not the accepting HTTP response)
        // can materialize/open this canonical direct without guessing a pair.
        directConversation: conversationId ? { id: conversationId, scopeType: "personal", kind: "direct", participantUserIds } : null,
      },
      },
      recipientUserIds: recipients,
      response: safeResponse,
      project: async () => {},
    };
  };
  return Object.freeze({
    async runCommand({ account, commandType, clientCommandId, input, prepareProjection, mutate }) {
      const actor = accountIdentity(account);
      const type = requiredId(commandType, "Friend command type");
      const commandId = requiredId(clientCommandId, "Client command id");
      return runCollaborationCommand({
        account: actor, commandType: type, clientCommandId: commandId, input, database: db,
        authorize: async ({ trx }) => {
          const device = await trx.selectFrom("user_devices").select("device_id").where("user_id", "=", actor.userId).where("device_id", "=", actor.deviceId).where("status", "=", "active").forUpdate().executeTakeFirst();
          return device ? { ok: true } : { ok: false, code: "COLLAB_DEVICE_REVOKED", auditReason: "device-inactive" };
        },
        prepareProjection: async ({ trx }) => (typeof prepareProjection === "function" ? prepareProjection(trx) : null),
        project: async ({ trx, preparation }) => {
          const response = await mutate(trx, preparation);
          return relationshipPlan({ account: actor, commandType: type, input: { ...input, clientCommandId: commandId }, response });
        },
      });
    },
    async lockPair(trx, userId, peerUserId) {
      const normalized = pair(userId, peerUserId);
      // Advisory locking serializes absent-row transitions too (crossed first
      // requests and first direct creation have no row a FOR UPDATE can lock).
      await sql`select pg_advisory_xact_lock(hashtext(${normalized.key}))`.execute(trx);
    },
    async findProfileByLilyId(trx, normalizedLilyId) {
      return (trx || db).selectFrom("user_profiles").selectAll().where("lily_id", "=", normalizedLilyId).executeTakeFirst();
    },
    async findProfileByUserId(trx, userId) { return trx.selectFrom("user_profiles").selectAll().where("user_id", "=", userId).executeTakeFirst(); },
    async findRequest(trx, senderUserId, receiverUserId) {
      return trx.selectFrom("friend_requests").selectAll().where("sender_user_id", "=", senderUserId).where("receiver_user_id", "=", receiverUserId).where("status", "=", "pending").forUpdate().executeTakeFirst();
    },
    async findRequestById(trx, id) {
      return trx.selectFrom("friend_requests").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
    },
    async createRequest(trx, request) {
      return trx.insertInto("friend_requests").values({ id: request.id, sender_user_id: request.senderUserId, receiver_user_id: request.receiverUserId, status: request.status, message: request.message }).returningAll().executeTakeFirstOrThrow();
    },
    async resolveRequest(trx, id, status) {
      return trx.updateTable("friend_requests").set({ status, responded_at: sql`now()` }).where("id", "=", id).where("status", "=", "pending").returningAll().executeTakeFirst();
    },
    async isBlocked(trx, userId, peerUserId) {
      return Boolean(await (trx || db).selectFrom("user_blocks").select("blocker_user_id").where((eb) => eb.or([
        eb.and([eb("blocker_user_id", "=", userId), eb("blocked_user_id", "=", peerUserId)]),
        eb.and([eb("blocker_user_id", "=", peerUserId), eb("blocked_user_id", "=", userId)]),
      ])).executeTakeFirst());
    },
    async friendship(trx, userId, peerUserId) {
      const normalized = pair(userId, peerUserId);
      return trx.selectFrom("friendships").selectAll().where("user_low_id", "=", normalized.lowUserId).where("user_high_id", "=", normalized.highUserId).forUpdate().executeTakeFirst();
    },
    async upsertFriendship(trx, userId, peerUserId) {
      const normalized = pair(userId, peerUserId);
      return trx.insertInto("friendships").values({ user_low_id: normalized.lowUserId, user_high_id: normalized.highUserId, status: "active" })
        .onConflict((conflict) => conflict.columns(["user_low_id", "user_high_id"]).doUpdateSet({ status: "active", updated_at: sql`now()` })).returningAll().executeTakeFirstOrThrow();
    },
    async removeFriendship(trx, userId, peerUserId) {
      const normalized = pair(userId, peerUserId);
      return trx.updateTable("friendships").set({ status: "removed", updated_at: sql`now()` }).where("user_low_id", "=", normalized.lowUserId).where("user_high_id", "=", normalized.highUserId).where("status", "=", "active").returningAll().executeTakeFirst();
    },
    async findOrCreatePersonalDirect(trx, userId, peerUserId, conversationId) {
      const normalized = pair(userId, peerUserId);
      let conversation = await activeDirect(trx, normalized.key);
      if (!conversation) {
        conversation = await trx.insertInto("conversations").values({
          id: conversationId, scope_type: "personal", kind: "direct", title: "", status: "active", direct_pair_key: normalized.key,
          direct_user_low_id: normalized.lowUserId, direct_user_high_id: normalized.highUserId, created_by: userId,
        }).returningAll().executeTakeFirstOrThrow();
      } else if (conversation.status !== "active") {
        conversation = await trx.updateTable("conversations").set({ status: "active", updated_at: sql`now()` }).where("id", "=", conversation.id).returningAll().executeTakeFirstOrThrow();
      }
      await ensureActiveMembers(trx, conversation.id, [normalized.lowUserId, normalized.highUserId]);
      return conversation;
    },
    async addBlock(trx, userId, peerUserId) {
      const result = await trx.insertInto("user_blocks").values({ blocker_user_id: userId, blocked_user_id: peerUserId }).onConflict((conflict) => conflict.doNothing()).executeTakeFirst();
      return Number(result?.numInsertedOrUpdatedRows || 0) === 1;
    },
    async removeBlock(trx, userId, peerUserId) {
      const result = await trx.deleteFrom("user_blocks").where("blocker_user_id", "=", userId).where("blocked_user_id", "=", peerUserId).executeTakeFirst();
      return Number(result?.numDeletedRows || 0) === 1;
    },
  });
}

/**
 * Relationship workflow core. `repository.runCommand` is the transaction and
 * command-receipt boundary supplied by the HTTP/PG adapter; all read/modify
 * operations inside `mutate` therefore share one durable command outcome.
 */
export function createCollaborationFriendService({ repository, createId = (prefix) => `${prefix}_${randomUUID()}`, rateLimiter = null } = {}) {
  const runCommand = requireRepositoryMethod(repository, "runCommand");
  const lockPair = requireRepositoryMethod(repository, "lockPair");
  const findProfileByLilyId = requireRepositoryMethod(repository, "findProfileByLilyId");
  const findProfileByUserId = requireRepositoryMethod(repository, "findProfileByUserId");
  const findRequest = requireRepositoryMethod(repository, "findRequest");
  const findRequestById = requireRepositoryMethod(repository, "findRequestById");
  const createRequest = requireRepositoryMethod(repository, "createRequest");
  const resolveRequest = requireRepositoryMethod(repository, "resolveRequest");
  const isBlocked = requireRepositoryMethod(repository, "isBlocked");
  const friendship = requireRepositoryMethod(repository, "friendship");
  const upsertFriendship = requireRepositoryMethod(repository, "upsertFriendship");
  const removeFriendship = requireRepositoryMethod(repository, "removeFriendship");
  const findOrCreatePersonalDirect = requireRepositoryMethod(repository, "findOrCreatePersonalDirect");
  const addBlock = requireRepositoryMethod(repository, "addBlock");
  const removeBlock = requireRepositoryMethod(repository, "removeBlock");

  async function visibleTarget(trx, actorUserId, rawLilyId) {
    const profile = await findProfileByLilyId(trx, lilyId(rawLilyId));
    if (!profile || String(profile.userId ?? profile.user_id) === actorUserId || String(profile.discoverability || "") === "hidden") {
      throw unavailableTarget();
    }
    if (await isBlocked(trx, actorUserId, String(profile.userId ?? profile.user_id))) throw unavailableTarget();
    return profileView(profile);
  }

  async function activatePair({ trx, requestId = null, userId, peerUserId }) {
    if (await isBlocked(trx, userId, peerUserId)) throw unavailableTarget();
    const row = await upsertFriendship(trx, userId, peerUserId);
    const conversation = await findOrCreatePersonalDirect(trx, userId, peerUserId, requiredId(createId("conv"), "Generated direct conversation id"));
    const profiles = await Promise.all([userId, peerUserId].sort().map(async (id) => profileView(await findProfileByUserId(trx, id))));
    return { ...responseForActive({ requestId, friendship: row, conversation }), profile: profiles.find((profile) => profile.userId === peerUserId), profiles };
  }

  async function requestFriend({ account, clientCommandId, lilyId: rawLilyId, message = null, ip = null } = {}) {
    const actor = accountIdentity(account);
    const targetLilyId = lilyId(rawLilyId);
    return runCommand({
      account: actor, commandType: "friend.request", clientCommandId: requiredId(clientCommandId, "Client command id"),
      input: { lilyId: targetLilyId, message: message == null ? null : String(message).slice(0, 500) },
      mutate: async (trx) => {
        const target = await visibleTarget(trx, actor.userId, targetLilyId);
        await lockPair(trx, actor.userId, target.userId);
        // A block may have committed between profile lookup and pair locking;
        // re-check under the shared pair lock so block always wins the race.
        if (await isBlocked(trx, actor.userId, target.userId)) throw unavailableTarget();
        if (rateLimiter) {
          const decision = await rateLimiter.consume({ senderUserId: actor.userId, receiverUserId: target.userId, deviceId: actor.deviceId, ip: requiredId(ip, "Friend request IP") });
          if (!decision?.ok) throw commandError(decision?.code || "COLLAB_FRIEND_RATE_LIMITED", "Too many friend requests.");
        }
        const existingFriendship = await friendship(trx, actor.userId, target.userId);
        if (existingFriendship?.status === "active") {
          const conversation = await findOrCreatePersonalDirect(trx, actor.userId, target.userId, requiredId(createId("conv"), "Generated direct conversation id"));
          return { ...responseForActive({ friendship: existingFriendship, conversation }), noEvent: true };
        }
        const outgoing = await findRequest(trx, actor.userId, target.userId);
        if (outgoing) return { status: "pending", requestId: requiredId(outgoing.id, "Friend request id"), profile: target, noEvent: true };
        const incoming = await findRequest(trx, target.userId, actor.userId);
        if (incoming) {
          const accepted = await resolveRequest(trx, incoming.id, "accepted");
          if (!accepted) throw commandError("COLLAB_FRIEND_REQUEST_CONFLICT", "The friend request changed; retry the operation.");
          return activatePair({ trx, requestId: incoming.id, userId: actor.userId, peerUserId: target.userId });
        }
        const request = await createRequest(trx, { id: requiredId(createId("freq"), "Generated friend request id"), senderUserId: actor.userId, receiverUserId: target.userId, message: message == null ? null : String(message).slice(0, 500), status: "pending" });
        const profiles = await Promise.all([actor.userId, target.userId].sort().map(async (userId) => profileView(await findProfileByUserId(trx, userId))));
        return { status: "pending", requestId: requiredId(request.id, "Friend request id"), profile: target, profiles };
      },
    });
  }

  async function respondToFriendRequest({ account, clientCommandId, requestId, accept } = {}) {
    const actor = accountIdentity(account);
    const id = requiredId(requestId, "Friend request id");
    if (typeof accept !== "boolean") throw new TypeError("Friend request acceptance must be boolean.");
    return runCommand({
      account: actor, commandType: "friend.respond", clientCommandId: requiredId(clientCommandId, "Client command id"), input: { requestId: id, accept },
      prepareProjection: async (trx) => {
        if (!accept) return null;
        const pending = await findRequestById(trx, id);
        if (!pending || String(pending.receiverUserId ?? pending.receiver_user_id) !== actor.userId) throw unavailableTarget();
        const senderUserId = requiredId(pending.senderUserId ?? pending.sender_user_id, "Friend request sender user id");
        await lockPair(trx, actor.userId, senderUserId);
        if (await isBlocked(trx, actor.userId, senderUserId)) throw unavailableTarget();
        return { conversation: await findOrCreatePersonalDirect(trx, actor.userId, senderUserId, requiredId(createId("conv"), "Generated direct conversation id")) };
      },
      mutate: async (trx) => {
        const request = await findRequestById(trx, id);
        if (!request || String(request.receiverUserId ?? request.receiver_user_id) !== actor.userId) throw unavailableTarget();
        const senderUserId = requiredId(request.senderUserId ?? request.sender_user_id, "Friend request sender user id");
        await lockPair(trx, actor.userId, senderUserId);
        if (await isBlocked(trx, actor.userId, senderUserId)) throw unavailableTarget();
        if (request.status === "accepted") return { ...(await activatePair({ trx, requestId: id, userId: actor.userId, peerUserId: senderUserId })), noEvent: true };
        if (request.status !== "pending") return { status: String(request.status), noEvent: true };
        const resolved = await resolveRequest(trx, id, accept ? "accepted" : "declined");
        if (!resolved) throw commandError("COLLAB_FRIEND_REQUEST_CONFLICT", "The friend request changed; retry the operation.");
        if (!accept) return { status: "declined", requestId: id, peerUserId: senderUserId };
        return activatePair({ trx, requestId: id, userId: actor.userId, peerUserId: senderUserId });
      },
    });
  }

  async function removeFriend({ account, clientCommandId, peerUserId } = {}) {
    const actor = accountIdentity(account); const peer = requiredId(peerUserId, "Peer user id");
    canonicalFriendshipPair(actor.userId, peer);
    return runCommand({
      account: actor, commandType: "friend.remove", clientCommandId: requiredId(clientCommandId, "Client command id"), input: { peerUserId: peer },
      mutate: async (trx) => {
        await lockPair(trx, actor.userId, peer);
        const changed = await removeFriendship(trx, actor.userId, peer);
        return { status: changed?.status || "removed", noEvent: !changed };
      },
    });
  }

  async function blockUser({ account, clientCommandId, peerUserId } = {}) {
    const actor = accountIdentity(account); const peer = requiredId(peerUserId, "Blocked user id");
    canonicalFriendshipPair(actor.userId, peer);
    return runCommand({ account: actor, commandType: "user.block", clientCommandId: requiredId(clientCommandId, "Client command id"), input: { peerUserId: peer }, mutate: async (trx) => {
      await lockPair(trx, actor.userId, peer);
      const changed = await addBlock(trx, actor.userId, peer); return { status: "blocked", noEvent: changed === false };
    } });
  }

  async function unblockUser({ account, clientCommandId, peerUserId } = {}) {
    const actor = accountIdentity(account); const peer = requiredId(peerUserId, "Blocked user id");
    canonicalFriendshipPair(actor.userId, peer);
    return runCommand({ account: actor, commandType: "user.unblock", clientCommandId: requiredId(clientCommandId, "Client command id"), input: { peerUserId: peer }, mutate: async (trx) => {
      await lockPair(trx, actor.userId, peer);
      const changed = await removeBlock(trx, actor.userId, peer); return { status: "unblocked", noEvent: changed === false };
    } });
  }

  async function lookupLilyId({ account, lilyId: rawLilyId, ip = null } = {}) {
    const actor = accountIdentity(account);
    const normalizedLilyId = lilyId(rawLilyId);
    if (rateLimiter) {
      // Use the normalized opaque lookup key for the receiver bucket before
      // querying profiles, so unknown IDs are rate-limited identically.
      const decision = await rateLimiter.consume({ senderUserId: actor.userId, receiverUserId: `lily:${normalizedLilyId}`, deviceId: actor.deviceId, ip: requiredId(ip, "Lily lookup IP") });
      if (!decision?.ok) throw commandError(decision?.code || "COLLAB_FRIEND_RATE_LIMITED", "Too many contact lookups.");
    }
    return visibleTarget(null, actor.userId, normalizedLilyId);
  }

  return Object.freeze({ requestFriend, respondToFriendRequest, removeFriend, blockUser, unblockUser, lookupLilyId });
}
