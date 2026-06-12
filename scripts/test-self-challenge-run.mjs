#!/usr/bin/env node
// Integration test for scripts/dev-self-challenge/run.mjs
// Tests the orchestrator entry point in dry-run mode

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-challenge-run-"));
const dataDir = path.join(tempRoot, ".lily-work", "challenges");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let exitCode = 0;

try {
  const runMjsPath = path.join(
    projectRoot,
    "scripts",
    "dev-self-challenge",
    "run.mjs",
  );

  const result = await new Promise((resolve, reject) => {
    const child = spawn("node", [runMjsPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CHALLENGE_DRY_RUN: "1",
        CHALLENGE_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => reject(err));
  });

  assert(
    result.code === 0,
    `exit code should be 0, got ${result.code}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
  );
  assert(
    result.stdout.includes("challenge"),
    `output should mention "challenge": ${result.stdout.slice(0, 200)}`,
  );

  console.log("PASS: test-self-challenge-run");
} catch (err) {
  console.error("FAIL:", err.message);
  exitCode = 1;
}

// Cleanup temp directory (best-effort)
try {
  fs.rmSync(tempRoot, { recursive: true, force: true });
} catch {
  // ignore cleanup errors
}

process.exit(exitCode);
