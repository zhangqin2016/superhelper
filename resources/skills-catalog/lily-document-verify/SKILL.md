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

1. Render the document to page images with `{{RUNTIME_SCRIPTS_DIR}}/render_document.py`.
2. Inspect each relevant page image for clipped text, broken tables, unexpected blank pages, missing images, extra pages, font fallback, and content outside page margins.
3. Report honestly. Name the page and issue. If everything looks correct, say what was checked.

## Notes

- This is a final QA step. Pair it with document creation/editing skills.
- For very large documents, verify the pages that matter instead of rendering hundreds of pages at high scale.
- Route long render batches, many-file verification, and high-page-count visual
  checks through the generic `lily_process_jobs` supervisor. Observe with
  `job_status` and `job_logs`; render scripts should emit standard
  `[lily-progress]` events for file/page progress.
- Never claim visual correctness without looking at rendered pages.
