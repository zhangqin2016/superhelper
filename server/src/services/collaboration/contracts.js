// Collaboration protocol v1 has intentionally bounded values. Persistent
// events are forward-compatible: a newer event can be recorded by the server
// and safely skipped by an older desktop client while it advances its cursor.

export const COLLABORATION_CONTRACT_SCHEMA_VERSION = 1;

export const COLLABORATION_SCOPE_TYPES = Object.freeze([
  "personal",
  "organization",
]);

export const COLLABORATION_CONVERSATION_KINDS = Object.freeze([
  "direct",
  "group",
  "channel",
]);

export const COLLABORATION_MEMBER_ROLES = Object.freeze([
  "owner",
  "admin",
  "member",
]);

export const COLLABORATION_EVENT_TYPES = Object.freeze([
  "conversation.created",
  "conversation.archived",
  "member.joined",
  "member.left",
  "member.removed",
  "member.role_changed",
  "message.created",
  "message.edited",
  "message.revoked",
  "conversation.read",
  "friend.requested",
  "friend.accepted",
  "friend.declined",
  "friend.removed",
  "user.blocked",
  "user.unblocked",
  "workspace.shared",
  "scope.revoked",
  "object.initiated",
  "object.verified",
  "object.rejected",
  "object.aborted",
  "object.revoked",
  "object.download_authorized",
]);

export function collaborationAccountEventScope(type) {
  if (["friend.requested", "friend.accepted", "friend.declined", "friend.removed", "user.blocked", "user.unblocked"].includes(type)) return "relationship";
  if (type === "scope.revoked") return "organization";
  if (["object.initiated", "object.verified", "object.rejected", "object.aborted", "object.revoked", "object.download_authorized"].includes(type)) return "object";
  return null;
}

const EVENT_TYPE_SET = new Set(COLLABORATION_EVENT_TYPES);

/** Return the only allowed representation for a direct conversation pair. */
export function canonicalDirectPair(userA, userB) {
  const users = [String(userA || ""), String(userB || "")];
  if (!users[0] || !users[1] || users[0] === users[1]) {
    throw new Error("Direct conversation users must be distinct non-empty identifiers.");
  }
  users.sort();
  return {
    lowUserId: users[0],
    highUserId: users[1],
    key: `${users[0]}:${users[1]}`,
  };
}

export function isKnownCollaborationEventType(type) {
  return typeof type === "string" && EVENT_TYPE_SET.has(type);
}

/**
 * Decide how a durable sync consumer handles one event without ever stalling
 * the cursor on a future event type. The caller may emit an observability
 * record for `ignore`, but must never treat it as successful local projection.
 */
export function classifyCollaborationEvent(event) {
  if (isKnownCollaborationEventType(event?.type)) {
    return { action: "apply", cursorAdvance: true };
  }
  return {
    action: "ignore",
    cursorAdvance: true,
    reason: "UNKNOWN_COLLABORATION_EVENT",
  };
}
