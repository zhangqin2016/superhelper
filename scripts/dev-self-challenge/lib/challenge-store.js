"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY = 500;
const DEFAULT_LIMIT = 50;

class ChallengeStore {
  constructor(config) {
    this._config = config;
  }

  /** @returns {string} The data directory path. */
  _dataDir() {
    return this._config.challengeDataDir();
  }

  /** @returns {string} Path to history.json */
  _historyFile() {
    return path.join(this._dataDir(), "history.json");
  }

  /** @returns {string} Path to lock file */
  _lockFile() {
    return path.join(this._dataDir(), "lock");
  }

  /** Ensure the data directory exists. */
  _ensureDir() {
    fs.mkdirSync(this._dataDir(), { recursive: true });
  }

  /**
   * Read all history entries from disk.
   * @returns {Array}
   */
  _readHistory() {
    try {
      const raw = fs.readFileSync(this._historyFile(), "utf8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  /**
   * Write history entries to disk, capped at MAX_HISTORY.
   * @param {Array} entries
   */
  _writeHistory(entries) {
    this._ensureDir();
    // Keep only the most recent MAX_HISTORY entries
    if (entries.length > MAX_HISTORY) {
      entries = entries.slice(entries.length - MAX_HISTORY);
    }
    fs.writeFileSync(this._historyFile(), JSON.stringify(entries, null, 2), "utf8");
  }

  // ==================== Public API ====================

  /**
   * List history entries, most recent first.
   * @param {object} [opts]
   * @param {number} [opts.limit=50] - Max entries to return (capped at 500).
   * @returns {Array}
   */
  listHistory(opts = {}) {
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_HISTORY);
    const entries = this._readHistory();
    // Return most recent first (reverse chronological)
    return entries.slice(-limit).reverse();
  }

  /**
   * Get a single history entry by its id.
   * @param {string} id
   * @returns {object|null}
   */
  getHistory(id) {
    const entries = this._readHistory();
    return entries.find((e) => e.id === id) || null;
  }

  /**
   * Append a new history entry.
   * Auto-generates id and timestamp.
   * @param {object} fields - {type, prompt, result, score, filesChanged, issues, suggestions, durationMs}
   * @returns {object} The created entry with id and timestamp.
   */
  appendHistory(fields) {
    const entry = {
      ...fields,
      id: "ch_" + crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
    const entries = this._readHistory();
    entries.push(entry);
    this._writeHistory(entries);
    return entry;
  }

  /**
   * Check if the store is locked (lock file exists).
   * @returns {boolean}
   */
  isLocked() {
    try {
      fs.statSync(this._lockFile());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if an existing lock is still valid (not stale).
   * @returns {boolean}
   */
  _isLockValid() {
    try {
      const content = fs.readFileSync(this._lockFile(), "utf8");
      const lockTime = new Date(content).getTime();
      return (Date.now() - lockTime) < LOCK_TIMEOUT_MS;
    } catch {
      return false;
    }
  }

  /**
   * Acquire a lock. Returns false if already locked (and lock is not stale).
   * @returns {boolean}
   */
  acquireLock() {
    this._ensureDir();

    if (this._isLockValid()) {
      return false;
    }

    try {
      fs.writeFileSync(this._lockFile(), new Date().toISOString(), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Release the lock.
   */
  releaseLock() {
    try {
      fs.unlinkSync(this._lockFile());
    } catch {
      // Idempotent — ignore if lock file doesn't exist
    }
  }
}

module.exports = { ChallengeStore };
