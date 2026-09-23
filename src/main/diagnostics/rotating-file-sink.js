"use strict";

/**
 * An append-only file that cannot grow without bound.
 *
 * Lily had two diagnostic sinks and neither was bounded in the same way. The
 * main-process log went to the console and therefore nowhere a user could
 * retrieve it after closing the app — so a bug report could never carry the one
 * artefact that explains it. The watchdog did write a file, with no rotation,
 * no cap and, in the whole repository, no reader: measured at 47 MB and 176,711
 * lines across 86 days on a real install, growing at roughly half a megabyte a
 * day, forever, for nothing.
 *
 * Both want the same thing, so it is defined once, here: a file that accepts
 * lines, rotates when it gets large, and keeps a fixed number of generations.
 * The total footprint is therefore `maxBytes * (maxFiles + 1)` — a number the
 * caller chooses up front rather than discovers years later.
 *
 * Writing must never be the thing that breaks the app. Every operation is
 * wrapped: a full disk, a removed directory, a permission change mid-run all
 * degrade to "this line was not written", never to a thrown error on whatever
 * path happened to be logging.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 4;

/** `app.log` → `app.log.1` … `app.log.<n>`; the oldest generation is dropped. */
function generationPath(filePath, index) {
  return index === 0 ? filePath : `${filePath}.${index}`;
}

/**
 * @param {object} options
 * @param {string} options.filePath          the live file; generations sit beside it
 * @param {number} [options.maxBytes]        rotate once the live file reaches this
 * @param {number} [options.maxFiles]        how many rotated generations to keep
 * @param {object} [options.fsImpl]          injectable for tests
 * @returns {{ write: Function, bytesWritten: Function, paths: Function, close: Function }}
 */
function createRotatingFileSink({
  filePath,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  fsImpl = fs,
} = {}) {
  const limit = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
  const generations = Math.max(0, Math.min(Number(maxFiles) ?? DEFAULT_MAX_FILES, 20));
  let size = 0;
  let ready = false;
  let disabled = !filePath;

  function prepare() {
    if (ready || disabled) return ready;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      size = fsImpl.existsSync(filePath) ? Number(fsImpl.statSync(filePath).size) || 0 : 0;
      ready = true;
    } catch {
      // An unwritable location is not worth retrying on every line.
      disabled = true;
    }
    return ready;
  }

  /** Shift every generation up one and drop what falls off the end. */
  function rotate() {
    try {
      if (generations === 0) {
        fsImpl.rmSync(filePath, { force: true });
        size = 0;
        return;
      }
      fsImpl.rmSync(generationPath(filePath, generations), { force: true });
      for (let index = generations - 1; index >= 0; index -= 1) {
        const from = generationPath(filePath, index);
        if (!fsImpl.existsSync(from)) continue;
        // Rename is atomic, so a crash mid-rotation loses at most one
        // generation's name, never the live file's contents.
        fsImpl.renameSync(from, generationPath(filePath, index + 1));
      }
      size = 0;
    } catch {
      // Rotation failing must not stop logging; the file simply keeps growing
      // until the next attempt succeeds.
    }
  }

  return {
    /** Append one line. Returns whether it was written. */
    write(line) {
      if (disabled || !prepare()) return false;
      const text = `${String(line ?? "").replace(/\n+$/, "")}\n`;
      try {
        // Rotate BEFORE writing so a single oversized line still lands in a
        // file of its own rather than pushing the live file past its bound.
        if (size > 0 && size + Buffer.byteLength(text) > limit) rotate();
        fsImpl.appendFileSync(filePath, text, "utf8");
        size += Buffer.byteLength(text);
        return true;
      } catch {
        return false;
      }
    },
    /** Bytes in the live generation, for tests and diagnostics. */
    bytesWritten() {
      return size;
    },
    /** Every path this sink may occupy, newest first. */
    paths() {
      const out = [];
      for (let index = 0; index <= generations; index += 1) out.push(generationPath(filePath, index));
      return out;
    },
    /** The worst case this sink can ever occupy on disk. */
    maxTotalBytes() {
      return limit * (generations + 1);
    },
    close() {
      ready = false;
    },
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  createRotatingFileSink,
  generationPath,
};
