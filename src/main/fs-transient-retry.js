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
async function replacePackDirectory(stagingPath, targetPath) {
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
  renameWithRetry,
  rmDirWithRetry,
  renameSyncWithRetry,
  replacePackDirectory,
};
