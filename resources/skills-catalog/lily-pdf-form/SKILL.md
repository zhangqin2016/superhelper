---
name: pdf-form
license: Proprietary
description: Use this skill when the user wants to fill an existing fillable PDF form. It reads AcroForm fields, maps user data to those fields, writes a new filled PDF, and reports missing fields. Do not use it to design a new form or extract general PDF content.
intent: Deterministically fill existing PDF AcroForm fields with structured data. The model maps user-provided information to field names; code performs the fill.
type: reference
---

# PDF Form Fill

Use this skill for existing fillable PDFs. It does not redesign the document. It reads field names, maps data, and creates a new PDF.

## Workflow

1. Inspect fields with scripts/fill_pdf_form.py inspect.
2. Build a JSON object mapping exact field names to values.
3. Fill the form with scripts/fill_pdf_form.py fill.
4. Report output path, filled fields, and missing fields.

## Rules

- Always inspect field names first; never guess.
- Output is a new file; do not modify the original form.
- If the PDF has no AcroForm fields, say it is not a fillable form and choose another PDF/document path.
- For layout-sensitive forms, render and visually verify the output.

## Rule: Chinese / CJK values (occlusion is a delivery gate)

A form's default appearance font (usually Helvetica) cannot draw Chinese glyphs,
so a Chinese value can render as boxes (tofu 遮挡) or as nothing at all. To
prevent this:

- The fill script writes each CJK field's appearance ITSELF, with the platform's
  verified CJK font embedded as a subset — the way Acrobat and pdf-lib do. The
  field keeps its value, background, border and stays editable; every reader
  (our preview, Chrome, Firefox, macOS Preview, printing) draws the same text.
  `/NeedAppearances` is then off: nothing is left for a viewer to redraw. The
  `fill` result includes `"cjk": true` when a CJK value was written.
- It verifies what a reader actually draws: pdfium flattens the appearances onto
  the page and each CJK field box is read back as TEXT, which must equal the
  value. The result carries `cjkRender: {checked, verified, method:
  "flattened-text", embeddedAppearances, blankFields[]}`; a mismatch is listed per
  field with what was rendered.
- Only when no usable CJK font exists (or a value has characters the font cannot
  draw) is a field left to the viewer: it is listed in `cjkRender.leftToViewer`,
  `/NeedAppearances` stays on, and `verified` is false. Say so to the user; do
  not claim the form is correct.
- NEVER hand-roll a repair: do not draw values onto the page with your own
  script, and do not rewrite the PDF with `PdfWriter().add_page(...)` — that
  drops the whole AcroForm, and the form's own "?" appearances then sit on TOP of
  anything drawn underneath (2026-09-29 field case). Re-run this script instead;
  `--flatten-cjk` remains only for a field listed in `blankFields`.
- The document renderer draws form fields (pdfium form environment), so a
  rendered page shows the filled values. Still look at it before delivering: it
  proves the right text is drawn, not clipped, not overlapping the labels.
- Do NOT build a fillable form with Chinese default values using reportlab's
  `canvas.acroForm`. Its PDF string escape is a 0-255 lookup table, so any CJK
  character raises `KeyError`. Fill an EXISTING form with this script, or produce
  a designed PDF from a Word template through LibreOffice.
- Long values can be clipped by a small field box. Field boxes must be large
  enough for the text; where the form allows, prefer multiline or auto-size
  fields. If a value overruns its box, shorten it or flag the form as unsuitable
  rather than shipping clipped/occluded text.
