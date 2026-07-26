#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeRuntimeCommandShims } from "./lib/runtime-command-shims.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-shims-"));

try {
  const binDir = path.join(root, "bin");
  const scriptsDir = path.join(root, "venv", "Scripts");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  const realPython = path.join(scriptsDir, "python.exe");
  fs.writeFileSync(realPython, "real-python-placeholder");

  for (const name of ["python.exe", "python3.exe"]) {
    fs.writeFileSync(
      path.join(binDir, name),
      '@echo off\r\n"%~dp0..\\venv\\Scripts\\python.exe" %*\r\n',
    );
  }

  writeRuntimeCommandShims(root, "win32-x64");

  assert.equal(
    fs.existsSync(path.join(binDir, "python.exe")),
    false,
    "Windows runtime/bin must not contain a batch file disguised as python.exe",
  );
  assert.equal(
    fs.existsSync(path.join(binDir, "python3.exe")),
    false,
    "Windows runtime/bin must not contain a batch file disguised as python3.exe",
  );
  assert.equal(
    fs.readFileSync(realPython, "utf8"),
    "real-python-placeholder",
    "the real venv interpreter must remain untouched",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("runtime command shims: ok");
