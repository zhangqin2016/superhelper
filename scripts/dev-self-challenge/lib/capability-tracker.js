"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DIMENSIONS = {
  "code-analysis":    { score: 5, description: "分析陌生模块、追踪调用链" },
  "refactoring":      { score: 5, description: "拆分大函数、消除重复" },
  "error-handling":   { score: 5, description: "边界条件、异常恢复" },
  "test-generation":  { score: 5, description: "为无测试代码写测试" },
  "multi-locale":     { score: 5, description: "多语言（中英阿）场景" },
  "cross-module":     { score: 5, description: "跨多模块的复杂实现" },
};

class CapabilityTracker {
  /**
   * @param {object} config - Config with challengeDataDir() method.
   * @param {object} store - ChallengeStore instance.
   */
  constructor(config, store) {
    this._config = config;
    this._store = store;
  }

  // ==================== Internal helpers ====================

  /** @returns {string} Path to capabilities data file. */
  _file() {
    return path.join(this._config.challengeDataDir(), "capabilities.json");
  }

  /** Ensure the data directory exists. */
  _ensureDir() {
    fs.mkdirSync(this._config.challengeDataDir(), { recursive: true });
  }

  /**
   * Read all stored dimension data from disk.
   * @returns {object|null} Map of key -> entry, or null if file doesn't exist.
   */
  _readStored() {
    try {
      const raw = fs.readFileSync(this._file(), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Write dimension data to disk.
   * @param {object} data - Map of key -> entry.
   */
  _writeStored(data) {
    this._ensureDir();
    fs.writeFileSync(this._file(), JSON.stringify(data, null, 2), "utf8");
  }

  /**
   * Build a full dimension entry from a default definition.
   * @param {string} key
   * @param {object} def - {score, description}
   * @returns {object}
   */
  _buildDefaultEntry(key, def) {
    return {
      key,
      score: def.score,
      description: def.description,
      lastTested: null,
      trend: "stable",
      consecutiveFails: 0,
      paused: false,
    };
  }

  // ==================== Public API ====================

  /**
   * List all skill dimensions.
   * Reads from persisted file, falls back to DEFAULT_DIMENSIONS.
   * @returns {Array<{key, score, description, lastTested, trend, consecutiveFails, paused}>}
   */
  listDimensions() {
    const stored = this._readStored();

    return Object.entries(DEFAULT_DIMENSIONS).map(([key, def]) => {
      const entry = stored && stored[key];
      if (entry) {
        return {
          key,
          score: entry.score,
          description: def.description,
          lastTested: entry.lastTested || null,
          trend: entry.trend || "stable",
          consecutiveFails: entry.consecutiveFails || 0,
          paused: !!entry.paused,
        };
      }
      return this._buildDefaultEntry(key, def);
    });
  }

  /**
   * Get a single dimension by its key.
   * @param {string} key
   * @returns {object|null}
   */
  getDimension(key) {
    if (!(key in DEFAULT_DIMENSIONS)) return null;
    const dims = this.listDimensions();
    return dims.find((d) => d.key === key) || null;
  }

  /**
   * Update a dimension with new score and verdict.
   *
   * @param {string} key - Dimension key.
   * @param {{score: number, verdict: string}} patch
   *   score clamped to 0-10.
   *   verdict: "pass" or "fail".
   * @returns {object|null} Updated dimension entry, or null if key not found.
   */
  updateDimension(key, patch) {
    if (!(key in DEFAULT_DIMENSIONS)) return null;

    const stored = this._readStored() || {};
    const prevEntry = stored[key] || {};
    const prevScore = prevEntry.score != null
      ? prevEntry.score
      : DEFAULT_DIMENSIONS[key].score;

    // Clamp score to 0-10
    const newScore = Math.max(0, Math.min(10, patch.score));

    // Determine trend
    let trend;
    if (newScore > prevScore) {
      trend = "up";
    } else if (newScore < prevScore) {
      trend = "down";
    } else {
      trend = prevEntry.trend || "stable";
    }

    // Count consecutive fails
    const consecutiveFails = patch.verdict === "fail"
      ? (prevEntry.consecutiveFails || 0) + 1
      : 0;

    const paused = consecutiveFails >= 2;

    const entry = {
      score: newScore,
      description: DEFAULT_DIMENSIONS[key].description,
      lastTested: new Date().toISOString(),
      trend,
      consecutiveFails,
      paused,
    };

    stored[key] = entry;

    // Ensure all default dimensions are preserved in storage
    for (const [dk, dv] of Object.entries(DEFAULT_DIMENSIONS)) {
      if (!stored[dk]) {
        stored[dk] = { score: dv.score, description: dv.description };
      }
    }

    this._writeStored(stored);

    return { key, ...entry };
  }

  /**
   * Get the weakest (lowest score) non-paused dimension.
   * @returns {object|null} Weakest dimension, or null if all are paused.
   */
  getWeakestDimension() {
    const dims = this.listDimensions();
    const active = dims.filter((d) => !d.paused);
    if (active.length === 0) return null;
    return active.reduce((min, d) => (d.score < min.score ? d : min));
  }
}

module.exports = { CapabilityTracker, DEFAULT_DIMENSIONS };
