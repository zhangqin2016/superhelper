---
name: template-fill
description: Use this skill when the user wants to fill an existing Word (.docx) template with structured data, mail-merge style. The template already contains placeholders such as double-brace variables or Jinja2 loops. Do not use this to author a brand-new document from scratch or to extract content from a document.
license: Proprietary
intent: Fill an existing placeholder-based Word template deterministically. The model maps user-provided data to declared placeholders; code performs the render.
type: reference
---

# Template Fill

Fill an existing Word template containing Jinja2 placeholders and produce a new .docx. Placeholder replacement is deterministic and runs in Python.

## Workflow

1. Inspect declared placeholders with scripts/fill_template.py inspect.
2. Build a JSON object mapping user data to declared variable names.
3. Fill the template with scripts/fill_template.py fill.
4. Report output path, provided fields, and missing fields.

## Batch Mode

For one document per row, loop in code or shell: create a JSON object per row and call fill with a unique output path.
For large batch fills, run the batch through the generic `lily_process_jobs`
supervisor and observe with `job_status` and `job_logs`; batch scripts should
emit standard `[lily-progress]` events for completed/total documents. Single
template fills stay on the fast path.

## Rules

- Always inspect placeholders first.
- The top-level data file must be a JSON object.
- Never modify the template in place.
- Do not silently ship documents with missing values.
