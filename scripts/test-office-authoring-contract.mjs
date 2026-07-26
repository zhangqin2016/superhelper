#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { buildSkillOverlaySection } = require("../src/main/skill-platform-overlays.js");

const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const requirements = read("resources/runtime/requirements-runtime.txt");
for (const dependency of ["python-docx", "python-pptx", "openpyxl", "xlsxwriter", "reportlab"]) {
  assert.match(requirements, new RegExp(`^${dependency}[^\\n]*$`, "mi"), `${dependency} must stay in the base authoring runtime`);
}

const runtimeVerification = read("scripts/verify-runtime-bundle.mjs");
for (const importName of ["docx", "pptx", "openpyxl", "reportlab"]) {
  assert.match(runtimeVerification, new RegExp(`\\b${importName}\\b`), `${importName} must stay in the runtime smoke test`);
}

const overlays = buildSkillOverlaySection([
  { id: "anthropics-docx" },
  { id: "anthropics-pptx" },
  { id: "anthropics-pdf" },
], "en");
assert.match(overlays, /python-docx/);
assert.match(overlays, /python-pptx/);
assert.match(overlays, /ReportLab/);
assert.match(overlays, /stale runtimes without it must fall back/i);
assert.match(overlays, /LILY_CJK_FONT_PATH/);
// CJK authoring contract: font pairs (eastAsia), light-first decks, shared style helper.
assert.match(overlays, /w:eastAsia/);
assert.match(overlays, /East-Asian typefaces as a pair/);
assert.match(overlays, /LIGHT slide backgrounds/);
assert.match(overlays, /lily_office_style\.py/);

const officeStyleHelper = read("resources/runtime-scripts/lily_office_style.py");
for (const symbol of ["def style_docx", "def style_pptx", "def apply_ea_font", "LIGHT_THEME", "def contrast_ok", "--selftest"]) {
  assert.ok(officeStyleHelper.includes(symbol), `lily_office_style.py must provide ${symbol}`);
}

const officeIntent = read("resources/skills-catalog/lily-office-intent/SKILL.md");
assert.match(officeIntent, /## Authoring Quality Contract/);
assert.match(officeIntent, /small design system/i);
assert.match(officeIntent, /render the final artifact/i);
assert.match(officeIntent, /w:eastAsia/);
assert.match(officeIntent, /lily_office_style\.py/);
assert.match(officeIntent, /## Conversion Source Protection/);
assert.match(officeIntent, /Treat the input document as immutable/i);
assert.match(officeIntent, /ask the user before changing the source/i);
assert.match(officeIntent, /managed runtime-pack install\/repair/i);
assert.match(officeIntent, /do not pass `wait: true`/i);
assert.match(officeIntent, /runtime_pack_list/i);

const verifySkill = read("resources/skills-catalog/lily-document-verify/SKILL.md");
assert.match(verifySkill, /every\s+page for artifacts up to 12 pages/i);
assert.match(verifySkill, /at least 6 pages distributed/i);
assert.match(verifySkill, /page images must have been read/i);
assert.match(verifySkill, /OCR is text coverage, not visual QA/i);
assert.match(verifySkill, /managed runtime-pack install\/repair/i);
assert.match(verifySkill, /retry the render\/inspection route/i);

console.log("office-authoring-contract: ok");
