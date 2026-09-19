"use strict";

/**
 * Reading and writing a JSON file — the ONE implementation.
 *
 * Sixty modules each wrote `fs.writeFileSync(file, JSON.stringify(...))`, and
 * fourteen of them defined their own `writeJson`; not one of the plain ones was
 * atomic. A crash, a kill or a power cut in the middle of a write leaves a
 * truncated file, and the next launch reads `{}` — that is how the session
 * index was lost once (see session-store-dataloss-guard). Thirteen more modules
 * had each hand-rolled a temp+rename dance with its own temp naming, cleanup
 * and mode handling. Every JSON file now goes through here: written to a
 * temporary file in the same directory, then renamed over the target, so a
 * reader ever sees either the previous content or the new one.
 *
 * Node builtins plus the app's one transient-lock policy: MCP servers and
 * long-task workers use it from their own processes.
 */

const fs = require("node:fs");
const path = require("node:path");
// Windows AV scanners and indexers hold freshly written files for a moment;
// the codes that mean "held, try again" and how long to keep trying are
// decided once, in fs-transient-retry.js, for every rename in the app.
const { renameSyncWithRetryOrThrow } = require("./fs-transient-retry");

function serializeJson(value, { indent = 2, newline = false } = {}) {
  const text = indent ? JSON.stringify(value, null, indent) : JSON.stringify(value);
  return newline ? `${text}\n` : text;
}

/**
 * Parse a JSON file. Missing, unreadable or malformed → `fallback` (default
 * null), never a throw: state files are cache-like and a bad one must not stop
 * the app from starting.
 */
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Like readJson, but only a plain object counts — anything else is the fallback. */
function readJsonObject(file, fallback = null) {
  const parsed = readJson(file, fallback);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
}

/**
 * Write `value` as JSON, atomically: the bytes land in a temporary file next
 * to the target and are renamed over it, so the target is never half-written.
 *
 * @param {string} file
 * @param {unknown} value
 * @param {{ indent?: number, newline?: boolean, mode?: number, createDir?: boolean, renameAttempts?: number }} [options]
 *   indent     2 (default) for a readable file, 0 for compact
 *   newline    append a trailing newline
 *   mode       file mode for the new file (e.g. 0o600 for anything secret)
 *   createDir  create the parent directory (default true); false for a file
 *              that must not conjure its directory into being (a marker whose
 *              missing home means "this profile does not exist")
 */
function writeJson(file, value, options = {}) {
  const { indent = 2, newline = false, mode, createDir = true, renameAttempts = 6 } = options;
  const dir = path.dirname(file);
  if (createDir) fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temp, serializeJson(value, { indent, newline }), mode ? { encoding: "utf8", mode } : "utf8");
    // Windows: a reader or an indexer can hold the target (or the temp file)
    // for a moment; the rename is retried on the app-wide schedule instead of
    // failing the write outright.
    renameSyncWithRetryOrThrow(temp, file, renameAttempts);
    if (mode) {
      try { fs.chmodSync(file, mode); } catch { /* Windows ACLs are inherited */ }
    }
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* the target was not replaced; a stray temp is harmless */ }
  }
}

module.exports = { readJson, readJsonObject, serializeJson, writeJson };
