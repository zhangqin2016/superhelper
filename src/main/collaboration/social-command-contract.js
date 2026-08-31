"use strict";

const id = (value) => typeof value === "string" && /^[^\x00-\x20\x7f]{1,200}$/.test(value);
const only = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
function normalizeSocialCommand(kind, value) {
  if (!value || value.clientCommandId !== undefined && !id(value.clientCommandId)) return null;
  const identity = value.clientCommandId === undefined ? {} : { clientCommandId: value.clientCommandId };
  const { action } = value;
  if (kind === "friend") {
    const common = ["action", "clientCommandId"];
    if (action === "request" && only(value, [...common, "lilyId"]) && typeof value.lilyId === "string" && /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value.lilyId.trim().toLowerCase())) return { action, ...identity, lilyId: value.lilyId.trim().toLowerCase() };
    if (action === "respond" && only(value, [...common, "requestId", "accept"]) && id(value.requestId) && typeof value.accept === "boolean") return { action, ...identity, requestId: value.requestId, accept: value.accept };
    if (["remove", "block", "unblock"].includes(action) && only(value, [...common, "peerUserId"]) && id(value.peerUserId)) return { action, ...identity, peerUserId: value.peerUserId };
    return null;
  }
  if (kind !== "conversation") return null;
  if (action === "member") {
    const keys = ["action", "clientCommandId", "conversationId", "targetUserId", "operation", ...(value.operation === "role" ? ["role"] : [])];
    if (!only(value, keys) || !id(value.conversationId) || !id(value.targetUserId) || !["add", "remove", "role"].includes(value.operation) || value.operation === "role" && !["admin", "member"].includes(value.role)) return null;
    return { action, ...identity, conversationId: value.conversationId, targetUserId: value.targetUserId, operation: value.operation, ...(value.operation === "role" ? { role: value.role } : {}) };
  }
  const personal = value.scopeType === "personal" && value.kind === "group";
  const team = value.scopeType === "organization" && id(value.organizationId);
  const channel = team && value.kind === "channel" && ["public", "private"].includes(value.visibility);
  const direct = team && value.kind === "direct";
  if (action !== "create" || !personal && !channel && !direct
      || !only(value, ["action", "clientCommandId", "scopeType", "kind", "title", "memberUserIds", ...(team ? ["organizationId"] : []), ...(channel ? ["visibility"] : [])])
      || value.title !== undefined && (typeof value.title !== "string" || value.title.length > 200)) return null;
  const members = value.memberUserIds ?? [];
  if (!Array.isArray(members) || !members.every(id) || new Set(members).size !== members.length
      || members.length > (personal ? 199 : direct ? 2 : value.visibility === "public" ? 0 : 499) || direct && members.length < 1) return null;
  return { action, ...identity, scopeType: value.scopeType, kind: value.kind, title: (value.title || "").trim(), memberUserIds: [...members].sort(), ...(team ? { organizationId: value.organizationId } : {}), ...(channel ? { visibility: value.visibility } : {}) };
}

module.exports = { normalizeSocialCommand, socialIdentifier: id };
