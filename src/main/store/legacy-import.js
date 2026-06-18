"use strict";

/**
 * One-time migration of legacy per-session JSON message files into the
 * SQLite MessageStore.
 *
 * Idempotent: each session is flagged in schema_meta once imported and its
 * source file is moved to session-messages.imported/ as a safety net (kept a
 * release cycle before any cleanup). Re-running is a no-op.
 *
 * Strategy is lazy-first: the session being opened is imported on demand (paid
 * once, then instant forever), and a background sweep drains the rest so the
 * app never blocks startup on a large backlog.
 */

const fs = require("node:fs");
const path = require("node:path");
const { sessionMessagesDir, sessionMessagesImportedDir } = require("../config");

function safeMessageFileName(sessionId) {
  return `${String(sessionId || "").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function legacyFilePath(sessionId) {
  return path.join(sessionMessagesDir(), safeMessageFileName(sessionId));
}

function importedFlagKey(sessionId) {
  return `imported:${sessionId}`;
}

function readMessages(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed?.messages) ? parsed.messages : [];
  } catch {
    return null;
  }
}

function archiveFile(filePath) {
  try {
    const destDir = sessionMessagesImportedDir();
    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(filePath, path.join(destDir, path.basename(filePath)));
  } catch (err) {
    console.warn("[legacy-import] could not archive", filePath, err?.message || err);
  }
}

/**
 * Import a single session's legacy file if it hasn't been imported yet.
 * @param {object} [opts]
 * @param {(message:object)=>object} [opts.transform]  per-message hook (e.g. artifact backfill)
 * @returns {{ imported: boolean, count: number }}
 */
function importSession(store, sessionId, opts = {}) {
  if (!sessionId) return { imported: false, count: 0 };
  if (store.meta(importedFlagKey(sessionId))) return { imported: false, count: 0 };

  const filePath = legacyFilePath(sessionId);
  if (!fs.existsSync(filePath)) {
    // Nothing to import — record the flag so we never re-check this session.
    store.setMeta(importedFlagKey(sessionId), "none");
    return { imported: false, count: 0 };
  }

  let messages = readMessages(filePath);
  if (messages === null) {
    console.warn("[legacy-import] unreadable file, leaving in place:", filePath);
    return { imported: false, count: 0 };
  }
  if (typeof opts.transform === "function") messages = messages.map(opts.transform);

  let count = 0;
  if (messages.length > 0) count = store.bulkInsert(sessionId, messages);
  store.setMeta(importedFlagKey(sessionId), `done:${count}`);
  archiveFile(filePath);
  if (count > 0) console.info(`[legacy-import] imported ${count} message(s) for ${sessionId}`);
  return { imported: true, count };
}

/** Session ids that still have a legacy file on disk. */
function pendingSessionIds() {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionMessagesDir());
  } catch {
    return [];
  }
  const ids = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(sessionMessagesDir(), name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed?.sessionId) ids.push(parsed.sessionId);
    } catch {
      /* skip unreadable */
    }
  }
  return ids;
}

/**
 * Drain remaining legacy files in the background, one per tick, so a large
 * backlog never blocks the main thread for long. `isImported` lets the caller
 * skip sessions already handled lazily.
 */
function sweepInBackground(store, { onDone, transformForSession } = {}) {
  const queue = pendingSessionIds();
  if (queue.length === 0) {
    onDone?.({ sessions: 0 });
    return;
  }
  let sessions = 0;
  const step = () => {
    const sessionId = queue.shift();
    if (!sessionId) {
      onDone?.({ sessions });
      return;
    }
    try {
      const transform = transformForSession ? transformForSession(sessionId) : null;
      const res = importSession(store, sessionId, { transform });
      if (res.imported) sessions += 1;
    } catch (err) {
      console.warn("[legacy-import] sweep failed for", sessionId, err?.message || err);
    }
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

module.exports = { importSession, sweepInBackground, pendingSessionIds, legacyFilePath };
