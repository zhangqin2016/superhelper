#!/usr/bin/env node

// Functional test for resources/runtime-scripts/lily_office_style.py using the
// bundled Python runtime. Skips gracefully when the runtime bundle is absent.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveVenvPython } = require("../src/main/runtime-python.js");

const python = resolveVenvPython();
if (!python) {
  console.log("office-style-helper: skipped (bundled runtime not present)");
  process.exit(0);
}

const out = execFileSync(python, ["resources/runtime-scripts/lily_office_style.py", "--selftest"], {
  encoding: "utf8",
  timeout: 120_000,
});
if (!out.includes("lily_office_style selftest ok")) {
  throw new Error(`unexpected selftest output: ${out}`);
}
console.log("office-style-helper: ok (runtime-backed)");
