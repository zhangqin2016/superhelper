"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const C = require("./constants");
const { codedError, stableJson } = require("./persistence-codec");

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SHARD_PATTERN = /^[a-f0-9]{2}$/;
const TEMP_PATTERN = /^([a-f0-9]{64})\.tmp-([1-9][0-9]*)-(0|[1-9][0-9]*)$/;
const BACKUP_PATTERN = /^([a-f0-9]{64})\.backup-([1-9][0-9]*)-([a-f0-9]{24})$/;
const REPLACEMENT_CLEANUP_ATTEMPTS = 2;

function invalidAsset(index, field, message) {
  return codedError("CHARACTER_ASSET_INVALID", message, {
    limitsVersion: C.CHARACTER_ASSET_LIMITS_VERSION,
    index,
    field,
  });
}

function assetLimit(limitKind, limit, actual, index) {
  return codedError(
    "CHARACTER_ASSET_LIMIT_EXCEEDED",
    `Character asset ${limitKind} exceeds ${limit}`,
    {
      limitsVersion: C.CHARACTER_ASSET_LIMITS_VERSION,
      limitKind,
      limit,
      actual,
      ...(index == null ? {} : { index }),
    },
  );
}

function boundedNumber(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(Math.floor(number), maximum));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashFile(filePath, maxBytes) {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(filePath, "r");
  let total = 0;
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return digest.digest("hex");
      total += bytesRead;
      if (total > maxBytes) return null;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
}

class CharacterAssetLifecycle {
  constructor(db, blobs) {
    this.db = db;
    this.blobs = blobs;
    this.pendingReplacementCleanups = new Set();
  }

  prepare(assets) {
    if (!Array.isArray(assets)) throw invalidAsset(null, "assets", "assets must be an array");
    if (assets.length > C.MAX_CHARACTER_ASSET_COUNT) {
      throw assetLimit("count", C.MAX_CHARACTER_ASSET_COUNT, assets.length);
    }

    let totalBytes = 0;
    const admitted = assets.map((asset, index) => {
      if (!asset || typeof asset !== "object") {
        throw invalidAsset(index, "asset", "asset must be an object");
      }
      const value = asset.data ?? asset.buffer ?? asset.bytes;
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        throw invalidAsset(index, "data", "asset data must be bytes");
      }
      const byteLength = value.byteLength;
      if (byteLength > C.MAX_CHARACTER_ASSET_BYTES) {
        throw assetLimit("perAssetBytes", C.MAX_CHARACTER_ASSET_BYTES, byteLength, index);
      }
      totalBytes += byteLength;
      if (totalBytes > C.MAX_CHARACTER_ASSET_TOTAL_BYTES) {
        throw assetLimit(
          "aggregateBytes",
          C.MAX_CHARACTER_ASSET_TOTAL_BYTES,
          totalBytes,
          index,
        );
      }
      if (typeof asset.purpose !== "string" || !asset.purpose) {
        throw invalidAsset(index, "purpose", "asset purpose is required");
      }
      const purposeBytes = Buffer.byteLength(asset.purpose, "utf8");
      if (purposeBytes > C.MAX_CHARACTER_ASSET_PURPOSE_BYTES) {
        throw assetLimit(
          "purposeBytes",
          C.MAX_CHARACTER_ASSET_PURPOSE_BYTES,
          purposeBytes,
          index,
        );
      }
      if (asset.mime != null && typeof asset.mime !== "string") {
        throw invalidAsset(index, "mime", "asset MIME must be a string or null");
      }
      const mime = asset.mime == null ? null : asset.mime;
      const mimeBytes = Buffer.byteLength(mime || "", "utf8");
      if (mimeBytes > C.MAX_CHARACTER_ASSET_MIME_BYTES) {
        throw assetLimit("mimeBytes", C.MAX_CHARACTER_ASSET_MIME_BYTES, mimeBytes, index);
      }
      return { value, byteLength, purpose: asset.purpose, mime };
    });

