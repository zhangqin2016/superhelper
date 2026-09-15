"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { deletedSessionsPath } = require("./config");

/**
 * Deleted-session index: a small append-style JSON record of sessions the
 * user deleted, kept so recovery/diagnostics can tell "deleted on purpose"
 * from "lost". Extracted from session-manager.js (architecture ratchet).
 */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch (err) {
    console.warn("[sessions] failed to write", filePath, err?.message || err);
  }
}

function markDeletedSession(session) {
  if (!session?.id) return;
  const filePath = deletedSessionsPath();
  const existing = readJson(filePath);
  const sessions = existing?.sessions && typeof existing.sessions === "object" && !Array.isArray(existing.sessions)
    ? existing.sessions
    : {};
  sessions[session.id] = {
    id: session.id,
    projectId: session.projectId || null,
    title: session.title || null,
    deletedAt: new Date().toISOString(),
  };
  writeJson(filePath, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    sessions,
  });
}

module.exports = { markDeletedSession };
