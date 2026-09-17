#!/usr/bin/env node
/**
 * LibreOffice conversion cannot report success without producing a file.
 *
 * Acceptance 2026-09-17 DEF-04: `soffice --convert-to docx` on an HTML source
 * exits 0, writes nothing, and prints "no export filter ... aborting" only on
 * stderr. A caller checking the return code reported success and handed back a
 * path that does not exist. Success is now a non-empty output FILE, and a source
 * LibreOffice can load through more than one module gets one retry with an
 * explicit input filter.
 * [gate: office-conversion-no-silent-failure]
 * Run: node scripts/test-office-conversion-guard.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { resolveVenvPython, getBundledPythonEnv } = require("../src/main/runtime-python.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const source = fs.readFileSync(path.join(ROOT, "resources/runtime-scripts/lily_office_convert.py"), "utf8");

check("the contract is stated in code, not left to the caller", () => {
  // check=False on purpose: the interesting failure exits 0, so the return code
  // must NOT be the verdict.
  assert.match(source, /check=False/, "the return code must not be the verdict");
  assert.match(source, /def _produced\(path\)/, "success is a non-empty output file");
  assert.match(source, /getsize\(path\) > 0/);
  assert.match(source, /RETRY_INPUT_FILTERS/, "a second attempt with an explicit input filter");
  assert.match(source, /HTML \(StarWriter\)/);
  assert.match(source, /class ConversionError/, "failure raises, never returns a phantom path");
  // Acceptance 2026-09-17 P21: `报告.docx` and `报告.pptx` both wanted 报告.pdf,
  // and the second call silently destroyed the first while returning success.
  assert.match(source, /def _publish_path/, "the output name must be checked before it is written");
  assert.match(source, /MANIFEST_NAME/, "provenance is what tells a re-run from a collision");
  assert.match(source, /tempfile\.mkdtemp\(prefix="\.lily-convert-"/, "conversion lands in staging, never on an existing deliverable");
  assert.match(source, /would have overwritten a different source's output/, "a changed name is reported, not silent");
});

check("the one conversion path is shared — the renderer does not keep its own", () => {
  const renderer = fs.readFileSync(path.join(ROOT, "resources/runtime-scripts/render_document.py"), "utf8");
  assert.match(renderer, /from lily_office_convert import ConversionError, convert/);
  assert.ok(!/--convert-to/.test(renderer), "the renderer must not re-implement the conversion");
});

const python = resolveVenvPython();
if (!python) {
  console.log("skip - no bundled python runtime; the live conversion is not exercised");
} else {
  check("live: HTML to DOCX produces a real file, HTML to PDF still works, and a dead end raises", () => {
    const env = { ...getBundledPythonEnv() };
    try {
      const { getRuntimeEnvExtras } = require("../src/main/runtime-python.js");
      Object.assign(env, getRuntimeEnvExtras());
    } catch { /* the selftest resolves soffice from PATH when the extras are unavailable */ }
    const out = execFileSync(python, [path.join(ROOT, "resources/runtime-scripts/lily_office_convert.py"), "--selftest"], {
      encoding: "utf8",
      timeout: 600_000,
      env,
    });
    assert.match(out, /lily_office_convert selftest ok/);
  });
}

console.log(`\n${checks} checks passed (office conversion guard)`);
