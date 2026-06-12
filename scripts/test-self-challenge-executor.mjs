#!/usr/bin/env node

import module from "node:module";

const require = module.createRequire(import.meta.url);

const { ChallengeExecutor } = require("./dev-self-challenge/lib/challenge-executor.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let exitCode = 0;

try {
  // ==================== Construction ====================

  // --- Basic construction ---
  {
    const executor = new ChallengeExecutor();
    assert(executor instanceof ChallengeExecutor, "should construct a ChallengeExecutor");
    console.log("basic construction: ok");
  }

  // --- Timeout config ---
  {
    const executor = new ChallengeExecutor({ timeoutMs: 500 });
    assert(executor instanceof ChallengeExecutor, "should construct with timeout config");
    console.log("timeout config: ok");
  }

  // --- Command override ---
  {
    const executor = new ChallengeExecutor({ command: "sh" });
    assert(executor instanceof ChallengeExecutor, "should construct with command override");
    console.log("command override: ok");
  }

  // ==================== _resolveCommand ====================

  // --- Returns a string from fallback (no real engine installed) ---
  {
    const executor = new ChallengeExecutor();
    const cmd = executor._resolveCommand();
    assert(typeof cmd === "string", "_resolveCommand should return a string");
    assert(cmd.length > 0, "_resolveCommand should return a non-empty string");
    // Without a real engine installed, should fall back to "echo"
    assert(cmd === "echo" || cmd.length > 1, "should fall back to echo or return engine path");
    console.log("resolve command fallback: ok");
  }

  // --- Returns the command override when set ---
  {
    const executor = new ChallengeExecutor({ command: "sh" });
    const cmd = executor._resolveCommand();
    assert(cmd === "sh", "should return the command override");
    console.log("resolve command override: ok");
  }

  // ==================== Execute ====================

  // --- Execute sh with echo command successfully ---
  {
    const executor = new ChallengeExecutor({ command: "sh" });
    const result = await executor.execute({ prompt: "echo hello world\n", cwd: "/tmp" });
    assert(result.ok === true, `sh echo should succeed, got ok=${result.ok}`);
    assert(result.output.includes("hello world"), `output should contain 'hello world', got: ${JSON.stringify(result.output)}`);
    assert(typeof result.output === "string", "output should be a string");
    assert(typeof result.errorOutput === "string", "errorOutput should be a string");
    assert(typeof result.durationMs === "number", "durationMs should be a number");
    console.log("execute sh echo: ok");
  }

  // --- Output is captured correctly (multiple lines) ---
  {
    const executor = new ChallengeExecutor({ command: "sh" });
    const result = await executor.execute({ prompt: "echo line1\necho line2\necho line3\n", cwd: "/tmp" });
    assert(result.ok === true, "multi-line echo should succeed");
    assert(result.output.includes("line1"), "output should include line1");
    assert(result.output.includes("line2"), "output should include line2");
    assert(result.output.includes("line3"), "output should include line3");
    console.log("output capture: ok");
  }

  // --- Duration is measured ---
  {
    const executor = new ChallengeExecutor({ command: "sh" });
    const result = await executor.execute({ prompt: "echo hello\n", cwd: "/tmp" });
    assert(typeof result.durationMs === "number", "durationMs should be a number");
    assert(result.durationMs > 0, "durationMs should be positive");
    assert(result.durationMs < 10000, "durationMs should be reasonable (< 10s)");
    console.log("duration measurement: ok");
  }

  // --- Timeout triggers correctly ---
  {
    const executor = new ChallengeExecutor({ timeoutMs: 500, command: "sh" });
    const result = await executor.execute({ prompt: "sleep 5\n", cwd: "/tmp" });
    assert(result.ok === false, "timeout should cause failure");
    assert(result.error, "timeout should have an error message");
    assert(result.durationMs < 5000, `timeout duration should be under 5000ms, was ${result.durationMs}`);
    console.log("timeout handling: ok");
  }

  // --- Spawn error handling (nonexistent command) ---
  {
    const executor = new ChallengeExecutor({ command: "this-command-does-not-exist-12345" });
    const result = await executor.execute({ prompt: "hello", cwd: "/tmp" });
    assert(result.ok === false, "nonexistent command should fail");
    assert(result.error, "nonexistent command should have an error message");
    console.log("spawn error handling: ok");
  }

  console.log("\nAll tests passed!");
} catch (err) {
  console.error("TEST FAILED:", err.message);
  exitCode = 1;
}

process.exit(exitCode);
