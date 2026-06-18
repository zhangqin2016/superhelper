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

/**
 * Session ids that still have a legacy file on disk, derived from the FILE NAME
 * only — never by reading file contents. Reading every file here would re-parse
 * the very multi-MB JSON blobs this migration exists to avoid, stalling startup.
 * Files are named `<sessionId>.json` (session ids are UUIDs, which the safe-name
 * sanitizer leaves untouched), so the basename is the session id.
 */
function pendingSessionIds() {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionMessagesDir());
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter(Boolean);
}

/**
 * Drain remaining legacy files in the background, one per tick, so a large
 * backlog never blocks the main thread for long.
 *
 * @param {object} [opts]
 * @param {(p:{done:number,total:number})=>void} [opts.onProgress]  after each file
 * @param {(p:{sessions:number,total:number})=>void} [opts.onDone]
 * @param {(sessionId:string)=>Function} [opts.transformForSession]  optional per-message hook
 */
function sweepInBackground(store, { onDone, onProgress, transformForSession } = {}) {
  const queue = pendingSessionIds();
  const total = queue.length;
  if (total === 0) {
    onDone?.({ sessions: 0, total: 0 });
    return;
  }
  let sessions = 0;
  let done = 0;
  onProgress?.({ done: 0, total });
  const step = () => {
    const sessionId = queue.shift();
    if (!sessionId) {
      onDone?.({ sessions, total });
      return;
    }
    try {
      const transform = transformForSession ? transformForSession(sessionId) : null;
      const res = importSession(store, sessionId, { transform });
      if (res.imported) sessions += 1;
    } catch (err) {
      console.warn("[legacy-import] sweep failed for", sessionId, err?.message || err);
    }
    done += 1;
    onProgress?.({ done, total });
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

module.exports = { importSession, sweepInBackground, pendingSessionIds, legacyFilePath };