    const unique = new Map();
    for (const [index, asset] of admitted.entries()) {
      const data = Buffer.from(asset.value);
      const hash = crypto.createHash("sha256").update(data).digest("hex");
      const key = `${hash}\0${asset.purpose}`;
      const prior = unique.get(key);
      if (prior && prior.mime !== asset.mime) {
        throw invalidAsset(
          index,
          "mime",
          "duplicate asset references must use the same MIME",
        );
      }
      if (!prior) {
        unique.set(key, {
          hash,
          bytes: asset.byteLength,
          mime: asset.mime,
          purpose: asset.purpose,
          data,
        });
      }
    }
    return [...unique.values()].sort((left, right) => {
      const leftJson = stableJson({
        hash: left.hash,
        bytes: left.bytes,
        mime: left.mime,
        purpose: left.purpose,
      });
      const rightJson = stableJson({
        hash: right.hash,
        bytes: right.bytes,
        mime: right.mime,
        purpose: right.purpose,
      });
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    });
  }

  writeForMutation(assets, mutation) {
    this._retryPendingReplacementCleanups();
    const createdHashes = [];
    const replacements = [];
    const writtenHashes = new Set();
    try {
      for (const asset of assets) {
        if (writtenHashes.has(asset.hash)) continue;
        writtenHashes.add(asset.hash);
        const existed = this.blobs.exists(asset.hash);
        this.blobs.write(asset.data, asset.hash);
        if (!existed && this.blobs.exists(asset.hash)) createdHashes.push(asset.hash);
        if (!this.blobs.verify(asset.hash, asset.bytes)) {
          if (!this.blobs.exists(asset.hash)) {
            throw codedError(
              "CHARACTER_BLOB_CORRUPT",
              "Character asset blob is unavailable",
            );
          }
          try {
            replacements.push(this.blobs.beginAtomicReplace(asset.data, asset.hash));
          } catch {
            throw codedError(
              "CHARACTER_BLOB_CORRUPT",
              "Character asset blob could not be repaired",
            );
          }
        }
      }
      const result = mutation();
      for (const replacement of replacements) {
        this._commitReplacementCleanup(replacement);
      }
      return result;
    } catch (error) {
      let rollbackFailure = null;
      for (const replacement of replacements.reverse()) {
        try {
          replacement.rollback();
        } catch (failure) {
          rollbackFailure ||= failure;
        }
      }
      for (const hash of createdHashes) {
        if (!this.db.get("SELECT 1 FROM blobs WHERE hash = ?", hash)) {
          this.blobs.remove(hash);
        }
      }
      if (rollbackFailure) {
        throw codedError(
          "CHARACTER_BLOB_CORRUPT",
          "Character asset blob rollback failed",
        );
      }
      throw error;
    }
  }

  _cleanupReplacement(replacement) {
    const cleanup = typeof replacement?.commitCleanup === "function"
      ? replacement.commitCleanup
      : replacement?.commit;
    if (typeof cleanup !== "function") return false;
    try {
      return cleanup.call(replacement) === true;
    } catch {
      return false;
    }
  }

  _commitReplacementCleanup(replacement) {
    for (let attempt = 0; attempt < REPLACEMENT_CLEANUP_ATTEMPTS; attempt += 1) {
      if (this._cleanupReplacement(replacement)) {
        this.pendingReplacementCleanups.delete(replacement);
        return true;
      }
    }
    this.pendingReplacementCleanups.add(replacement);
    return false;
  }

  _retryPendingReplacementCleanups() {
    let completed = 0;
    for (const replacement of [...this.pendingReplacementCleanups]) {
      if (this._commitReplacementCleanup(replacement)) completed += 1;
    }
    return {
      completed,
      remaining: this.pendingReplacementCleanups.size,
    };
  }

  _cursor() {
    return this.db.get(
      "SELECT value FROM schema_meta WHERE key = ?",
      C.CHARACTER_BLOB_RECONCILE_CURSOR_KEY,
    )?.value || "";
  }

  _setCursor(value) {
    this.db.run(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      C.CHARACTER_BLOB_RECONCILE_CURSOR_KEY,
      value,
    );
  }

  _clearCursor() {
    this.db.run(
      "DELETE FROM schema_meta WHERE key = ?",
      C.CHARACTER_BLOB_RECONCILE_CURSOR_KEY,
    );
  }

  _candidateBatch(cursor, limit) {
    if (!fs.existsSync(this.blobs.baseDir)) return { candidates: [], exhausted: true };
    const candidates = [];
    let exhausted = true;
    const shards = fs.readdirSync(this.blobs.baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SHARD_PATTERN.test(entry.name))
      .sort((left, right) => compareText(left.name, right.name));

    outer:
    for (const shard of shards) {
      const shardDir = path.join(this.blobs.baseDir, shard.name);
      const entries = fs.readdirSync(shardDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          if (HASH_PATTERN.test(entry.name) && entry.name.startsWith(shard.name)) {
            return {
              key: `${shard.name}/${entry.name}`,
              type: "final",
              hash: entry.name,
              filePath: path.join(shardDir, entry.name),
            };
          }
          const match = TEMP_PATTERN.exec(entry.name);
          if (match && match[1].startsWith(shard.name)) {
            return {
              key: `${shard.name}/${entry.name}`,
              type: "temp",
              hash: match[1],
              declaredBytes: match[3],
              filePath: path.join(shardDir, entry.name),
            };
          }
          const backupMatch = BACKUP_PATTERN.exec(entry.name);
          if (!backupMatch || !backupMatch[1].startsWith(shard.name)) return null;
          return {
            key: `${shard.name}/${entry.name}`,
            type: "backup",
            hash: backupMatch[1],
            filePath: path.join(shardDir, entry.name),
          };
        })
        .filter(Boolean)
        .sort((left, right) => compareText(left.key, right.key));
      for (const entry of entries) {
        if (entry.key <= cursor) continue;
        if (candidates.length >= limit) {
          exhausted = false;
          break outer;
        }
        candidates.push(entry);
      }
    }
    return { candidates, exhausted };
  }

  _preserveTemp(result, hash, reason) {
    result.preservedTemps += 1;
    result.tempIssues.push({ hash, reason });
  }

  _reconcileFinal(candidate, stat, now, grace, result) {
    if (this.db.get("SELECT 1 FROM blobs WHERE hash = ?", candidate.hash)) {
      result.skippedCataloged += 1;
      return;
    }
    if (now - stat.mtimeMs < grace) {
      result.skippedRecent += 1;
      return;
    }
    if (stat.size > C.MAX_CHARACTER_RECONCILE_FILE_BYTES) return;
    if (hashFile(candidate.filePath, C.MAX_CHARACTER_RECONCILE_FILE_BYTES)
      !== candidate.hash) return;
    if (this.db.get("SELECT 1 FROM blobs WHERE hash = ?", candidate.hash)) return;
    this.blobs.remove(candidate.hash);
    result.removed += 1;
    result.removedHashes.push(candidate.hash);
  }

  _reconcileTemp(candidate, stat, now, grace, result) {
    if (now - stat.mtimeMs < grace) {
      result.skippedRecent += 1;
      return;
    }
    const finalPath = this.blobs.pathFor(candidate.hash);
    if (fs.existsSync(finalPath)) {
      fs.rmSync(candidate.filePath, { force: true });
      result.removedTemps += 1;
      return;
    }
    const catalog = this.db.get(
      "SELECT bytes FROM blobs WHERE hash = ?",
      candidate.hash,
    );
    if (!catalog) {
      fs.rmSync(candidate.filePath, { force: true });
      result.removedTemps += 1;
      return;
    }

    const declaredBytes = Number(candidate.declaredBytes);
    if (!Number.isSafeInteger(declaredBytes)
      || declaredBytes !== stat.size
      || Number(catalog.bytes) !== stat.size
      || stat.size > C.MAX_CHARACTER_RECONCILE_FILE_BYTES) {
      this._preserveTemp(result, candidate.hash, "bytes_mismatch");
      return;
    }
    if (hashFile(candidate.filePath, C.MAX_CHARACTER_RECONCILE_FILE_BYTES)
      !== candidate.hash) {
      this._preserveTemp(result, candidate.hash, "hash_mismatch");
      return;
    }
    if (fs.existsSync(finalPath)) {
      fs.rmSync(candidate.filePath, { force: true });
      result.removedTemps += 1;
      return;
    }
    fs.renameSync(candidate.filePath, finalPath);
    result.recoveredTemps += 1;
    result.recoveredHashes.push(candidate.hash);
  }

  _reconcileBackup(candidate, stat, now, grace, result) {
    if (now - stat.mtimeMs < grace) {
      result.skippedRecent += 1;
      return;
    }
    const catalog = this.db.get(
      "SELECT bytes FROM blobs WHERE hash = ?",
      candidate.hash,
    );
    const expectedBytes = Number(catalog?.bytes);
    if (
      !catalog
      || !Number.isSafeInteger(expectedBytes)
      || expectedBytes < 0
      || expectedBytes > C.MAX_CHARACTER_RECONCILE_FILE_BYTES
      || !this.blobs.verify(candidate.hash, expectedBytes)
    ) {
      result.preservedBackups += 1;
      return;
    }
    fs.rmSync(candidate.filePath, { force: true });
    result.removedBackups += 1;
  }

  reconcile({ maxFiles, graceMs } = {}) {
    const replacementCleanup = this._retryPendingReplacementCleanups();
    const limit = Math.max(
      1,
      boundedNumber(maxFiles, C.MAX_CHARACTER_RECONCILE_FILES, C.MAX_CHARACTER_RECONCILE_FILES),
    );
    const grace = boundedNumber(
      graceMs,
      C.DEFAULT_CHARACTER_ORPHAN_GRACE_MS,
      Number.MAX_SAFE_INTEGER,
    );
    const result = {
      scanned: 0,
      removed: 0,
      removedHashes: [],
      skippedRecent: 0,
      skippedCataloged: 0,
      removedTemps: 0,
      recoveredTemps: 0,
      recoveredHashes: [],
      preservedTemps: 0,
      tempIssues: [],
      removedBackups: 0,
      preservedBackups: 0,
      completedReplacementCleanups: replacementCleanup.completed,
      pendingReplacementCleanups: replacementCleanup.remaining,
      errors: 0,
      limitReached: false,
    };
    const cursor = this._cursor();
    const batch = this._candidateBatch(cursor, limit);
    const now = Date.now();
    for (const candidate of batch.candidates) {
      result.scanned += 1;
      try {
        const stat = fs.lstatSync(candidate.filePath);
        if (stat.isFile()) {
          if (candidate.type === "temp") {
            this._reconcileTemp(candidate, stat, now, grace, result);
          } else if (candidate.type === "backup") {
            this._reconcileBackup(candidate, stat, now, grace, result);
          } else {
            this._reconcileFinal(candidate, stat, now, grace, result);
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          result.errors += 1;
          if (candidate.type === "temp") {
            this._preserveTemp(result, candidate.hash, "filesystem_error");
          } else if (candidate.type === "backup") {
            result.preservedBackups += 1;
          }
        }
      }
      this._setCursor(candidate.key);
    }
    if (batch.exhausted) {
      this._clearCursor();
    } else {
      result.limitReached = true;
    }
    result.cursor = batch.exhausted
      ? null
      : batch.candidates.at(-1)?.key || cursor || null;
    return result;
  }
}

module.exports = { CharacterAssetLifecycle };
