#!/usr/bin/env node
/**
 * An extraction says what it actually found, and why it failed.
 *
 * Acceptance 2026-09-17:
 * DEF-01 A page rendered to PNG lands in palette mode, and OCR read such a file
 *        as having no text at all. A full business licence came back as the empty
 *        string with ok:true — a silent loss of the entire document. The PDF page
 *        path already normalised to RGB before OCR; the standalone image did not.
 * DEF-03 A password-protected PDF failed with "PdfminerException: " — an empty
 *        message that cannot tell encryption from corruption, so nobody knows
 *        whether to supply a password.
 *
 * [gate: image-ocr-colour-normalisation] [gate: extraction-failure-diagnosis]
 * Run: node scripts/test-extraction-honesty.mjs
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
const EXTRACTOR = path.join(ROOT, "resources/runtime-scripts/extract_document.py");
const { resolveVenvPython, getBundledPythonEnv } = require("../src/main/runtime-python.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("the contract is in the code: normalise before OCR, and name the cause", () => {
  const source = fs.readFileSync(EXTRACTOR, "utf8");
  assert.match(source, /def extract_image\(path\)/);
  assert.match(source, /handle\.convert\("RGB"\)/, "a standalone image is normalised like a rendered page");
  assert.match(source, /_image_has_content/, "empty OCR on a page with ink is reported, not assumed");
  assert.match(source, /PDF_ENCRYPTED/);
  assert.match(source, /def _diagnose_failure/);
});

const python = resolveVenvPython();
if (!python) {
  console.log("skip - no bundled python runtime; the live half is not exercised");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-extract-honesty-"));
  const env = getBundledPythonEnv();
  const run = (file) => {
    const out = execFileSync(python, [EXTRACTOR, file], { encoding: "utf8", timeout: 300_000, env, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out);
  };
  try {
    const build = path.join(tmp, "build.py");
    fs.writeFileSync(build, [
      "import sys",
      "sys.path.insert(0, sys.argv[4])",
      "import lily_office_style as style",
      "from reportlab.pdfgen import canvas",
      "from reportlab.lib.pagesizes import A4",
      "from reportlab.pdfbase import pdfmetrics",
      "from reportlab.pdfbase.ttfonts import TTFont",
      "from pypdf import PdfWriter",
      "from PIL import Image, ImageDraw",
      "import pdfplumber",
      "font, _ = style.resolve_cjk_font()",
      "pdfmetrics.registerFont(TTFont('CJK', font, subfontIndex=0))",
      "c = canvas.Canvas(sys.argv[1], pagesize=A4); c.setFont('CJK', 16)",
      "c.drawString(60, 760, '统一社会信用代码：91110108MA01TEST9X')",
      "c.showPage(); c.save()",
      "with pdfplumber.open(sys.argv[1]) as pdf: pdf.pages[0].to_image(resolution=200).save(sys.argv[2])",
      "w = PdfWriter(clone_from=sys.argv[1]); w.encrypt('pw123'); w.write(sys.argv[3])",
      "shapes = Image.new('RGB', (600, 400), 'white'); ImageDraw.Draw(shapes).ellipse((60, 60, 520, 340), fill='navy')",
      "shapes.save(sys.argv[5])",
      "Image.new('P', (600, 400), 0).save(sys.argv[6])",
    ].join("\n"));
    const pdf = path.join(tmp, "scan.pdf");
    const png = path.join(tmp, "page.png");
    const encrypted = path.join(tmp, "locked.pdf");
    const shapes = path.join(tmp, "shapes.png");
    const blank = path.join(tmp, "blank.png");
    execFileSync(python, [build, pdf, png, encrypted, path.join(ROOT, "resources/runtime-scripts"), shapes, blank],
      { env, timeout: 300_000, stdio: ["ignore", "ignore", "pipe"] });

    check("the field case: a palette-mode page render is read, not silently emptied", () => {
      assert.equal(execFileSync(python, ["-c", `from PIL import Image; print(Image.open(${JSON.stringify(png)}).mode)`], { env, encoding: "utf8" }).trim(), "P",
        "the fixture must really be palette mode, or this proves nothing");
      const result = run(png);
      assert.equal(result.ok, true);
      assert.ok(result.text.includes("91110108MA01TEST9X"), `palette OCR returned: ${JSON.stringify(result.text)}`);
      assert.equal(result.warning, undefined, "text was found, so there is nothing to warn about");
    });

    check("an image with ink but no readable text says so; a blank one does not", () => {
      const withShapes = run(shapes);
      assert.equal(withShapes.ok, true);
      assert.equal(withShapes.text, "");
      assert.match(withShapes.warning, /not blank/, "empty OCR on a page with ink is a finding");
      const empty = run(blank);
      assert.equal(empty.text, "");
      assert.equal(empty.warning, undefined, "a genuinely blank image is not a finding");
    });

    check("an encrypted PDF is named as encrypted; a corrupt one keeps its own reason", () => {
      let locked;
      try {
        run(encrypted);
        throw new Error("an encrypted PDF must not extract");
      } catch (error) {
        locked = JSON.parse(String(error.stdout || "{}"));
      }
      assert.equal(locked.ok, false);
      assert.equal(locked.errorCode, "PDF_ENCRYPTED");
      assert.match(locked.hint, /password/i);
      assert.ok(locked.error, "the original exception type is preserved");

      const corrupt = path.join(tmp, "corrupt.pdf");
      fs.writeFileSync(corrupt, "not a pdf at all");
      let broken;
      try {
        run(corrupt);
        throw new Error("a corrupt PDF must not extract");
      } catch (error) {
        broken = JSON.parse(String(error.stdout || "{}"));
      }
      assert.equal(broken.ok, false);
      assert.equal(broken.errorCode, undefined, "corruption must not be mislabelled as encryption");
      assert.ok(String(broken.error).length > 25, "and it keeps a message that says something");
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${checks} checks passed (extraction honesty)`);
