#!/usr/bin/env node
/**
 * A Chinese value written into a PDF form field is verified to be VISIBLE.
 *
 * Acceptance 2026-09-17 DEF-02: pypdf writes the value correctly into /V, and
 * /NeedAppearances asks the reader to regenerate the field's appearance with a
 * font that can draw it. That is a hint, not a guarantee — a reader that ignores
 * it draws nothing. Reading /V back cannot tell the difference, so the output is
 * rasterised and the field boxes are checked for actual ink.
 * --flatten-cjk then repairs a blank field by drawing the value onto the page.
 * [gate: pdf-form-cjk-visible]
 * Run: node scripts/test-pdf-form-cjk-render.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "resources/skills-catalog/lily-pdf-form/scripts/fill_pdf_form.py");
const { resolveVenvPython, getBundledPythonEnv } = require("../src/main/runtime-python.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("verification is wired into the fill, and the repair is opt-in", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.match(source, /def _verify_cjk_render/);
  assert.match(source, /def _rect_has_ink/, "the check rasterises, it does not read /V back");
  assert.match(source, /pypdfium2/);
  assert.match(source, /flatten_cjk=False/, "drawing onto the page is opt-in — a compliant reader would draw it twice");
  assert.match(source, /--flatten-cjk/);
  assert.match(source, /def _resolve_cjk_font/, "the repair uses the platform's verified font, not an exists\\(\\) chain");
});

check("the skill routes Chinese form CREATION away from reportlab's acroForm", () => {
  // Acceptance 2026-09-17 DEF-01: reportlab escapes PDF strings through a 0-255
  // lookup table, so any CJK default value raises KeyError. We never call it —
  // this pins that the skill says so rather than leaving it to be rediscovered.
  const skill = fs.readFileSync(path.join(ROOT, "resources/skills-catalog/lily-pdf-form/SKILL.md"), "utf8");
  assert.match(skill, /canvas\.acroForm/);
  assert.match(skill, /KeyError/);
  assert.match(skill, /--flatten-cjk/);
  assert.match(skill, /cjkRender/);
});

const python = resolveVenvPython();
if (!python) {
  console.log("skip - no bundled python runtime; the live render check is not exercised");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-form-cjk-"));
  try {
    const build = path.join(tmp, "build.py");
    fs.writeFileSync(build, [
      "import sys",
      "from reportlab.pdfgen import canvas",
      "from reportlab.lib.pagesizes import A4",
      "c = canvas.Canvas(sys.argv[1], pagesize=A4)",
      "c.acroForm.textfield(name='name', x=60, y=700, width=240, height=22, value='')",
      "c.acroForm.textfield(name='city', x=60, y=650, width=240, height=22, value='')",
      "c.showPage(); c.save()",
    ].join("\n"));
    const form = path.join(tmp, "form.pdf");
    const env = getBundledPythonEnv();
    execFileSync(python, [build, form], { timeout: 120_000, env });

    const run = (data, output, extra = []) => {
      const dataPath = path.join(tmp, `${path.basename(output, ".pdf")}.json`);
      fs.writeFileSync(dataPath, JSON.stringify(data));
      const out = execFileSync(python, [SCRIPT, "fill", form, dataPath, output, ...extra], {
        encoding: "utf8", timeout: 180_000, env,
      });
      return JSON.parse(out);
    };

    check("an ASCII fill is untouched: no render check, no new fields", () => {
      const result = run({ name: "Acme Ltd", city: "Dubai" }, path.join(tmp, "ascii.pdf"));
      assert.equal(result.ok, true);
      assert.equal(result.cjk, false);
      assert.equal(result.cjkRender, undefined, "nothing extra runs for a Latin-only fill");
      assert.deepEqual(result.provided, ["city", "name"]);
    });

    check("the field case: a Chinese value that renders blank is REPORTED, field by field", () => {
      const result = run({ name: "星河科技", city: "上海" }, path.join(tmp, "cjk.pdf"));
      assert.equal(result.ok, true);
      assert.equal(result.cjk, true);
      assert.ok(result.cjkRender, "a CJK fill is verified, not assumed");
      assert.equal(result.cjkRender.checked, 2, "every CJK field is checked");
      assert.equal(result.cjkRender.verified, false, "the defect is detected rather than shipped silently");
      assert.equal(result.cjkRender.blankFields.length, 2);
      assert.deepEqual(result.cjkRender.blankFields.map((item) => item.field).sort(), ["city", "name"]);
      assert.match(result.cjkRender.warning, /NeedAppearances/);
    });

    check("--flatten-cjk repairs it, and the same rasteriser confirms the values are now visible", () => {
      const output = path.join(tmp, "flat.pdf");
      const result = run({ name: "星河科技", city: "上海" }, output, ["--flatten-cjk"]);
      assert.equal(result.cjkRender.flattened, 2, "both values were drawn");
      assert.equal(result.cjkRender.verified, true, "verified by re-rasterising, not by assertion");
      assert.deepEqual(result.cjkRender.blankFields, []);
      assert.ok(fs.statSync(output).size > 0);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${checks} checks passed (pdf form CJK render)`);
