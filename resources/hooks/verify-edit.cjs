#!/usr/bin/env node
"use strict";
// PostToolUse verification hook: after the engine edits a file, run a fast,
// deterministic syntax check. Exit 2 feeds stderr back to the model so it
// self-corrects before the user ever sees the breakage; anything we cannot
// check confidently FAILS OPEN (exit 0) — a hook must never produce false
// positives or block on a slow/missing checker.
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const CHECK_TIMEOUT_MS = 10_000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

function fail(message) {
  process.stderr.write(String(message).slice(0, 2000));
  process.exit(2);
}

function checkJavaScript(file) {
  // process.execPath is node (or the app's node shim with
  // ELECTRON_RUN_AS_NODE inherited via env), so --check is always available.
  const result = spawnSync(process.execPath, ["--check", file], {
    timeout: CHECK_TIMEOUT_MS,
    encoding: "utf8",
  });
  if (result.error || result.signal) return;
  if (result.status !== 0) {
    fail(`Syntax check failed for ${file}:\n${result.stderr || result.stdout || ""}`);
  }
}

function checkJson(file) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`JSON syntax error in ${file}: ${error.message}`);
  }
}

function checkPython(file) {
  for (const python of ["python3", "python"]) {
    const result = spawnSync(python, ["-m", "py_compile", file], {
      timeout: CHECK_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (result.error) continue; // interpreter not installed — try next, else skip
    if (result.signal) return;
    if (result.status !== 0) {
      fail(`Python syntax check failed for ${file}:\n${result.stderr || result.stdout || ""}`);
    }
    return;
  }
}

function main(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  if (!EDIT_TOOLS.has(String(payload?.tool_name || ""))) process.exit(0);
  const file = String(payload?.tool_input?.file_path || "");
  if (!file || !fs.existsSync(file)) process.exit(0);

  const lower = file.toLowerCase();
  if (lower.endsWith(".json")) checkJson(file);
  else if (/\.(js|cjs|mjs)$/.test(lower)) checkJavaScript(file);
  else if (lower.endsWith(".py")) checkPython(file);
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => main(input));
