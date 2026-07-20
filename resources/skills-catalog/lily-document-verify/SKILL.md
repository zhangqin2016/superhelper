---
name: document-verify
description: Use this skill to visually verify a generated or edited document before delivering it. It catches layout problems that text extraction cannot see: overflow, blank pages, table misalignment, clipped content, broken PDF rendering, missing images, or font fallback. Do not use it to extract text content.
license: Proprietary
intent: Render documents to page images and inspect the actual visual layout before delivery. Rendering is deterministic; visual judgment is performed after looking at the page images.
type: reference
---

# Document Verify

Text extraction tells you what a document says; it cannot prove the document looks right. Use this skill after creating or editing .docx, .xlsx, .pptx, or .pdf files when visual layout matters.

## Workflow

1. Reopen the output with a deterministic library and confirm that its structure
   is valid. For formula-bearing workbooks, run the managed recalculation route
   and check for formula errors before visual QA.
2. Render each final document to page images with
   `{{RUNTIME_SCRIPTS_DIR}}/render_document.py`.
3. Actually open the rendered images with an image-reading tool. Inspect every
   page for artifacts up to 12 pages. For longer files, inspect the first page,
   last page, and at least 6 pages distributed across the document; inspect
   additional high-risk pages containing dense tables, charts, or images.
4. Check clipped or overlapping text, overflow, broken tables/charts, unexpected
   blank/extra pages, missing images, font fallback, inconsistent margins,
   headers/footers, and content outside the page boundary.
5. Fix only defects that were observed, then re-render and re-inspect affected
   pages. Report the pages checked, defects fixed, and any remaining unverified
   scope. Never label the artifact visually verified merely because rendering
   completed; the page images must have been read.

## Notes

- This is a final QA step. Pair it with document creation/editing skills.
- For very large documents, render at a practical scale and use the coverage
  rule above; increase coverage when risk or observed inconsistency warrants it.
- Route long render batches, many-file verification, and high-page-count visual
  checks through the generic `lily_process_jobs` supervisor. Observe with
  `job_status` and `job_logs`; render scripts should emit standard
  `[lily-progress]` events for file/page progress.
- Never claim visual correctness without looking at rendered pages.
