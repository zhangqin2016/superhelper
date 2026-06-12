"use strict";

const { ChallengeExecutor } = require("./challenge-executor.js");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Parse evaluation output text into structured result.
 *
 * Tries in order:
 * 1. Direct JSON.parse
 * 2. Extract from ```json ... ``` fence
 * 3. Find any top-level JSON object in the text
 *
 * @param {string} raw - Raw evaluation output text.
 * @returns {{scores: object, totalScore: number, verdict: string, issues: Array, suggestions: Array}|null}
 *   Parsed result or null if no valid JSON found.
 */
function parseEvaluationOutput(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }

  // 1. Try direct JSON.parse
  try {
    const parsed = JSON.parse(raw);
    if (_isValidEvaluationResult(parsed)) {
      return parsed;
    }
  } catch {
    // Not valid JSON, continue
  }

  // 2. Try extracting from ```json ... ``` fence
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (_isValidEvaluationResult(parsed)) {
        return parsed;
      }
    } catch {
      // Fence content not valid JSON, continue
    }
  }

  // 3. Try to find any JSON object in the text (scan for balanced braces)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (_isValidEvaluationResult(parsed)) {
        return parsed;
      }
    } catch {
      // Not valid JSON, return null
    }
  }

  return null;
}

/**
 * Check if a parsed value looks like a valid evaluation result object.
 * @param {*} value - Parsed value to check.
 * @returns {boolean}
 */
function _isValidEvaluationResult(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (typeof value.scores !== "object" || value.scores === null) {
    return false;
  }
  if (typeof value.totalScore !== "number") {
    return false;
  }
  if (typeof value.verdict !== "string") {
    return false;
  }
  if (!Array.isArray(value.issues)) {
    return false;
  }
  if (!Array.isArray(value.suggestions)) {
    return false;
  }
  return true;
}

class ChallengeEvaluator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] - Max evaluation time in ms (default 10 min).
   * @param {string} [opts.command] - Override the engine command (for testing).
   */
  constructor(opts = {}) {
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._command = opts.command;
  }

  /**
   * Build the evaluation prompt for the engine.
   *
   * @param {object} opts
   * @param {string} opts.task - Original challenge prompt.
   * @param {string} opts.output - Execution result output.
   * @param {string[]} [opts.changedFiles] - Array of changed file paths (optional).
   * @returns {string} Evaluation prompt.
   */
  _buildEvalPrompt(opts) {
    const { task, output, changedFiles } = opts;

    const changedFilesSection = Array.isArray(changedFiles) && changedFiles.length > 0
      ? `\n## 变更文件\n${changedFiles.join("\n")}\n`
      : "";

    return [
      "你是 Lily Workbench 的自我评估系统。请审查以下挑战执行结果。",
      "",
      `## 原始任务`,
      task,
      "",
      `## 执行输出`,
      output,
      changedFilesSection,
      `## 评估维度（每个 0-2 分，总分 0-10）`,
      "1. completeness - 任务完成度",
      "2. correctness - 代码正确性",
      "3. style - 风格一致性",
      "4. scope - 改动范围（最小化）",
      "5. robustness - 健壮性",
      "",
      `## 输出格式（纯 JSON）`,
      '{"scores":{"completeness":N,"correctness":N,"style":N,"scope":N,"robustness":N},"totalScore":N,"verdict":"pass|fail|partial","issues":[{"severity":"critical|minor","description":"..."}],"suggestions":[{"type":"rule|refactor|test","description":"..."}]}',
    ]
      .filter((line) => line !== undefined && line !== null)
      .join("\n");
  }

  /**
   * Evaluate a challenge execution result.
   *
   * 1. Validates inputs (task and output are required)
   * 2. Builds the evaluation prompt
   * 3. Spawns a ChallengeExecutor to run the eval prompt
   * 4. Parses the output using parseEvaluationOutput
   * 5. Returns structured result
   *
   * @param {object} opts
   * @param {string} opts.task - Original challenge prompt (required).
   * @param {string} opts.output - Execution result output (required).
   * @param {string[]} [opts.changedFiles] - Array of changed file paths (optional).
   * @param {string} [opts.cwd] - Working directory.
   * @returns {Promise<{ok: boolean, verdict: string, totalScore: number, scores: object|null, issues: Array, suggestions: Array, error?: string, rawOutput?: string}>}
   */
  async evaluate(opts = {}) {
    const { task, output, changedFiles, cwd } = opts;

    // Validate required inputs
    if (!task || !output) {
      return {
        ok: false,
        verdict: "error",
        totalScore: 0,
        scores: null,
        issues: [{ severity: "critical", description: "Missing task or output for evaluation" }],
        suggestions: [],
        error: "MISSING_INPUT",
      };
    }

    // Build evaluation prompt
    const evalPrompt = this._buildEvalPrompt({ task, output, changedFiles });

    // Execute the evaluation via ChallengeExecutor
    const executor = new ChallengeExecutor({
      timeoutMs: this._timeoutMs,
      command: this._command,
    });

    const execResult = await executor.execute({ prompt: evalPrompt, cwd });

    const rawOutput = execResult.output.trim();

    // Parse the evaluation output
    const parsed = parseEvaluationOutput(rawOutput);

    if (parsed) {
      return {
        ok: true,
        verdict: parsed.verdict,
        totalScore: parsed.totalScore,
        scores: parsed.scores,
        issues: parsed.issues,
        suggestions: parsed.suggestions,
        rawOutput,
      };
    }

    // Parsing failed, return what we have
    return {
      ok: true,
      verdict: "unknown",
      totalScore: 0,
      scores: null,
      issues: [],
      suggestions: [],
      rawOutput,
    };
  }
}

module.exports = { parseEvaluationOutput, ChallengeEvaluator };
