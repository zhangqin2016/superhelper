#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureVenvCfgFixed } from "../src/main/runtime-python.js";

function makeRoot(homeLine, { withPython = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-fixup-test-"));
  fs.writeFileSync(path.join(root, "runtime-manifest.json"), JSON.stringify({ platform: "win32-x64" }));
  let cpythonDir = "";
  if (withPython) {
    cpythonDir = path.join(root, "python", "cpython-3.12.13-win32-x64-none");
    fs.mkdirSync(cpythonDir, { recursive: true });
  }
  const scriptsDir = path.join(root, "venv", "Scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  const pythonExe = path.join(scriptsDir, "python.exe");
  fs.writeFileSync(pythonExe, "");
  const cfg = [homeLine, "include-system-site-packages = false", "version = 3.12.13", ""].join("\r\n");
  fs.writeFileSync(path.join(root, "venv", "pyvenv.cfg"), cfg);
  return { root, cpythonDir, pythonExe, cfgPath: path.join(root, "venv", "pyvenv.cfg") };
}

// 1) Build-machine absolute path that does not exist here -> rewritten to the real layout.
{
  const { root, cpythonDir, pythonExe, cfgPath } = makeRoot("home = D:\\aicode\\superhelpr\\bundles\\win32-x64\\runtime\\python\\cpython-3.12.13-win32-x64-none");
  ensureVenvCfgFixed(root, { platform: "win32" });
  const next = fs.readFileSync(cfgPath, "utf8");
  assert.ok(next.includes(`home = ${cpythonDir}`), "home should point at the on-device cpython dir");
  assert.ok(next.includes(`executable = ${pythonExe}`), "executable should point at the on-device venv python");
  assert.ok(next.includes("include-system-site-packages = false"), "other cfg lines preserved");
  assert.ok(next.includes("version = 3.12.13"), "version line preserved");
  assert.ok(!next.includes("superhelpr"), "build-machine path fully removed");
  fs.rmSync(root, { recursive: true, force: true });
}

// 2) Placeholder cfg (fresh cross-build output) -> resolved the same way.
{
  const { root, cpythonDir, cfgPath } = makeRoot("home = __LILY_BUNDLED_PYTHON_HOME__");
  ensureVenvCfgFixed(root, { platform: "win32" });
  assert.ok(fs.readFileSync(cfgPath, "utf8").includes(`home = ${cpythonDir}`), "placeholder home resolved");
  fs.rmSync(root, { recursive: true, force: true });
}

// 3) Valid cfg (paths exist on this machine) -> untouched.
{
  const { root, cpythonDir, cfgPath } = makeRoot(`home = ${fs.realpathSync(os.tmpdir())}`);
  const before = fs.readFileSync(cfgPath, "utf8");
  ensureVenvCfgFixed(root, { platform: "win32" });
  assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "healthy cfg must not be rewritten");
  fs.rmSync(root, { recursive: true, force: true });
}

// 4) Non-Windows platform -> never rewritten (signed .app seal on macOS).
{
  const { root, cfgPath } = makeRoot("home = D:\\aicode\\superhelpr\\nope");
  const before = fs.readFileSync(cfgPath, "utf8");
  ensureVenvCfgFixed(root, { platform: "darwin" });
  assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "darwin must not touch the cfg");
  fs.rmSync(root, { recursive: true, force: true });
}

// 5) Dirty cfg but no bundled cpython dir -> graceful no-op (no throw).
{
  const { root, cfgPath } = makeRoot("home = D:\\aicode\\superhelpr\\nope", { withPython: false });
  const before = fs.readFileSync(cfgPath, "utf8");
  ensureVenvCfgFixed(root, { platform: "win32" });
  assert.equal(fs.readFileSync(cfgPath, "utf8"), before, "missing cpython dir: leave cfg as-is");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("runtime-python venv fixup: ok");
