---
name: pdf-form
description: "Use this skill to fill a fillable PDF form (AcroForm) that has named fields — government, bank, application, or registration forms supplied as a fillable .pdf. Triggers: 填 PDF 表单, 填写可填写的 PDF, 'fill out this PDF form', 'complete the AcroForm fields'. Do NOT use to design a new PDF from scratch, or for a contract/certificate/invoice — for those, fill a Word template (template-fill skill) and convert to PDF."
license: Proprietary
intent: >-
  填写带命名字段的可填写 PDF 表单(AcroForm)：把数据写入已有字段，
  输出新 PDF。字段替换由代码做（pypdf），模型只负责整理 {字段: 值} 映射，
  并在有字段缺数据时如实告知。版式化/证书/合同类 PDF 请走 Word 模板→PDF。
type: reference
---

# PDF Form Fill (AcroForm)

Fill an existing **fillable** PDF — one that already has named form fields — with
structured data, producing a new PDF. Deterministic (pypdf), no new dependencies.

**When NOT to use this:** to produce a designed document (contract, certificate,
invoice, report), don't draw a PDF field-by-field. Fill a Word template with the
**template-fill** skill, then convert it to PDF with LibreOffice — that path is
WYSIWYG and far more faithful. This skill is only for forms that are *already*
fillable PDFs with field widgets.

## Workflow

1. **Inspect the form** to learn its field names — never guess them:

   ```bash
   python scripts/fill_pdf_form.py inspect /path/to/form.pdf
   # → {"ok": true, "fields": ["full_name", "city", "date", ...]}
   ```

   If `fields` is empty, the PDF is not a fillable AcroForm — fall back to the
   Word-template→PDF route instead.

2. **Build the data mapping** (the judgment part): map the user's answers onto
   the field names. Write a JSON object, e.g. `data.json`:

   ```json
   { "full_name": "Zhang San", "city": "Shanghai", "date": "2026-06-13" }
   ```

3. **Fill**:

   ```bash
   python scripts/fill_pdf_form.py fill /path/to/form.pdf data.json /path/to/output.pdf
   # → {"ok": true, "output": "...", "missing": [], "provided": [...]}
   ```

4. **Report honestly.** If `missing` is non-empty, those fields had no data and
   were left blank — tell the user which ones and ask for the values.

5. **Verify (recommended).** CJK and some fonts can render differently across
   viewers. Use the **document-verify** skill to render the filled PDF to images
   and confirm the values appear correctly before delivering.

## Notes

- Data must be a JSON **object** (`{...}`) of field-name → value.
- Output is always a new file; the source form is never modified in place.
- Checkbox/radio fields take their "on" state name as the value (see the field
  inspection output); most forms are text fields.
- The filler sets `NeedAppearances` so viewers regenerate field appearances with
  their own fonts — this is what makes CJK values display correctly.
