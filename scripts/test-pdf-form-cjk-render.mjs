#!/usr/bin/env node
/**
 * A Chinese value written into a PDF form field is DRAWN correctly by every reader.
 *
 * pypdf builds each field's appearance with the form's own font (Helvetica,
 * WinAnsi): a Chinese value became a literal "??????" in the appearance stream.
 * /NeedAppearances only asks the reader to redraw — pdfium and macOS Preview
 * did, our pdf.js preview, Firefox and printing did not (2026-09-29 field case;
 * earlier: acceptance 2026-09-17 DEF-02). The fill now writes each CJK field's
 * appearance itself with an embedded CJK font subset, as Acrobat and pdf-lib
 * do, and verifies by TEXT: pdfium flattens the appearances the way a reader
 * draws them and the field box must read back as the value — the old pixel
 * check passed "??????" because a question mark is ink.
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
  assert.match(source, /def _embed_cjk_appearances/, "the fill writes CJK appearances itself");
  assert.match(source, /def _verify_text_render/, "the check reads what a reader draws as text");
  assert.match(source, /FPDFPage_Flatten/);
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

    // Independent of the script's own report: flatten with pdfium and read each
    // field box back, and look inside the appearance streams for "?".
    const probe = path.join(tmp, "probe.py");
    fs.writeFileSync(probe, [
      "import sys, json",
      "import pypdfium2 as pdfium, pypdfium2.raw as raw",
      "from pypdf import PdfReader",
      "src = sys.argv[1]",
      "r = PdfReader(src)",
      "acro = r.trailer['/Root']['/AcroForm'].get_object()",
      "boxes, aps = {}, {}",
      "for a in r.pages[0]['/Annots']:",
      "    a = a.get_object(); name = str(a['/T']); boxes[name] = [float(v) for v in a['/Rect']]",
      "    n = a['/AP']['/N'].get_object(); aps[name] = n.get_data().decode('latin-1')",
      "doc = pdfium.PdfDocument(src); page = doc[0]",
      "raw.FPDFPage_Flatten(page.raw, raw.FLAT_NORMALDISPLAY); page.close()",
      "tp = doc[0].get_textpage()",
      "seen = {k: tp.get_text_bounded(left=b[0], bottom=b[1], right=b[2], top=b[3]).strip() for k, b in boxes.items()}",
      "print(json.dumps({'need': bool(getattr(acro.get('/NeedAppearances'), 'value', False)), 'seen': seen, 'qmarks': {k: ('(??' in v) for k, v in aps.items()}}, ensure_ascii=False))",
    ].join("\n"));
    const inspectPdf = (file) => JSON.parse(execFileSync(python, [probe, file], { encoding: "utf8", timeout: 120_000, env }));

    check("the field case: every reader draws the Chinese values, verified as text", () => {
      const output = path.join(tmp, "cjk.pdf");
      const result = run({ name: "星河科技（上海）有限公司", city: "马来西亚" }, output);
      assert.equal(result.ok, true);
      assert.equal(result.cjk, true);
      assert.equal(result.cjkRender.method, "flattened-text", "verified by what a reader draws, not by ink");
      assert.equal(result.cjkRender.verified, true);
      assert.equal(result.cjkRender.embeddedAppearances, 2, "both appearances written with an embedded CJK font");
      const seen = inspectPdf(output);
      assert.deepEqual(seen.seen, { name: "星河科技（上海）有限公司", city: "马来西亚" }, "flattened, each field reads back as its value");
      assert.deepEqual(seen.qmarks, { name: false, city: false }, "no \"??????\" left in any appearance stream");
      assert.equal(seen.need, false, "the appearances are authoritative: no reader is asked to redraw");
      assert.equal(result.cjkRender.flattened, undefined, "nothing is drawn onto the page itself");
    });

    // The document renderer the agent verifies with draws form fields: without
    // pdfium's form environment every filled field rendered blank, so a correct
    // form looked empty and a model "fixed" it by drawing values onto the page
    // and dropping the form (2026-09-29).
    check("the verification renderer draws filled form fields", () => {
      const out = path.join(tmp, "render");
      execFileSync(python, [path.join(ROOT, "resources/runtime-scripts/render_document.py"), path.join(tmp, "cjk.pdf"), out, "1"], { timeout: 180_000, env });
      const ink = path.join(tmp, "ink.py");
      fs.writeFileSync(ink, [
        "import sys", "from PIL import Image",
        "im = Image.open(sys.argv[1]).convert('L'); h = im.height",
        "box = im.crop((62, int(h - 720), 298, int(h - 702)))",
        "print(sum(1 for p in box.getdata() if p < 120))",
      ].join("\n"));
      const dark = Number(execFileSync(python, [ink, path.join(out, "page-1.png")], { encoding: "utf8", env }).trim());
      assert.ok(dark > 20, `the "name" field's text is visible in the verification render (${dark} dark pixels)`);
    });

    check("no usable CJK font: the viewer is asked to redraw, and the fill says it is unverified", () => {
      const output = path.join(tmp, "nofont.pdf");
      const dataPath = path.join(tmp, "nofont.json");
      fs.writeFileSync(dataPath, JSON.stringify({ name: "星河科技", city: "上海" }));
      const result = JSON.parse(execFileSync(python, [SCRIPT, "fill", form, dataPath, output], {
        encoding: "utf8", timeout: 180_000,
        env: { ...env, LILY_RUNTIME_SCRIPTS: path.join(tmp, "no-helpers"), LILY_CJK_FONT_PATH: path.join(tmp, "missing.ttf") },
      }));
      assert.equal(result.ok, true, "the values are still written");
      assert.deepEqual(result.cjkRender.leftToViewer, ["city", "name"]);
      assert.equal(result.cjkRender.verified, false, "an appearance it could not write is not claimed");
      assert.equal(inspectPdf(output).need, true, "the old hint stays for readers that redraw");
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${checks} checks passed (pdf form CJK render)`);
