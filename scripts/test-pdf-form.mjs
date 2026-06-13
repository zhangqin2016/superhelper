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
  "lily-pdf-form",
  "scripts",
  "fill_pdf_form.py",
);

assert(fs.existsSync(SCRIPT), "fill_pdf_form.py must exist in the skill");

const python = resolveVenvPython();
if (!python) {
  console.log("test-pdf-form: ok (SKIPPED — no bundled runtime)");
  process.exit(0);
}

const py = (code) => execFileSync(python, ["-c", code], { encoding: "utf8" });
const run = (args) => JSON.parse(execFileSync(python, [SCRIPT, ...args], { encoding: "utf8" }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-pdfform-"));
const form = path.join(tmp, "form.pdf");
const dataPath = path.join(tmp, "data.json");
const output = path.join(tmp, "out.pdf");

// Build a minimal fillable AcroForm with two text fields. ASCII values keep the
// test free of CJK appearance-font noise; CJK correctness is the viewer's job
// (NeedAppearances) and is covered by the skill docs, not asserted on bytes here.
py(
  [
    "from pypdf import PdfWriter",
    "from pypdf.generic import (DictionaryObject, ArrayObject, NameObject,",
    "    TextStringObject, NumberObject, BooleanObject)",
    "w = PdfWriter(); page = w.add_blank_page(width=400, height=300)",
    "def fld(name, y):",
    "    f = DictionaryObject(); f.update({",
    "        NameObject('/FT'): NameObject('/Tx'),",
    "        NameObject('/T'): TextStringObject(name),",
    "        NameObject('/Subtype'): NameObject('/Widget'),",
    "        NameObject('/Rect'): ArrayObject([NumberObject(50), NumberObject(y), NumberObject(200), NumberObject(y+20)]),",
    "        NameObject('/V'): TextStringObject('')})",
    "    return w._add_object(f)",
    "refs = [fld('full_name', 200), fld('city', 150)]",
    "page[NameObject('/Annots')] = ArrayObject(refs)",
    "acro = DictionaryObject(); acro.update({NameObject('/Fields'): ArrayObject(refs), NameObject('/NeedAppearances'): BooleanObject(True)})",
    "w._root_object[NameObject('/AcroForm')] = w._add_object(acro)",
    `w.write(${JSON.stringify(form)})`,
  ].join("\n"),
);

// inspect must report the declared field names — the caller relies on this.
const inspected = run(["inspect", form]);
assert(inspected.ok, `inspect failed: ${JSON.stringify(inspected)}`);
const fields = new Set(inspected.fields);
assert(fields.has("full_name") && fields.has("city"), `inspect missing fields: ${JSON.stringify(inspected.fields)}`);

// Fill with `city` omitted: provided value must land in /V, and the omitted
// field must be flagged missing — a blank field has to be visible, not silent.
fs.writeFileSync(dataPath, JSON.stringify({ full_name: "Zhang San" }), "utf8");
const filled = run(["fill", form, dataPath, output]);
assert(filled.ok, `fill failed: ${JSON.stringify(filled)}`);
assert(fs.existsSync(output), "fill did not write output .pdf");
assert(filled.missing.includes("city"), `missing should flag 'city': ${JSON.stringify(filled.missing)}`);
assert(!filled.missing.includes("full_name"), "full_name was provided, must not be missing");

const value = py(
  [
    "from pypdf import PdfReader",
    `r = PdfReader(${JSON.stringify(output)})`,
    "print((r.get_fields() or {}).get('full_name', {}).get('/V', ''))",
  ].join("\n"),
).trim();
assert(value === "Zhang San", `filled field value not persisted, got: ${JSON.stringify(value)}`);

// A top-level JSON array must be rejected loudly, not coerced.
const badData = path.join(tmp, "bad.json");
fs.writeFileSync(badData, "[1,2,3]", "utf8");
let rejected = false;
try {
  execFileSync(python, [SCRIPT, "fill", form, badData, output], { encoding: "utf8" });
} catch (err) {
  rejected = true;
  assert(JSON.parse(err.stdout || "{}").error === "DATA_NOT_OBJECT", `expected DATA_NOT_OBJECT, got ${err.stdout}`);
}
assert(rejected, "array data should exit non-zero");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("test-pdf-form: ok (runtime-backed)");
