#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const { resolveVenvPython } = require("../src/main/runtime-python.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(
  ROOT,
  "resources",
  "skills-catalog",
  "lily-template-fill",
  "scripts",
  "fill_template.py",
);

assert(fs.existsSync(SCRIPT), "fill_template.py must exist in the skill");

// Template fill is delegated to the bundled Python runtime (docxtpl). If it's
// not present (stripped checkout), skip the runtime-backed assertions rather
// than fail — but never silently claim they were covered.
const python = resolveVenvPython();
if (!python) {
  console.log("test-template-fill: ok (SKIPPED — no bundled runtime)");
  process.exit(0);
}

const py = (code) => execFileSync(python, ["-c", code], { encoding: "utf8" });
const run = (args) => JSON.parse(execFileSync(python, [SCRIPT, ...args], { encoding: "utf8" }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-tplfill-"));
const template = path.join(tmp, "template.docx");
const dataPath = path.join(tmp, "data.json");
const output = path.join(tmp, "out.docx");

// Author a template with both a simple placeholder and a paragraph loop — the
// two constructs the skill documents — so the test breaks if either stops
// rendering, not just if the file is produced.
py(
  [
    "from docx import Document",
    "d = Document()",
    "d.add_paragraph('客户：{{ customer_name }} 金额：{{ amount }}')",
    "d.add_paragraph('{%p for item in items %}')",
    "d.add_paragraph('- {{ item }}')",
    "d.add_paragraph('{%p endfor %}')",
    `d.save(${JSON.stringify(template)})`,
  ].join("\n"),
);

// inspect must report exactly the declared placeholders — the caller relies on
// this to know what data to supply, so a wrong/empty list is a real failure.
const inspected = run(["inspect", template]);
assert(inspected.ok, `inspect failed: ${JSON.stringify(inspected)}`);
const vars = new Set(inspected.variables);
for (const name of ["customer_name", "amount", "items"]) {
  assert(vars.has(name), `inspect missing declared variable ${name}: ${JSON.stringify(inspected.variables)}`);
}

// Fill with `amount` deliberately omitted: the rendered doc must carry the
// provided values, drop the {{ }} markers, AND the response must flag the
// missing placeholder — an unfilled blank has to be visible, not silent.
fs.writeFileSync(
  dataPath,
  JSON.stringify({ customer_name: "张三", items: ["服务费", "材料费"] }),
  "utf8",
);
const filled = run(["fill", template, dataPath, output]);
assert(filled.ok, `fill failed: ${JSON.stringify(filled)}`);
assert(fs.existsSync(output), "fill did not write output .docx");
assert(filled.missing.includes("amount"), `missing should flag 'amount': ${JSON.stringify(filled.missing)}`);
assert(!filled.missing.includes("customer_name"), "customer_name was provided, must not be missing");

const rendered = py(
  [
    "from docx import Document",
    `d = Document(${JSON.stringify(output)})`,
    "print('\\n'.join(p.text for p in d.paragraphs))",
  ].join("\n"),
);
assert(rendered.includes("张三"), "rendered doc missing the provided customer_name");
assert(rendered.includes("服务费") && rendered.includes("材料费"), "paragraph loop did not expand list items");
assert(!rendered.includes("{{"), "unrendered placeholder left in output");

// A top-level JSON array (not an object) must be rejected loudly, not coerced.
const badData = path.join(tmp, "bad.json");
fs.writeFileSync(badData, "[1,2,3]", "utf8");
let rejected = false;
try {
  execFileSync(python, [SCRIPT, "fill", template, badData, output], { encoding: "utf8" });
} catch (err) {
  rejected = true;
  const out = JSON.parse(err.stdout || "{}");
  assert(out.error === "DATA_NOT_OBJECT", `expected DATA_NOT_OBJECT, got ${JSON.stringify(out)}`);
}
assert(rejected, "array data should exit non-zero");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-template-fill: ok (runtime-backed)");
