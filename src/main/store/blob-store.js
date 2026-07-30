"use strict";

/**
 * Content-addressed blob storage on the filesystem.
 *
 * Bytes are stored once, keyed by sha256, at blobs/<hash[0:2]>/<hash>. Identical
 * content (e.g. the same image pasted twice) collapses to one file for free.
 * This module owns ONLY the bytes-on-disk side; the catalog row + refcount live
 * in the message database (see message-store), kept transactional with inserts.
 *
 * Writes are content-addressed and therefore idempotent: an orphaned file from a
 * rolled-back transaction is harmless and reclaimable by GC.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class BlobStore {
  /** @param {string} baseDir  directory that holds the sharded blob tree */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  static hash(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  pathFor(hash) {
    return path.join(this.baseDir, hash.slice(0, 2), hash);
  }

  exists(hash) {
    return fs.existsSync(this.pathFor(hash));
  }

  verify(hash, expectedBytes) {
    const filePath = this.pathFor(hash);
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW)
      ? fs.constants.O_NOFOLLOW
      : 0;
    let fd;
    try {
      const before = fs.lstatSync(filePath, { bigint: true });
      if (before.isSymbolicLink() || !before.isFile()) return false;
      if (Number.isSafeInteger(expectedBytes) && before.size !== BigInt(expectedBytes)) {
        return false;
      }
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (
        !opened.isFile()
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.size !== before.size
      ) {
        return false;
      }
      const digest = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      for (;;) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        digest.update(buffer.subarray(0, bytesRead));
      }
      return total === Number(opened.size) && digest.digest("hex") === hash;
    } catch {
      return false;
    } finally {
      if (Number.isInteger(fd)) {
        try {
          fs.closeSync(fd);
        } catch {
          return false;
        }
      }
    }
  }

  _removeBackup(backupPath) {
    fs.rmSync(backupPath, { force: true });
  }

  beginAtomicReplace(buffer, hash = BlobStore.hash(buffer)) {
    const bytes = Buffer.from(buffer);
    if (BlobStore.hash(bytes) !== hash) {
      throw Object.assign(new Error("Blob replacement hash mismatch"), {
        code: "BLOB_HASH_MISMATCH",
      });
    }
    const dest = this.pathFor(hash);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const current = fs.lstatSync(dest, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile()) {
      throw Object.assign(new Error("Blob replacement target is invalid"), {
        code: "BLOB_TARGET_INVALID",
      });
    }

    const nonce = crypto.randomBytes(12).toString("hex");
    const backup = `${dest}.backup-${process.pid}-${nonce}`;
    const temp = `${dest}.replace-${process.pid}-${nonce}`;
    let state = "preparing";
    try {
      fs.linkSync(dest, backup);
      const fd = fs.openSync(
        temp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, dest);
      if (!this.verify(hash, bytes.length)) {
        throw Object.assign(new Error("Blob replacement verification failed"), {
          code: "BLOB_REPLACEMENT_INVALID",
        });
      }
      state = "active";
    } catch (error) {
      let rollbackFailure = null;
      try {
        if (fs.existsSync(backup)) fs.renameSync(backup, dest);
      } catch (failure) {
        rollbackFailure = Object.assign(new Error("Blob replacement rollback failed"), {
          code: "BLOB_ROLLBACK_FAILED",
          cause: failure,
        });
      } finally {
        try {
          fs.rmSync(temp, { force: true });
        } catch {
          // No final blob points at the private replacement temp.
        }
      }
      if (rollbackFailure) throw rollbackFailure;
      throw error;
    }

    const commitCleanup = () => {
      if (state !== "active" && state !== "cleanup_pending") return false;
      try {
        this._removeBackup(backup);
      } catch {
        state = "cleanup_pending";
        return false;
      }
      state = "committed";
      return true;
    };
    const rollback = () => {
      if (state !== "active" && state !== "cleanup_pending") return false;
      fs.renameSync(backup, dest);
      state = "rollback";
      return true;
    };
    return Object.freeze({
      get state() {
        return state;
      },
      get backupPath() {
        return backup;
      },
      commit: commitCleanup,
      commitCleanup,
      rollback,
    });
  }

  /**
   * Write bytes if not already present. Returns { hash, bytes }.
   * Atomic via temp-file + rename so a crash mid-write never leaves a partial
   * blob at its final (content-addressed) path.
   */
  write(buffer, hash = BlobStore.hash(buffer)) {
    const dest = this.pathFor(hash);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp-${process.pid}-${buffer.length}`;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, dest);
    }
    return { hash, bytes: buffer.length };
  }

  /** @returns {Buffer|null} */
  read(hash) {
    try {
      return fs.readFileSync(this.pathFor(hash));
    } catch {
      return null;
    }
  }

  remove(hash) {
    try {
      fs.rmSync(this.pathFor(hash), { force: true });
    } catch {
      /* best effort */
    }
  }
}

module.exports = { BlobStore };
