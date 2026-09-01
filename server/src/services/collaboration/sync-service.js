import { createHash, randomBytes } from "node:crypto";
import {
  createKyselyRepository, BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION, BOOTSTRAP_HISTORY_TOTAL_LIMIT,
} from "./sync-repository.js";

export { BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION, BOOTSTRAP_HISTORY_TOTAL_LIMIT } from "./sync-repository.js";

import { classifyCollaborationEvent, collaborationAccountEventScope } from "./contracts.js";

export const DEFAULT_SYNC_LIMIT = 500;
export const MAX_SYNC_LIMIT = 2000;
export const DEFAULT_SYNC_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const STALE_DEVICE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const BOOTSTRAP_COMPLETION_TTL_MS = 15 * 60 * 1000;
export const BOOTSTRAP_HISTORY_MAX_BYTES = 2 * 1024 * 1024;

function collaborationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredId(value, label) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${label} is required.`);
  return id;
}

function nonNegativeCursor(value, label) {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return cursor;
}

function isActiveBoundDevice(device) {
  return String(device?.deviceStatus ?? device?.device_status ?? device?.status ?? "active").toLowerCase() === "active";
}

function needsBootstrap(device) {
  return device?.syncDeviceId === null || device?.sync_device_id === null;
}

function hashBootstrapToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

function defaultBootstrapToken() {
  return randomBytes(32).toString("base64url");
}

export function normalizeSyncLimit(value = DEFAULT_SYNC_LIMIT) {
  if (value === undefined || value === null) return DEFAULT_SYNC_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Collaboration sync limit must be a positive integer.");
  }
  return Math.min(value, MAX_SYNC_LIMIT);
}

function normalizePayload(payload) {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    throw collaborationError("COLLAB_SYNC_EVENT_INVALID", "A collaboration sync event has invalid JSON payload.");
  }
}

function normalizedSyncEvent(row) {
  const cursor = nonNegativeCursor(row?.cursor, "Collaboration sync event cursor");
  if (cursor < 1) throw collaborationError("COLLAB_SYNC_EVENT_INVALID", "A collaboration sync event cursor must be positive.");
  const payload = normalizePayload(row?.payload);
  const accountScope = collaborationAccountEventScope(row?.type);
  const scope = accountScope ?? row?.scope ?? payload?.scope ?? "conversation";
  const rawConversationId = row?.conversationId ?? row?.conversation_id;
  const conversationId = rawConversationId == null || String(rawConversationId).trim() === "" ? null : requiredId(rawConversationId, "Collaboration sync conversation id");
  if (conversationId === null && !accountScope) {
    throw collaborationError("COLLAB_SYNC_EVENT_INVALID", "Only account-scoped sync events may omit a conversation id.");
  }
  return {
    cursor,
    id: requiredId(row?.id ?? row?.eventId ?? row?.event_id, "Collaboration sync event id"),
    conversationId,
    scope,
    seq: Number.isSafeInteger(Number(row?.seq)) ? Number(row.seq) : null,
    type: requiredId(row?.type, "Collaboration sync event type"),
    clientCommandId: String(row?.clientCommandId ?? row?.client_command_id ?? ""),
    actorUserId: String(row?.actorUserId ?? row?.actor_user_id ?? ""),
    createdAt: row?.createdAt ?? row?.created_at ?? null,
    payload,
  };
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Bound one durable page without advancing over an event that did not fit.
 * The caller uses `hasMore` to request that event in the next page. A single
 * oversized event is a server-side invariant failure, never a silent drop.
 */
function assertCursorContinuity(events, { afterCursor = null, toCursor = null } = {}) {
  if (afterCursor === null || afterCursor === undefined) return;
  const start = nonNegativeCursor(afterCursor, "Collaboration sync page from cursor");
  let expected = start + 1;
  for (const event of events) {
    if (event.cursor !== expected) {
      throw collaborationError("COLLAB_SYNC_PAGE_INVALID", "A collaboration sync page has a cursor gap or duplicate.");
    }
    expected += 1;
  }
  if (toCursor !== null && toCursor !== undefined && nonNegativeCursor(toCursor, "Collaboration sync page to cursor") !== expected - 1) {
    throw collaborationError("COLLAB_SYNC_PAGE_INVALID", "A collaboration sync page cursor does not match its event rows.");
  }
}

export function paginateSyncEvents(rows, { afterCursor = null, limit = DEFAULT_SYNC_LIMIT, maxPayloadBytes = DEFAULT_SYNC_MAX_PAYLOAD_BYTES } = {}) {
  const boundedLimit = normalizeSyncLimit(limit);
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new TypeError("Collaboration sync payload limit must be a positive integer.");
  }
  const normalized = (Array.isArray(rows) ? rows : []).map(normalizedSyncEvent);
  let previousCursor = 0;
  for (const event of normalized) {
    if (event.cursor <= previousCursor) {
      throw collaborationError("COLLAB_SYNC_EVENT_ORDER_INVALID", "Collaboration sync events must be strictly cursor ordered.");
    }
    previousCursor = event.cursor;
  }
  assertCursorContinuity(normalized, { afterCursor });

  const page = [];
  let payloadBytes = 0;
  for (const event of normalized) {
    if (page.length >= boundedLimit) break;
    const eventBytes = byteLength(event);
    if (eventBytes > maxPayloadBytes && page.length === 0) {
      throw collaborationError("COLLAB_SYNC_EVENT_TOO_LARGE", "A collaboration sync event exceeds the response payload limit.");
    }
    if (payloadBytes + eventBytes > maxPayloadBytes) break;
    page.push(event);
    payloadBytes += eventBytes;
  }
  return {
    events: page,
    toCursor: page.length > 0 ? page.at(-1).cursor : null,
    hasMore: page.length < normalized.length,
    payloadBytes,
  };
}

/** A local consumer advances past future event types, while recording them. */
export function applyDurableSyncPage(state = {}, page = {}, applyEvent = () => {}) {
  const initialCursor = nonNegativeCursor(state.cursor ?? 0, "Local collaboration cursor");
  if (page?.status && page.status !== "OK") return { ...state, cursor: initialCursor };
  const fromCursor = nonNegativeCursor(page?.fromCursor ?? initialCursor, "Sync page from cursor");
  const toCursor = nonNegativeCursor(page?.toCursor ?? fromCursor, "Sync page to cursor");
  if (fromCursor !== initialCursor) throw collaborationError("COLLAB_SYNC_PAGE_INVALID", "A collaboration sync page does not match the local cursor.");
  if (toCursor < fromCursor) throw collaborationError("COLLAB_SYNC_PAGE_INVALID", "A collaboration sync page cursor regressed.");
  const seen = new Set(Array.isArray(state.appliedEventIds) ? state.appliedEventIds.map(String) : []);
  const ignoredEventIds = [];
  const rows = Array.isArray(page?.events) ? page.events.map(normalizedSyncEvent) : [];
  assertCursorContinuity(rows, { afterCursor: fromCursor, toCursor });
  for (const event of rows) {
    const classification = classifyCollaborationEvent(event);
    if (classification.action === "apply" && !seen.has(event.id)) {
      applyEvent(event);
      seen.add(event.id);
    } else if (classification.action === "ignore") {
      ignoredEventIds.push(event.id);
      seen.add(event.id);
    }
  }
  // `toCursor` is authoritative only after every preceding row in its durable
  // page was considered. This permits future event types without a cursor stall.
  const cursor = toCursor;
  return { ...state, cursor, appliedEventIds: [...seen], ignoredEventIds };
}

export function buildBootstrapSnapshot({ profile = null, relationships = [], friendRequests = [], blocks = [], teams = [], teamMembers = [], conversations = [], members = [], profiles = [], history = [], historyHydration = null, watermark = 0 } = {}) {
  const normalizedWatermark = nonNegativeCursor(watermark, "Collaboration bootstrap watermark");
  const normalizedProfile = profile ? {
    userId: String(profile.userId ?? profile.user_id ?? ""),
    lilyId: String(profile.lilyId ?? profile.lily_id ?? ""),
    displayName: String(profile.displayName ?? profile.display_name ?? ""),
    avatarObjectId: profile.avatarObjectId ?? profile.avatar_object_id ?? null,
    discoverability: profile.discoverability ?? null,
  } : null;
  return {
    profile: normalizedProfile,
    directorySchemaVersion: 1,
    relationships: Array.isArray(relationships) ? relationships : [],
    friendRequests: Array.isArray(friendRequests) ? friendRequests : [],
    blocks: Array.isArray(blocks) ? blocks : [],
    teams: Array.isArray(teams) ? teams : [],
    teamMembers: Array.isArray(teamMembers) ? teamMembers : [],
    // This is the server-to-desktop projection contract. Raw database scope
    // columns deliberately never leak to the local keyring/outbox layer:
    // organization conversations always use the stable Team scope namespace.
    conversations: Array.isArray(conversations) ? conversations.map((conversation) => {
      const scopeType = String(conversation?.scopeType ?? conversation?.scope_type ?? "");
      const organizationId = String(conversation?.organizationId ?? conversation?.organization_id ?? "").trim();
      const suppliedScope = String(conversation?.scopeId ?? conversation?.scope_id ?? "").trim();
      return {
        ...conversation,
        scopeId: scopeType === "organization" && organizationId ? `team:${organizationId}` : (suppliedScope || "personal"),
      };
    }) : [],
    members: Array.isArray(members) ? members : [],
    profiles: Array.isArray(profiles) ? profiles : [],
    // Controlled history lets a compacted local DB reconstruct useful
    // conversation state without making bootstrap response size unbounded.
    history: Array.isArray(history) ? history : [],
    historyHydration,
    watermark: normalizedWatermark,
    fromCursor: normalizedWatermark,
  };
}

/**
 * Keep a full bootstrap recoverable under a strict global response budget.
 * Omitted histories are deliberately reported so the client can fetch them
 * later through authorized keyset history pagination instead of mistaking the
 * bounded bootstrap for a complete archive.
 */
export function boundBootstrapHistory(rows, { conversationIds = [], perConversationLimit = BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION, totalLimit = BOOTSTRAP_HISTORY_TOTAL_LIMIT, maxBytes = BOOTSTRAP_HISTORY_MAX_BYTES } = {}) {
  const maxItems = Math.min(Math.max(1, Number(totalLimit) || BOOTSTRAP_HISTORY_TOTAL_LIMIT), BOOTSTRAP_HISTORY_TOTAL_LIMIT);
  const byteBudget = Math.min(Math.max(1, Number(maxBytes) || BOOTSTRAP_HISTORY_MAX_BYTES), BOOTSTRAP_HISTORY_MAX_BYTES);
  const knownConversationIds = [...new Set((Array.isArray(conversationIds) ? conversationIds : []).map(String).filter(Boolean))].sort();
  const history = [];
  let historyBytes = 0;
  let truncated = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    const rowBytes = byteLength(row);
    if (history.length >= maxItems || rowBytes > byteBudget || historyBytes + rowBytes > byteBudget) {
      truncated = true;
      continue;
    }
    history.push(row);
    historyBytes += rowBytes;
  }
  const hydratedConversationIds = new Set(history.map((row) => String(row?.conversation_id ?? row?.conversationId ?? "")).filter(Boolean));
  return {
    history,
    hydration: {
      // This is intentionally a starter window, never a statement that a
      // conversation's archive is locally complete. Older authorized history
      // remains available through keyset pagination after bootstrap.
      historyComplete: false,
      initialWindowOnly: true,
      totalLimit: maxItems,
      perConversationLimit,
      maxBytes: byteBudget,
      historyBytes,
      truncated,
      hydratedConversationIds: [...hydratedConversationIds].sort(),
      omittedConversationIds: knownConversationIds.filter((id) => !hydratedConversationIds.has(id)),
      continuationRequiredConversationIds: knownConversationIds,
    },
  };
}

/** Return only active-device ACKs; stale devices must explicitly bootstrap. */
export function computeCompactionWatermark({ deviceStates = [], retentionFloorCursor = 0, now = new Date(), staleAfterMs = STALE_DEVICE_AFTER_MS } = {}) {
  const timestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError("Compaction clock must be a valid date.");
  const retentionFloor = nonNegativeCursor(retentionFloorCursor, "Compaction retention floor cursor");
  const staleBefore = timestamp - staleAfterMs;
  const staleDeviceIds = [];
  const activeAcks = [];
  for (const state of Array.isArray(deviceStates) ? deviceStates : []) {
    const deviceId = requiredId(state?.deviceId ?? state?.device_id, "Device id");
    const deviceStatus = String(state?.deviceStatus ?? state?.device_status ?? state?.status ?? "active").toLowerCase();
    if (deviceStatus !== "active") continue;
    const lastSeen = new Date(state?.lastSeenAt ?? state?.last_seen_at ?? state?.boundLastSeenAt ?? state?.bound_last_seen_at ?? 0).getTime();
    const stale = !Number.isFinite(lastSeen) || lastSeen < staleBefore;
    if (stale) {
      staleDeviceIds.push(deviceId);
      continue;
    }
    if (!state?.requiresFullResync && !state?.requires_full_resync) {
      activeAcks.push(nonNegativeCursor(state?.lastAckedCursor ?? state?.last_acked_cursor ?? 0, "Device acknowledgement cursor"));
    }
  }
  const activeDeviceAckCursor = activeAcks.length > 0 ? Math.min(...activeAcks) : 0;
  return {
    compactedBeforeCursor: Math.min(activeDeviceAckCursor, retentionFloor),
    activeDeviceAckCursor,
    staleDeviceIds: staleDeviceIds.sort(),
  };
}

async function withWrite(repository, callback) {
  return typeof repository.withWriteTransaction === "function" ? repository.withWriteTransaction(callback) : callback(repository);
}

export function createCollaborationSyncService({
  db,
  repository = db ? createKyselyRepository(db) : null,
  now = () => new Date(),
  maxPayloadBytes = DEFAULT_SYNC_MAX_PAYLOAD_BYTES,
  historyLimitPerConversation = BOOTSTRAP_HISTORY_LIMIT_PER_CONVERSATION,
  historyTotalLimit = BOOTSTRAP_HISTORY_TOTAL_LIMIT,
  historyMaxBytes = BOOTSTRAP_HISTORY_MAX_BYTES,
  createBootstrapToken = defaultBootstrapToken,
} = {}) {
  if (!repository || typeof repository.withReadSnapshot !== "function") {
    throw new TypeError("A collaboration sync repository is required.");
  }

  async function readState(trx, userId) {
    const state = await repository.getSyncState(trx, userId);
    return {
      compactedBeforeCursor: nonNegativeCursor(state?.compacted_before_cursor ?? state?.compactedBeforeCursor ?? 0, "Compacted collaboration cursor"),
      watermark: Math.max(0, Number(state?.next_cursor ?? state?.nextCursor ?? 1) - 1),
    };
  }

  return {
    async bootstrapCollaboration({ userId, deviceId }) {
      const accountId = requiredId(userId, "Collaboration account id");
      const stableDeviceId = requiredId(deviceId, "Collaboration device id");
      const snapshot = await repository.withReadSnapshot(async (trx) => {
        // Keep these reads serial inside one repeatable-read snapshot. Besides
        // avoiding concurrent use of one PG connection, this makes every
        // query boundary safe from a writer racing the bootstrap response.
        const device = await repository.getDeviceState(trx, accountId, stableDeviceId);
        if (!device) throw collaborationError("COLLAB_DEVICE_NOT_BOUND", "The collaboration device is not bound to this account.");
        if (!isActiveBoundDevice(device)) throw collaborationError("COLLAB_DEVICE_REVOKED", "The collaboration device is no longer active.");
        const profile = await repository.getBootstrapProfile(trx, accountId);
        const relationships = await repository.listBootstrapRelationships(trx, accountId);
        const friendRequests = typeof repository.listBootstrapFriendRequests === "function" ? await repository.listBootstrapFriendRequests(trx, accountId) : [];
        const blocks = typeof repository.listBootstrapBlocks === "function" ? await repository.listBootstrapBlocks(trx, accountId) : [];
        const teams = await repository.listBootstrapTeams(trx, accountId);
        const teamMembers = typeof repository.listBootstrapTeamMembers === "function"
          ? await repository.listBootstrapTeamMembers(trx, accountId) : [];
        const conversations = await repository.listBootstrapConversations(trx, accountId);
        const conversationIds = conversations.map((conversation) => String(conversation.id || "")).filter(Boolean).sort();
        const members = typeof repository.listBootstrapConversationMembers === "function"
          ? await repository.listBootstrapConversationMembers(trx, conversationIds) : [];
        const profileUserIds = [...new Set([accountId, ...members.map((member) => member.user_id ?? member.userId),
          ...relationships.flatMap((row) => [row.user_low_id ?? row.userLowId, row.user_high_id ?? row.userHighId]),
          ...friendRequests.flatMap((row) => [row.sender_user_id ?? row.senderUserId, row.receiver_user_id ?? row.receiverUserId]),
          ...blocks.map((row) => row.blocked_user_id ?? row.blockedUserId)].filter(Boolean).map(String))].sort();
        const profiles = typeof repository.listBootstrapProfiles === "function"
          ? await repository.listBootstrapProfiles(trx, profileUserIds) : [];
        const historyRows = typeof repository.listBootstrapHistory === "function"
          ? await repository.listBootstrapHistory(trx, accountId, conversationIds, historyLimitPerConversation) : [];
        const boundedHistory = boundBootstrapHistory(historyRows, {
          conversationIds, perConversationLimit: historyLimitPerConversation, totalLimit: historyTotalLimit, maxBytes: historyMaxBytes,
        });
        const state = await readState(trx, accountId);
        return buildBootstrapSnapshot({
          profile, relationships, friendRequests, blocks, teams, teamMembers, conversations, members, profiles, history: boundedHistory.history,
          historyHydration: boundedHistory.hydration, watermark: state.watermark,
        });
      });
      if (typeof repository.issueBootstrapCompletion !== "function") {
        throw new TypeError("The collaboration sync repository does not support bootstrap completion issuance.");
      }
      const bootstrapCompletionToken = String(createBootstrapToken() || "");
      if (!bootstrapCompletionToken) throw new Error("Collaboration bootstrap token generation failed.");
      const issued = await withWrite(repository, (trx) => repository.issueBootstrapCompletion(trx, {
        userId: accountId, deviceId: stableDeviceId, tokenHash: hashBootstrapToken(bootstrapCompletionToken),
        watermark: snapshot.watermark, expiresAt: new Date(now().getTime() + BOOTSTRAP_COMPLETION_TTL_MS),
      }));
      if (!issued) throw collaborationError("COLLAB_DEVICE_REVOKED", "The collaboration device is no longer active.");
      return { ...snapshot, bootstrapCompletionToken };
    },

    async syncAfterCursor({ userId, deviceId, afterCursor = 0, limit } = {}) {
      const accountId = requiredId(userId, "Collaboration account id");
      const stableDeviceId = requiredId(deviceId, "Collaboration device id");
      const cursor = nonNegativeCursor(afterCursor, "Collaboration sync cursor");
      const boundedLimit = normalizeSyncLimit(limit);
      return repository.withReadSnapshot(async (trx) => {
        const [state, device] = await Promise.all([readState(trx, accountId), repository.getDeviceState(trx, accountId, stableDeviceId)]);
        if (!device) throw collaborationError("COLLAB_DEVICE_NOT_BOUND", "The collaboration device is not bound to this account.");
        if (!isActiveBoundDevice(device)) throw collaborationError("COLLAB_DEVICE_REVOKED", "The collaboration device is no longer active.");
        if (needsBootstrap(device) || device.requires_full_resync || device.requiresFullResync || cursor < state.compactedBeforeCursor) {
          return { status: "FULL_RESYNC_REQUIRED", code: "FULL_RESYNC_REQUIRED", fromCursor: cursor, compactedBeforeCursor: state.compactedBeforeCursor, watermark: state.watermark };
        }
        const rows = await repository.listSyncEvents(trx, accountId, cursor, boundedLimit + 1);
        const page = paginateSyncEvents(rows, { afterCursor: cursor, limit: boundedLimit, maxPayloadBytes });
        return {
          status: "OK", fromCursor: cursor, toCursor: page.toCursor ?? cursor, watermark: state.watermark,
          hasMore: page.hasMore || (page.toCursor ?? cursor) < state.watermark,
          events: page.events,
        };
      });
    },

    async ackDeviceCursor({ userId, deviceId, cursor, bootstrapCompletionToken } = {}) {
      const accountId = requiredId(userId, "Collaboration account id");
      const stableDeviceId = requiredId(deviceId, "Collaboration device id");
      const acknowledgedCursor = nonNegativeCursor(cursor, "Collaboration acknowledgement cursor");
      return withWrite(repository, async (trx) => {
        const [state, device] = await Promise.all([readState(trx, accountId), repository.getDeviceState(trx, accountId, stableDeviceId)]);
        if (!device) throw collaborationError("COLLAB_DEVICE_NOT_BOUND", "The collaboration device is not bound to this account.");
        if (!isActiveBoundDevice(device)) throw collaborationError("COLLAB_DEVICE_REVOKED", "The collaboration device is no longer active.");
        if (acknowledgedCursor > state.watermark) throw collaborationError("COLLAB_ACK_CURSOR_INVALID", "The collaboration acknowledgement cursor is ahead of the durable watermark.");
        const completingFullResync = needsBootstrap(device) || device.requires_full_resync || device.requiresFullResync;
        if (completingFullResync && !bootstrapCompletionToken) {
          throw collaborationError("FULL_RESYNC_REQUIRED", "This device must complete collaboration bootstrap before acknowledging incremental sync.");
        }
        if (completingFullResync) {
          if (typeof repository.consumeBootstrapCompletion !== "function") {
            throw new TypeError("The collaboration sync repository does not support bootstrap completion consumption.");
          }
          const completion = await repository.consumeBootstrapCompletion(trx, {
            userId: accountId, deviceId: stableDeviceId, tokenHash: hashBootstrapToken(bootstrapCompletionToken), watermark: acknowledgedCursor,
          });
          if (!completion) throw collaborationError("COLLAB_BOOTSTRAP_COMPLETION_INVALID", "The bootstrap completion token is invalid, expired, already used, or has a different watermark.");
        }
        const updated = await repository.acknowledgeDeviceCursor(trx, {
          userId: accountId, deviceId: stableDeviceId, cursor: acknowledgedCursor, completeFullResync: completingFullResync,
        });
        if (!updated) throw collaborationError("COLLAB_DEVICE_NOT_BOUND", "The collaboration device is not bound to this account.");
        return {
          lastAckedCursor: Math.max(0, Number(updated.last_acked_cursor ?? updated.lastAckedCursor ?? acknowledgedCursor)),
          requiresFullResync: Boolean(updated.requires_full_resync ?? updated.requiresFullResync),
        };
      });
    },

    /**
     * Compaction never lets a recently active device lose its incremental
     * window. Devices absent longer than the retention horizon are explicitly
     * marked, rather than letting a newer device overwrite their ACK state.
     */
    async compactUserSync({ userId, retentionFloorCursor = 0 } = {}) {
      const accountId = requiredId(userId, "Collaboration account id");
      const retentionFloor = nonNegativeCursor(retentionFloorCursor, "Compaction retention floor cursor");
      if (typeof repository.listDeviceStates !== "function" || typeof repository.advanceCompactedBeforeCursor !== "function") {
        throw new TypeError("The collaboration sync repository does not support compaction.");
      }
      return withWrite(repository, async (trx) => {
        const [state, deviceStates] = await Promise.all([readState(trx, accountId), repository.listDeviceStates(trx, accountId)]);
        const computed = computeCompactionWatermark({ deviceStates, retentionFloorCursor: retentionFloor, now: now() });
        if (computed.staleDeviceIds.length > 0 && typeof repository.markDevicesRequireFullResync === "function") {
          await repository.markDevicesRequireFullResync(trx, accountId, computed.staleDeviceIds);
        }
        const compactedBeforeCursor = Math.max(state.compactedBeforeCursor, computed.compactedBeforeCursor);
        if (compactedBeforeCursor > state.compactedBeforeCursor) {
          await repository.advanceCompactedBeforeCursor(trx, accountId, compactedBeforeCursor);
        }
        return { ...computed, compactedBeforeCursor };
      });
    },
  };
}
