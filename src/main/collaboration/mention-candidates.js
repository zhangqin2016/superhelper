"use strict";
const { messageIdentifier: identifier } = require("./message-intent");
const invalid = () => Object.assign(new Error("Invalid collaboration mention candidates"), { code: "COLLAB_MENTION_CANDIDATES_INVALID" });
const keysOnly = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));

/** Independent from management members: public Team candidates need no channel row. */
function normalizeMentionCandidates(value, { memberIds = null, allowUnknown = false } = {}) {
  if (value === undefined) return { status: "unknown", items: [] };
  if (!keysOnly(value, ["status", "items"]) || !Array.isArray(value.items) || value.items.length > 1000) throw invalid();
  if (allowUnknown && value.status === "unknown" && value.items.length === 0) return { status: "unknown", items: [] };
  if (value.status !== "complete") throw invalid();
  const seen = new Set();
  const items = value.items.map((item) => {
    if (!keysOnly(item, ["userId", "lilyId", "displayName", "avatarObjectId"]) || !identifier(item.userId) || seen.has(item.userId)
      || memberIds && !memberIds.has(item.userId) || item.lilyId !== "" && !identifier(item.lilyId)
      || typeof item.displayName !== "string" || item.displayName.length > 500
      || item.avatarObjectId !== null && !identifier(item.avatarObjectId)) throw invalid();
    seen.add(item.userId);
    return { userId: item.userId, lilyId: item.lilyId, displayName: item.displayName, avatarObjectId: item.avatarObjectId };
  });
  items.sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  return { status: "complete", items };
}
module.exports = { normalizeMentionCandidates };
