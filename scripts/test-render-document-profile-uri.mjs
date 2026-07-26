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
  "import importlib.util, json, os, pathlib, subprocess, tempfile",
  `spec = importlib.util.spec_from_file_location("render_document", ${JSON.stringify(renderScript)})`,
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "profile = pathlib.Path(tempfile.gettempdir()) / 'Lily Profile' / '.lo-profile'",
  "program = pathlib.Path(tempfile.mkdtemp())",
  "(program / 'soffice.com').touch()",
  "(program / 'soffice.exe').touch()",
  "os.environ['LILY_LIBREOFFICE_PROGRAM'] = str(program)",
  "print(json.dumps({'uri': module._profile_uri(str(profile)), 'command': module._soffice(), 'env': module._office_env(), 'options': module._subprocess_options()}))",
].join("\n");
const result = JSON.parse(execFileSync(python, ["-c", code], {
  encoding: "utf8",
  env: runtimePython.getBundledPythonEnv(),
}).trim());

assert.match(result.uri, /^file:\/\//, "LibreOffice profile must use a file URI");
assert.equal(result.uri.includes("\\"), false, "LibreOffice profile URI must not contain Windows separators");
assert.equal(
  result.env.SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION,
  "1",
  "document rendering must not block on an unavailable default printer",
);
if (process.platform === "win32") {
  assert.match(result.command, /soffice\.exe$/i, "Windows document rendering must use soffice.exe, not soffice.com");
  assert.equal(
    result.options.creationflags > 0,
    true,
    "Windows document rendering must create LibreOffice without a console window",
  );
}

for (const skill of ["anthropics-docx", "anthropics-xlsx", "anthropics-pptx"]) {
  const helper = path.join(ROOT, "resources", "skills-catalog", skill, "scripts", "office", "soffice.py");
  const helperCode = [
    "import importlib.util, json, os, pathlib, tempfile",
    `spec = importlib.util.spec_from_file_location("skill_soffice", ${JSON.stringify(helper)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "program = pathlib.Path(tempfile.mkdtemp())",
    "(program / 'soffice.com').touch()",
    "(program / 'soffice.exe').touch()",
    "os.environ['LILY_LIBREOFFICE_PROGRAM'] = str(program)",
    "print(json.dumps({'command': module.get_soffice_command(), 'env': module.get_soffice_env(), 'options': module.get_soffice_subprocess_kwargs()}))",
  ].join("\n");
  const helperResult = JSON.parse(execFileSync(python, ["-c", helperCode], {
    encoding: "utf8",
    env: runtimePython.getBundledPythonEnv(),
  }).trim());
  assert.equal(
    helperResult.env.SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION,
    "1",
    `${skill} must disable synchronous printer detection`,
  );
  if (process.platform === "win32") {
    assert.match(helperResult.command, /soffice\.exe$/i, `${skill} must use soffice.exe`);
    assert.equal(helperResult.options.creationflags > 0, true, `${skill} must hide the LibreOffice subprocess`);
  }
}

console.log("render-document profile URI: ok");
