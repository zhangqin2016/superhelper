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

const officeIntent = read("resources/skills-catalog/lily-office-intent/SKILL.md");
assert.match(officeIntent, /## Authoring Quality Contract/);
assert.match(officeIntent, /small design system/i);
assert.match(officeIntent, /render the final artifact/i);

const verifySkill = read("resources/skills-catalog/lily-document-verify/SKILL.md");
assert.match(verifySkill, /every\s+page for artifacts up to 12 pages/i);
assert.match(verifySkill, /at least 6 pages distributed/i);
assert.match(verifySkill, /page images must have been read/i);

console.log("office-authoring-contract: ok");
