"use strict";

function listSessionSummaries(db) {
  return db.all(
    `SELECT session_id, COUNT(*) AS message_count,
            MIN(created_at) AS created_at, MAX(created_at) AS updated_at
     FROM messages
     GROUP BY session_id
     HAVING COUNT(*) > 0
     ORDER BY updated_at DESC`,
  ).map((row) => ({
    sessionId: String(row.session_id || ""),
    messageCount: Number(row.message_count) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  })).filter((row) => row.sessionId);
}

module.exports = { listSessionSummaries };
