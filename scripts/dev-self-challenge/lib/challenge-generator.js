"use strict";

const { analyzeDiff, hasUnchallengedChanges } = require("./diff-analyzer.js");

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MIN_ROUNDS_WITHOUT_DIFF = 3;

const MODULE_DIMENSION_MAP = {
  "agent-session": "error-handling",
  "turn-orchestrator": "cross-module",
  "scheduled-tasks": "cross-module",
  "session-manager": "refactoring",
};

const CAPABILITY_PROMPTS = {
  "code-analysis":
    "分析 src/main/ 目录下最大的 2 个文件，总结它们的职责、相互依赖关系，并指出是否有职责不清或循环依赖。输出分析报告。",
  "refactoring":
    "扫描 scripts/ 目录，找出超过 200 行的测试文件，评估其是否可以拆分。对最需要拆分的一个文件提出具体方案。",
  "error-handling":
    "随机选取 src/main/ 下 3 个文件，检查其错误处理是否完善。对于每个函数，检查 try-catch 覆盖、错误传播和用户提示。输出检查报告。",
  "test-generation":
    "检查 scripts/ 目录下最近新增或修改的模块是否都有对应的测试文件。找出测试覆盖最薄弱的模块，输出缺失列表。",
  "multi-locale":
    "扫描 src/ 目录中所有包含中文文案的文件，检查是否所有面向用户的字符串都支持国际化。输出缺失列表。",
  "cross-module":
    "选取 src/main/ 下 3 个交互最频繁的模块（如 turn-orchestrator 与 agent-session），追踪它们之间的调用链，评估耦合度并提出解耦建议。",
};

class ChallengeGenerator {
  /**
   * @param {object} config - Config with challengeDataDir() method.
   * @param {object} store - ChallengeStore instance.
   * @param {object} tracker - CapabilityTracker instance.
   */
  constructor(config, store, tracker) {
    this._config = config;
    this._store = store;
    this._tracker = tracker;
  }

  // ==================== Public API ====================

  /**
   * Generate a challenge based on diff and capability state.
   *
   * @param {object} [opts]
   * @param {string} [opts.diff] - Git diff output string.
   * @param {number} [opts.lastChallengeAt] - Override last challenge timestamp (ms) for testing.
   * @returns {object|null} Challenge object or null if no challenge is needed.
   */
  generate(opts = {}) {
    const diff = opts.diff;
    const lastChallengeAt = opts.lastChallengeAt;

    // 1. Cooldown check
    const lastTime = lastChallengeAt || this._getLastChallengeTime();
    if (lastTime && Date.now() - lastTime < COOLDOWN_MS) {
      return null;
    }

    const history = this._store.listHistory();

    // 2. Diff-driven (priority)
    if (diff) {
      const analysis = analyzeDiff(diff);
      if (analysis.hasChanges && hasUnchallengedChanges(diff, history)) {
        const moduleNames = [...analysis.modules];
        const dimension = this._pickDimension(moduleNames[0] || "");
        const prompt = this._buildDiffPrompt(analysis.changedFiles);
        const changedFiles = analysis.changedFiles.map((f) => f.path);
        return { type: "diff-driven", prompt, dimension, changedFiles };
      }
    }

    // 3. Capability-driven (fallback)
    const roundsWithoutDiff = this._countRoundsWithoutDiff(history);
    if (roundsWithoutDiff >= MIN_ROUNDS_WITHOUT_DIFF) {
      const weakest = this._tracker.getWeakestDimension();
      if (weakest && CAPABILITY_PROMPTS[weakest.key]) {
        return {
          type: "capability-driven",
          prompt: CAPABILITY_PROMPTS[weakest.key],
          dimension: weakest.key,
          changedFiles: [],
        };
      }
    }

    // 4. Nothing to do
    return null;
  }

  // ==================== Internal helpers ====================

  /**
   * Read the timestamp of the most recent challenge from the store.
   * @returns {number|null} Timestamp in milliseconds, or null if no history.
   */
  _getLastChallengeTime() {
    const entries = this._store.listHistory({ limit: 1 });
    if (entries.length === 0) return null;
    return new Date(entries[0].timestamp).getTime();
  }

  /**
   * Map a module name to a skill dimension.
   * @param {string} moduleName - Module basename (without extension).
   * @returns {string} Dimension key.
   */
  _pickDimension(moduleName) {
    return MODULE_DIMENSION_MAP[moduleName] || "code-analysis";
  }

  /**
   * Build a prompt for a diff-driven challenge.
   * @param {Array<{path: string}>} changedFiles - List of changed files.
   * @returns {string} Challenge prompt in Chinese.
   */
  _buildDiffPrompt(changedFiles) {
    const fileList = changedFiles.map((f) => f.path).join("、");
    return (
      `检测到以下文件变更：${fileList}。` +
      "请评估这些变更的影响范围，检查是否引入潜在问题，并确认相关模块的测试覆盖充分。"
    );
  }

  /**
   * Count consecutive challenges that are NOT diff-driven, starting from
   * the most recent entry.
   * @param {Array} history - History entries, most recent first.
   * @returns {number} Consecutive non-diff-driven challenge count.
   */
  _countRoundsWithoutDiff(history) {
    let count = 0;
    for (const entry of history) {
      if (entry.type === "diff-driven") break;
      count++;
    }
    return count;
  }
}

module.exports = { ChallengeGenerator, CAPABILITY_PROMPTS };
