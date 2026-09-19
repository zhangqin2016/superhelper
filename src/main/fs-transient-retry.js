"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Transient filesystem lock errors. On Windows, antivirus real-time scanning
// and search indexers briefly hold freshly written files; lingering
// soffice.exe/python.exe hold pack files. Operations that look "impossible to
// fail" (rename, rm -rf) then throw EPERM/EBUSY/EACCES mid-operation.
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

/** Rename with retry: retrying over a few seconds absorbs the AV scan that
 *  makes the first rename fail even though the operation is fine. */
async function renameWithRetry(from, to, attempts = 6) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts - 1 || !TRANSIENT_FS_CODES.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
}

/** Sync rm -rf with the same transient-lock retry, for paths that cannot be
 *  async (e.g. lingering soffice.exe/python.exe locking pack files on
 *  uninstall; rmSync recursive throws MID-DELETE otherwise). */
function rmDirWithRetry(dir, attempts = 4) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= attempts - 1 || !TRANSIENT_FS_CODES.has(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * (attempt + 1));
    }
  }
}

/** The retry schedule Windows AV/indexer locks are absorbed by: 300 ms, 600 ms,
 *  900 ms … — the same for every helper here, so "how long do we wait for a
 *  lock" is decided once. */
function transientBackoffMs(attempt) {
  return 300 * (attempt + 1);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Sync rename with the transient-lock retry; throws after the schedule is
 *  exhausted (for callers that must know the write did not land). */
function renameSyncWithRetryOrThrow(from, to, attempts = 6) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts - 1 || !TRANSIENT_FS_CODES.has(error?.code)) throw error;
      sleepSync(transientBackoffMs(attempt));
    }
  }
}

/** Sync rename-with-retry that NEVER throws: transient errors get short
 *  retries; persistent ones are logged and swallowed so a filesystem blip
 *  can't crash the main process from a timer callback. Callers must tolerate
 *  a skipped write (atomic tmp+rename keeps the on-disk file intact). */
function renameSyncWithRetry(from, to, attempts = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error) {
      if (attempt >= attempts - 1 || !TRANSIENT_FS_CODES.has(error?.code)) {
        console.warn(`[fs-transient-retry] rename skipped (${from} → ${to}): ${error?.message || error}`);
        try { fs.rmSync(from, { force: true }); } catch { /* best effort */ }
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60 * (attempt + 1));
    }
  }
}

/** Atomically replace a directory: rename the old one aside, rename the new
 *  one in, roll back on failure. A locked backup dir never fails an install
 *  that already succeeded on disk (a stray backup dir is harmless). */
/**
 * Swap a freshly built pack into place.
 *
 * Between the two renames the pack's path does not exist. The window is
 * sub-millisecond and only a process resolving that path AT that instant is
 * affected — anything already running keeps its open inode — but it is real: a
 * long-task run once saw `python3` briefly unavailable, recovered on retry, and
 * the only way to attribute it afterwards was to line up timestamps by hand.
 *
 * So the swap says so. The gap is not worth engineering away — a replacement
 * only happens when a pack has actually failed its health probe twice, so the
 * alternative is leaving a broken pack broken — but it IS worth being able to
 * recognise in a log the next time someone asks what happened.
 */
async function replacePackDirectory(stagingPath, targetPath) {
  const startedAt = Date.now();
  const parentDir = path.dirname(targetPath);
  const backupPath = path.join(parentDir, `.${path.basename(targetPath)}-${Date.now()}.previous`);
  let backedUp = false;
  fs.mkdirSync(parentDir, { recursive: true });
  fs.rmSync(backupPath, { recursive: true, force: true });
  if (fs.existsSync(targetPath)) {
    await renameWithRetry(targetPath, backupPath);
    backedUp = true;
  }
  try {
    await renameWithRetry(stagingPath, targetPath);
    // The one line that turns "python3 vanished for an instant" from a mystery
    // into a lookup. Timing included, because the window is what matters.
    console.info(`[runtime-pack] replaced ${targetPath} (path absent for ${Date.now() - startedAt} ms; a process resolving it in that window sees ENOENT and should retry)`);
    if (backedUp) {
      try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch { /* leftover backup is harmless */ }
    }
  } catch (error) {
    if (backedUp && fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
      try {
        fs.renameSync(backupPath, targetPath);
      } catch {
        // If rollback fails, keep the original error; callers report the install failure.
      }
    }
    throw error;
  }
}

module.exports = {
  TRANSIENT_FS_CODES,
  renameSyncWithRetryOrThrow,
  transientBackoffMs,
  TRANSIENT_FS_CODES,
  renameWithRetry,
  rmDirWithRetry,
  renameSyncWithRetry,
  replacePackDirectory,
};
