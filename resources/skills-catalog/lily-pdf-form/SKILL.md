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

- The fill script sets `/NeedAppearances = true` on the output so the viewer
  regenerates field appearances with its own CJK-capable font. This is set AFTER
  the values are written (the fill step resets the flag) and is fail-open and
  harmless for ASCII-only fills. The `fill` result includes `"cjk": true` when a
  CJK value was written.
- After filling a form with any Chinese value, VERIFY the rendered PDF
  (render → look at the pixels), do not trust the write alone. Occluded, blank,
  or tofu Chinese text is a delivery gate: do not ship a form whose Chinese
  fields show as boxes or blanks.
- Long values can be clipped by a small field box. Field boxes must be large
  enough for the text; where the form allows, prefer multiline or auto-size
  fields. If a value overruns its box, shorten it or flag the form as unsuitable
  rather than shipping clipped/occluded text.
