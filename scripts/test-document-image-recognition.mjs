#!/usr/bin/env node
// Documents carry content that exists ONLY as pixels — a pasted invoice, a
// chart screenshot, a slide that is one picture. Extraction used to walk
// paragraphs, cells and text frames only, and a PDF page was OCR'd just when it
// had NO text, so that content vanished silently. These cases pin the recovery:
// pictures are recognized in document order, repeats are cited once, furniture
// is skipped, and a runtime without OCR still extracts the text it always did.
// [gate: attachment-content-grounding]
// Run: LILY_TEST_OFFICE_PYTHON=<python with docx/pptx/openpyxl/PIL/rapidocr> \
//        node scripts/test-document-image-recognition.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const python = process.env.LILY_TEST_OFFICE_PYTHON;
if (!python) {
  console.log("SKIP document image recognition: set LILY_TEST_OFFICE_PYTHON to a Python with python-docx, python-pptx, openpyxl, Pillow and rapidocr_onnxruntime (unchecked acceptance item)");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lily-doc-images-"));
const extractor = path.resolve("resources/runtime-scripts/extract_document.py");
const run = (file, interpreter = python) => {
  const raw = execFileSync(interpreter, [extractor, path.join(root, file)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true, `${file} extraction failed: ${parsed.error || ""}`);
  return parsed.text || "";
};
let checks = 0;
const check = (name) => { checks += 1; console.log(`ok - ${name}`); };

try {
  execFileSync(python, ["-c", `
import sys, pathlib
from PIL import Image, ImageDraw, ImageFont
W = pathlib.Path(sys.argv[1])
def draw(text, name, size=(900, 220)):
    img = Image.new("RGB", size, "white"); d = ImageDraw.Draw(img)
    try: font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 46)
    except Exception: font = ImageFont.load_default()
    d.text((30, 80), text, fill="black", font=font)
    img.save(W / name); return str(W / name)
invoice = draw("INVOICE 85321", "invoice.png")
logo = draw("ACME", "logo.png", (320, 170))
Image.new("RGB", (40, 40), "white").save(W / "icon.png")

from docx import Document
from docx.shared import Inches
doc = Document(); doc.add_picture(invoice, width=Inches(6)); doc.save(W / "image_only.docx")
doc = Document(); doc.add_paragraph("paragraph before"); doc.add_picture(invoice, width=Inches(6))
doc.add_paragraph("paragraph after"); doc.save(W / "text_and_image.docx")
doc = Document()
for i in range(4):
    doc.add_paragraph(f"section {i}"); doc.add_picture(logo, width=Inches(2))
doc.add_picture(str(W / "icon.png")); doc.save(W / "repeats.docx")

from pptx import Presentation
from pptx.util import Inches as PInches
prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[6])
slide.shapes.add_picture(invoice, PInches(1), PInches(1), width=PInches(6))
prs.save(W / "picture_only.pptx")

import openpyxl
from openpyxl.drawing.image import Image as XLImage
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Data"; ws["A1"] = "total"; ws["B1"] = 7
ws.add_image(XLImage(invoice), "D2"); wb.save(W / "book.xlsx")

Image.open(invoice).save(W / "scanned.pdf", "PDF", resolution=144)
`, root], { stdio: "inherit", timeout: 300_000 });

  // A Word file whose content is entirely a picture used to extract to nothing.
  const imageOnly = run("image_only.docx");
  assert.match(imageOnly, /85321/, "a picture-only Word file yields its picture text");
  check("a picture-only Word file is no longer empty");

  // Placement matters: an invoice pasted between two paragraphs must read there.
  const mixed = run("text_and_image.docx");
  assert.match(mixed, /85321/);
  assert.ok(
    mixed.indexOf("paragraph before") < mixed.indexOf("85321") && mixed.indexOf("85321") < mixed.indexOf("paragraph after"),
    "the picture keeps its position in the prose",
  );
  check("Word pictures are recognized in document order");

  // A slide that is one screenshot, with no text frame at all.
  assert.match(run("picture_only.pptx"), /85321/);
  check("a picture-only slide yields its picture text");

  assert.match(run("book.xlsx"), /85321/);
  check("workbook pictures are recognized");

  // The 2026-09-15 gap: a PDF page WITH a text layer still hid its pictures.
  const soffice = process.env.LILY_TEST_SOFFICE;
  if (soffice && fs.existsSync(soffice)) {
    execFileSync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", root, path.join(root, "text_and_image.docx")], { stdio: "ignore", timeout: 300_000 });
    const pdfMixed = run("text_and_image.pdf");
    assert.match(pdfMixed, /paragraph before/);
    assert.match(pdfMixed, /85321/, "a PDF page that has text still gets its pictures read");
    check("PDF pages with a text layer no longer hide their pictures");
  } else {
    console.log("ok - (skipped) PDF mixed-page case needs LILY_TEST_SOFFICE");
  }

  // Unchanged behaviour: a scan with no text layer is still whole-page OCR'd.
  assert.match(run("scanned.pdf"), /85321/);
  check("scanned PDFs keep their whole-page OCR");

  // Furniture is skipped and a repeated logo is read once, then cited.
  const repeats = run("repeats.docx");
  assert.equal((repeats.match(/ACME/g) || []).length, 1, "a repeated logo is recognized once");
  assert.ok(repeats.includes("again"), "later occurrences are cited, not re-recognized");
  assert.match(repeats, /\[Images: .*not read/, "skipped furniture is reported, never silently dropped");
  assert.match(repeats, /section 0[\s\S]*section 3/, "the text around the pictures is intact");
  check("repeated pictures are cited once and furniture is reported");

  // Fail-open: a runtime without OCR must still extract the text it always did.
  const plain = process.env.LILY_TEST_PYTHON_WITHOUT_OCR;
  if (plain && fs.existsSync(plain)) {
    const degraded = run("text_and_image.docx", plain);
    assert.match(degraded, /paragraph before/, "text extraction is unaffected without OCR");
    assert.doesNotMatch(degraded, /85321/);
    assert.match(degraded, /runtime unavailable/, "and the document says the picture was not read");
    assert.equal((degraded.match(/\[Image/g) || []).length, 1, "one honest line, not one per picture");
    check("a runtime without OCR degrades to text plus one notice");
  } else {
    console.log("ok - (skipped) degraded case needs LILY_TEST_PYTHON_WITHOUT_OCR");
  }

  console.log(`document-image-recognition: ok (${checks} checks)`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
