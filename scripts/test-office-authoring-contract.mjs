#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { SKILL_PLATFORM_OVERLAYS, buildSkillOverlaySection } = require("../src/main/skill-platform-overlays.js");

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
// register_cjk_font() consults LILY_CJK_FONT_PATH itself and then VERIFIES it,
// which naming the env var alone never did. The env var stays pinned in the
// pulled office-intent skill below. [gate: cjk-pdf-font]
assert.match(overlays, /register_cjk_font\(\)/);
// CJK authoring contract: font pairs (eastAsia), light-first decks, shared style helper.
assert.match(overlays, /w:eastAsia/);
assert.match(overlays, /East-Asian typefaces as a pair/);
assert.match(overlays, /LIGHT slide backgrounds/);
assert.match(overlays, /lily_office_style\.py/);

// Acceptance 2026-09-16 repairs, each pinned to the overlay that carries it.
// DEF-001: ReportLab cannot embed PostScript/CFF outlines, and macOS ships CFF
// for its two best CJK faces, so an exists()-only font chain lost every Chinese
// character in a drawn PDF. [gate: cjk-pdf-font]
assert.match(overlays, /exists\(\)-only chain/);
// Overlays are PUSHED on every prompt and compete with the skill index for
// budget, so they carry one-line rules only. The procedure for these lives in
// the PULLED office-intent skill — scripts/test-agent-guide-headroom.mjs is the
// ruler that catches prose creeping back into the prefix.
assert.ok(!/anthropics-xlsx/.test(overlays), "workbook print setup is procedure, not a pushed rule");
for (const [id, overlay] of Object.entries(SKILL_PLATFORM_OVERLAYS)) {
  for (const locale of ["en", "zh"]) {
    assert.ok(Buffer.byteLength(overlay[locale]) <= 1024, `${id}.${locale} overlay must stay under 1KB of pushed prompt`);
  }
}

const officeStyleHelper = read("resources/runtime-scripts/lily_office_style.py");
for (const symbol of [
  "def style_docx",
  "def style_pptx",
  "def apply_ea_font",
  "LIGHT_THEME",
  "def contrast_ok",
  "def font_outline_format",
  "def resolve_cjk_font",
  "def register_cjk_font",
  "def configure_matplotlib_cjk",
  "def style_xlsx_print",
  "def fit_column_widths",
  "def _set_theme_fonts",
  "def _set_chart_fonts",
  "--selftest",
]) {
  assert.ok(officeStyleHelper.includes(symbol), `lily_office_style.py must provide ${symbol}`);
}

// DEF-002: the document/data skills promised chart images with no Python chart
// renderer installed at all. The dependency is declared AND verified at build.
const runtimeRequirements = read("resources/runtime/requirements-runtime.txt");
assert.match(runtimeRequirements, /^matplotlib>=/m, "the runtime must ship a chart renderer");
assert.match(read("scripts/verify-runtime-bundle.mjs"), /import docx, docxtpl, matplotlib,/,
  "the bundle verifier must fail the build if the chart renderer is missing");

const officeIntent = read("resources/skills-catalog/lily-office-intent/SKILL.md");
// DEF-002 / DEF-006 / DEF-007 procedure lives here, where it is PULLED for office
// work instead of charged to every prompt. [gate: office-delivery-completeness]
assert.match(officeIntent, /style_xlsx_print\(\)/);
assert.match(officeIntent, /split across the break/i);
assert.match(officeIntent, /never the Title style/);
assert.match(officeIntent, /--standalone/);
assert.match(officeIntent, /configure_matplotlib_cjk\(\)/);
// Acceptance 2026-09-17 D7: a TOC field exports empty through the command line.
assert.match(officeIntent, /TOC written as a FIELD exports empty/);
assert.match(officeIntent, /static table of\n   contents/);
// Acceptance 2026-09-17 DEF-04 / DEF-06.
assert.match(officeIntent, /lily_office_convert\.py/);
assert.match(officeIntent, /EXITS 0 and writes nothing/);
assert.match(officeIntent, /PDF\/A/);
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
