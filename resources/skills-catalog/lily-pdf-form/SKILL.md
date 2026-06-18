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
