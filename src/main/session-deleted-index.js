"use strict";

const fs = require("node:fs");
const jsonFile = require("./json-file");
const path = require("node:path");
const { deletedSessionsPath } = require("./config");

/**
 * Deleted-session index: a small append-style JSON record of sessions the
 * user deleted, kept so recovery/diagnostics can tell "deleted on purpose"
 * from "lost". Extracted from session-manager.js (architecture ratchet).
 */
function readJson(filePath) {
  return jsonFile.readJson(filePath, null);
}

function writeJson(filePath, value) {
  try {
    jsonFile.writeJson(filePath, value);
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
