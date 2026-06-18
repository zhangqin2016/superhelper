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
