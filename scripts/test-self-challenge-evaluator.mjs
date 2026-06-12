#!/usr/bin/env node

import module from "node:module";
import path from "node:path";

const require = module.createRequire(import.meta.url);

const { parseEvaluationOutput, ChallengeEvaluator } = require("./dev-self-challenge/lib/challenge-evaluator.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeepEqual(actual, expected, message) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${message}: expected ${expectedStr}, got ${actualStr}`);
  }
}

let exitCode = 0;

try {
  // ==================== parseEvaluationOutput ====================

  // --- Valid JSON ---
  {
    const raw = JSON.stringify({
      scores: { completeness: 2, correctness: 1, style: 2, scope: 1, robustness: 1 },
      totalScore: 7,
      verdict: "pass",
      issues: [{ severity: "minor", description: "minor issue" }],
      suggestions: [{ type: "refactor", description: "extract helper" }],
    });
    const result = parseEvaluationOutput(raw);
    assert(result !== null, "valid JSON should parse");
    assert(typeof result.scores === "object", "scores should be an object");
    assert(result.scores.completeness === 2, `completeness should be 2, got ${result.scores.completeness}`);
    assert(result.scores.correctness === 1, `correctness should be 1, got ${result.scores.correctness}`);
    assert(result.scores.style === 2, `style should be 2, got ${result.scores.style}`);
    assert(result.totalScore === 7, `totalScore should be 7, got ${result.totalScore}`);
    assert(result.verdict === "pass", `verdict should be pass, got ${result.verdict}`);
    assert(Array.isArray(result.issues), "issues should be an array");
    assert(result.issues.length === 1, "issues should have 1 entry");
    assert(result.issues[0].severity === "minor", "issue severity should be minor");
    assert(Array.isArray(result.suggestions), "suggestions should be an array");
    assert(result.suggestions.length === 1, "suggestions should have 1 entry");
    console.log("parseEvaluationOutput valid JSON: ok");
  }

  // --- Valid JSON with fail verdict ---
  {
    const raw = JSON.stringify({
      scores: { completeness: 0, correctness: 0, style: 1, scope: 1, robustness: 0 },
      totalScore: 2,
      verdict: "fail",
      issues: [{ severity: "critical", description: "critical bug" }],
      suggestions: [{ type: "rule", description: "follow coding standards" }],
    });
    const result = parseEvaluationOutput(raw);
    assert(result !== null, "fail JSON should parse");
    assert(result.totalScore === 2, `totalScore should be 2, got ${result.totalScore}`);
    assert(result.verdict === "fail", "verdict should be fail");
    assert(result.issues[0].severity === "critical", "issue severity should be critical");
    console.log("parseEvaluationOutput fail verdict: ok");
  }

  // --- Valid JSON with partial verdict ---
  {
    const raw = JSON.stringify({
      scores: { completeness: 1, correctness: 1, style: 2, scope: 2, robustness: 1 },
      totalScore: 7,
      verdict: "partial",
      issues: [],
      suggestions: [],
    });
    const result = parseEvaluationOutput(raw);
    assert(result !== null, "partial JSON should parse");
    assert(result.verdict === "partial", "verdict should be partial");
    assert(Array.isArray(result.issues) && result.issues.length === 0, "issues should be empty array");
    assert(Array.isArray(result.suggestions) && result.suggestions.length === 0, "suggestions should be empty array");
    console.log("parseEvaluationOutput partial verdict: ok");
  }

  // --- JSON in markdown fence ---
  {
    const raw = [
      "Some explanation text here.",
      "",
      "```json",
      JSON.stringify({
        scores: { completeness: 1, correctness: 2, style: 0, scope: 1, robustness: 1 },
        totalScore: 5,
        verdict: "partial",
        issues: [{ severity: "critical", description: "missing error handling" }],
        suggestions: [{ type: "test", description: "add unit tests" }],
      }),
      "```",
      "More trailing text.",
    ].join("\n");
    const result = parseEvaluationOutput(raw);
    assert(result !== null, "JSON in markdown fence should parse");
    assert(result.totalScore === 5, `totalScore should be 5, got ${result.totalScore}`);
    assert(result.verdict === "partial", "verdict should be partial");
    assert(result.issues[0].description === "missing error handling", "issue description should match");
    console.log("parseEvaluationOutput JSON in fence: ok");
  }

  // --- JSON in fence with extra text around ---
  {
    const raw = "Some prefix text\n```json\n{\"scores\":{\"completeness\":2,\"correctness\":2,\"style\":2,\"scope\":2,\"robustness\":2},\"totalScore\":10,\"verdict\":\"pass\",\"issues\":[],\"suggestions\":[]}\n```\nSome suffix text";
    const result = parseEvaluationOutput(raw);
    assert(result !== null, "JSON in fence with extra text should parse");
    assert(result.totalScore === 10, "totalScore should be 10");
    assert(result.verdict === "pass", "verdict should be pass");
    console.log("parseEvaluationOutput JSON in fence with prefix/suffix: ok");
  }

  // --- No JSON present → null ---
  {
    const raw = "This is just some random text without any JSON structure in it at all.";
    const result = parseEvaluationOutput(raw);
    assert(result === null, "no JSON should return null");
    console.log("parseEvaluationOutput no JSON: ok");
  }

  // --- Invalid JSON → null ---
  {
    const raw = '{"scores": {"completeness": 2, "correctness": broken}';
    const result = parseEvaluationOutput(raw);
    assert(result === null, "invalid JSON should return null");
    console.log("parseEvaluationOutput invalid JSON: ok");
  }

  // --- JSON with extra text (fence without ```json marker) ---
  {
    const raw = "Some text before\n{\"scores\":{\"completeness\":1,\"correctness\":1,\"style\":1,\"scope\":1,\"robustness\":1},\"totalScore\":5,\"verdict\":\"partial\",\"issues\":[],\"suggestions\":[]}\nSome text after";
    const result = parseEvaluationOutput(raw);
    assert(result !== null, "JSON with extra text should parse");
    assert(result.totalScore === 5, "totalScore should be 5");
    console.log("parseEvaluationOutput JSON with extra text: ok");
  }

  // ==================== ChallengeEvaluator construction ====================

  // --- Basic construction ---
  {
    const evaluator = new ChallengeEvaluator();
    assert(evaluator instanceof ChallengeEvaluator, "should construct a ChallengeEvaluator");
    console.log("construction basic: ok");
  }

  // --- Timeout config ---
  {
    const evaluator = new ChallengeEvaluator({ timeoutMs: 5000 });
    assert(evaluator instanceof ChallengeEvaluator, "should construct with timeout config");
    console.log("construction with timeout: ok");
  }

  // ==================== _buildEvalPrompt ====================

  // --- Prompt includes task ---
  {
    const evaluator = new ChallengeEvaluator();
    const prompt = evaluator._buildEvalPrompt({
      task: "Fix the bug in turn-orchestrator",
      output: "Execution completed successfully",
    });
    assert(typeof prompt === "string", "prompt should be a string");
    assert(prompt.length > 0, "prompt should not be empty");
    assert(prompt.includes("Fix the bug in turn-orchestrator"), "prompt should include the task");
    assert(prompt.includes("Execution completed successfully"), "prompt should include the output");
    assert(prompt.includes("completeness"), "prompt should mention completeness scoring dimension");
    assert(prompt.includes("correctness"), "prompt should mention correctness scoring dimension");
    assert(prompt.includes("style"), "prompt should mention style scoring dimension");
    assert(prompt.includes("scope"), "prompt should mention scope scoring dimension");
    assert(prompt.includes("robustness"), "prompt should mention robustness scoring dimension");
    console.log("buildEvalPrompt includes task and output: ok");
  }

  // --- Prompt includes changed files when provided ---
  {
    const evaluator = new ChallengeEvaluator();
    const prompt = evaluator._buildEvalPrompt({
      task: "Refactor session-manager",
      output: "All tests pass",
      changedFiles: ["src/session-manager.js", "src/test/session.test.js"],
    });
    assert(prompt.includes("src/session-manager.js"), "prompt should include changed file paths");
    assert(prompt.includes("src/test/session.test.js"), "prompt should include all changed file paths");
    console.log("buildEvalPrompt includes changed files: ok");
  }

  // --- Prompt does not include changed files section when not provided ---
  {
    const evaluator = new ChallengeEvaluator();
    const prompt = evaluator._buildEvalPrompt({
      task: "Fix bug",
      output: "Done",
    });
    // The prompt should not mention "变更文件" or the changed-files section if no files provided
    // We just verify it doesn't crash and includes the basics
    assert(prompt.includes("Fix bug"), "prompt should include the task");
    assert(prompt.includes("Done"), "prompt should include the output");
    console.log("buildEvalPrompt without changed files: ok");
  }

  // ==================== evaluate() error paths ====================

  // --- MISSING_INPUT: missing task ---
  {
    const evaluator = new ChallengeEvaluator();
    const result = await evaluator.evaluate({ output: "some output" });
    assert(result.ok === false, "missing task should return ok=false");
    assert(result.error === "MISSING_INPUT", `error should be MISSING_INPUT, got ${result.error}`);
    assert(result.verdict === "error", "verdict should be error on missing input");
    console.log("evaluate missing task: ok");
  }

  // --- MISSING_INPUT: missing output ---
  {
    const evaluator = new ChallengeEvaluator();
    const result = await evaluator.evaluate({ task: "some task" });
    assert(result.ok === false, "missing output should return ok=false");
    assert(result.error === "MISSING_INPUT", `error should be MISSING_INPUT, got ${result.error}`);
    console.log("evaluate missing output: ok");
  }

  // --- MISSING_INPUT: both missing ---
  {
    const evaluator = new ChallengeEvaluator();
    const result = await evaluator.evaluate({});
    assert(result.ok === false, "missing both should return ok=false");
    assert(result.error === "MISSING_INPUT", `error should be MISSING_INPUT, got ${result.error}`);
    console.log("evaluate missing both: ok");
  }

  // ==================== evaluate() success case (using cat to echo stdin) ====================

  // --- Evaluate with cat - echoes stdin to stdout ---
  {
    const evaluator = new ChallengeEvaluator({ command: "cat" });
    const result = await evaluator.evaluate({
      task: "Test task",
      output: "Test output",
      cwd: "/tmp",
    });
    // cat echoes stdin, so rawOutput should contain the prompt
    assert(typeof result.ok === "boolean", "result should have ok field");
    assert(typeof result.rawOutput === "string", "result should have rawOutput field");
    assert(result.rawOutput.length > 0, "rawOutput should not be empty");
    assert(result.rawOutput.includes("自我评估"), "rawOutput should contain Chinese parts of the eval prompt");
    console.log("evaluate success path: ok");
  }

  // --- Evaluate with changed files ---
  {
    const evaluator = new ChallengeEvaluator({ command: "cat" });
    const result = await evaluator.evaluate({
      task: "Test task",
      output: "Test output",
      changedFiles: ["src/main.js"],
      cwd: "/tmp",
    });
    assert(typeof result.ok === "boolean", "result should have ok field");
    assert(result.rawOutput.length > 0, "rawOutput should contain data");
    assert(result.rawOutput.includes("src/main.js"), "rawOutput should contain changed file path");
    console.log("evaluate with changed files: ok");
  }

  console.log("\nAll tests passed!");
} catch (err) {
  console.error("TEST FAILED:", err.message);
  exitCode = 1;
}

process.exit(exitCode);
