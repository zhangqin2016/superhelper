"use strict";

const fs = require("node:fs");
const path = require("node:path");

const INDEXED_ORPHAN_RECOVERY_LIMIT = 3;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Rebuild a small number of missing sidebar records from the durable message
 * store. Bulk recovery is intentionally reported for manual inspection so a
 * corrupt index cannot flood the user's workspace with unknown sessions.
 */
function recoverIndexedMessageSessions({
  activeProject,
  knownIds,
  sessions,
  listSessionSummaries,
  deletedSessionsPath,
  recoveryManifestPath,
  title,
}) {
  if (!activeProject?.id) return 0;

  const deletedRaw = readJson(deletedSessionsPath);
  const deletedIds = new Set(Object.keys(deletedRaw?.sessions || {}));
  let candidates;
  try {
    candidates = listSessionSummaries()
      .filter((summary) => !knownIds.has(summary.sessionId) && !deletedIds.has(summary.sessionId));
  } catch (err) {
    console.warn("[sessions] indexed history recovery skipped:", err?.message || err);
    return 0;
  }

  if (candidates.length === 0) return 0;
  if (candidates.length > INDEXED_ORPHAN_RECOVERY_LIMIT) {
    writeJson(recoveryManifestPath, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      skippedBulkIndexedRecovery: {
        reason: "too_many_orphaned_message_store_sessions",
        count: candidates.length,
        limit: INDEXED_ORPHAN_RECOVERY_LIMIT,
        sessions: candidates.map((candidate) => ({
          id: candidate.sessionId,
          messageCount: candidate.messageCount,
          updatedAt: candidate.updatedAt ? new Date(candidate.updatedAt).toISOString() : null,
        })),
      },
    });
    console.warn(`[sessions] skipped ${candidates.length} orphaned SQLite histories; wrote recovery manifest instead of flooding the sidebar`);
    return 0;
  }

  const target = sessions[activeProject.id] ||= [];
  for (const candidate of candidates) {
    const createdAt = candidate.createdAt || Date.now();
    const updatedAt = candidate.updatedAt || createdAt;
    target.push({
      id: candidate.sessionId,
      projectId: activeProject.id,
      title,
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      status: "idle",
      messageCount: candidate.messageCount,
      recoveredFromMessageStore: true,
    });
  }
  console.info(`[sessions] recovered ${candidates.length} orphaned SQLite session history record(s)`);
  return candidates.length;
}

function recoverIndexedMessageSessionsForManager(manager, title) {
  const { deletedSessionsPath, sessionsIndexPath } = require("./config");
  return recoverIndexedMessageSessions({
    activeProject: manager.pm.getActive(),
    knownIds: new Set(manager.iterateSessions().map((session) => session.id)),
    sessions: manager.sessions,
    listSessionSummaries: () => manager._store().listSessionSummaries(),
    deletedSessionsPath: deletedSessionsPath(),
    recoveryManifestPath: path.join(path.dirname(sessionsIndexPath()), "sqlite-message-recovery.json"),
    title,
  });
}

module.exports = { recoverIndexedMessageSessions, recoverIndexedMessageSessionsForManager };
