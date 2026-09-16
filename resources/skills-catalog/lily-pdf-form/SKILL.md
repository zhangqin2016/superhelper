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
- The script now DOES this check itself: after writing, it rasterises the output
  and looks for ink inside each CJK field's box. The result carries
  `cjkRender: {checked, verified, blankFields[], warning}`. `verified: false`
  means a reader that ignores `/NeedAppearances` shows nothing there — that is the
  defect, reported per field with its name and rectangle, not a guess.
- To repair it, re-run `fill` with `--flatten-cjk`. The value is drawn onto the
  page itself with the platform's verified CJK font, and the check is re-run to
  confirm it is now visible. It is opt-in because a reader that DOES honour
  `/NeedAppearances` would then draw the value twice.
- Still look at the rendered PDF before delivering. The ink check proves
  something was drawn in the box; only your eyes prove it is the right text, not
  clipped, and not overlapping the form's own labels.
- Do NOT build a fillable form with Chinese default values using reportlab's
  `canvas.acroForm`. Its PDF string escape is a 0-255 lookup table, so any CJK
  character raises `KeyError`. Fill an EXISTING form with this script, or produce
  a designed PDF from a Word template through LibreOffice.
- Long values can be clipped by a small field box. Field boxes must be large
  enough for the text; where the form allows, prefer multiline or auto-size
  fields. If a value overruns its box, shorten it or flag the form as unsuitable
  rather than shipping clipped/occluded text.
