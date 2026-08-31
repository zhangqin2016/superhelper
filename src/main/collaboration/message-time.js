"use strict";

// Only an explicit server field is creation-time authority. SQLite created_at
// predates this contract and may merely be the local cache insertion time.
function serverTime(value) {
  if (value == null) return null;
  const time = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : value;
  if (!Number.isSafeInteger(time) || time < 0) throw Object.assign(new Error("Invalid collaboration server time"), { code: "COLLAB_HISTORY_INVALID" });
  return time;
}
function messageTimes(content, row) {
  return { createdAt: serverTime(content.createdAt),
    clientCreatedAt: content.clientCreatedAt ?? (row.client_command_id ? Number(row.created_at) : null), updatedAt: Number(row.updated_at) };
}
module.exports = { serverTime, messageTimes };
