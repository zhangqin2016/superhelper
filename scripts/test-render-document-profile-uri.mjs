#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePython = require("../src/main/runtime-python.js");
const python = runtimePython.resolveVenvPython();

if (!python) {
  console.log("render-document profile URI: skipped (bundled Python unavailable)");
  process.exit(0);
}

const renderScript = path.join(ROOT, "resources", "runtime-scripts", "render_document.py");
const code = [
  "import importlib.util, json, pathlib, tempfile",
  `spec = importlib.util.spec_from_file_location("render_document", ${JSON.stringify(renderScript)})`,
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "profile = pathlib.Path(tempfile.gettempdir()) / 'Lily Profile' / '.lo-profile'",
  "print(json.dumps(module._profile_uri(str(profile))))",
].join("\n");
const uri = JSON.parse(execFileSync(python, ["-c", code], {
  encoding: "utf8",
  env: runtimePython.getBundledPythonEnv(),
}).trim());

assert.match(uri, /^file:\/\//, "LibreOffice profile must use a file URI");
assert.equal(uri.includes("\\"), false, "LibreOffice profile URI must not contain Windows separators");

console.log("render-document profile URI: ok");
