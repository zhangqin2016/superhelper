---
name: lily-office-intent
description: Use when the user asks to create, edit, read, verify, convert, fill, summarize, or analyze Word, PDF, PowerPoint, Excel, templates, forms, or document batches. Routes the task to the correct office/document capability before acting.
---

# Lily Office Intent Router

Use this skill before office-document work. The job is to select the right path before acting.

## Chat-Native Capability Contract

Start from the user's natural language request and the attached/referenced files.
Do not require a separate UI workflow before the assistant can help. Choose the
document capability chain in chat, expose evidence and output paths, and keep the
user able to continue typing while long extraction, indexing, OCR, conversion, or
verification work runs.

This skill is fail-open: if one extractor, renderer, indexer, OCR route, or
dependency pack fails, fall back to the next deterministic route or a
path-first/source-file approach. Return partial evidence and the remaining gap
instead of treating the whole document task as impossible.

## Task Types

- Word: author, edit, format, comment, compare, template output.
- PDF: read, extract, verify, fill form, convert, render, inspect layout.
- PowerPoint: create, edit, redesign, verify, export.
- Excel: analyze, clean, chart, compare, formula/recalculation, export.
- Templates: fill existing placeholders deterministically.
- Mixed batches: convert, extract, summarize, or verify multiple files.

## Routing Rules

1. Identify deliverable and file type.
2. Inspect first. For referenced files, get metadata before reading content:
   file type, byte size, page/sheet count when available, and dependency route.
3. Small ordinary files may use the existing fast extraction path.
4. Large files must not be read wholesale into the prompt. Route them to a
   background workspace index and keep the user able to continue typing.
5. Prefer deterministic scripts for conversion, extraction, filling, rendering, and recalculation.
6. Use model judgment for summarization, classification, writing, review, and interpretation.
7. For PDFs, choose digital extraction, OCR, form filling, visual verification, page-level index, or pro runtime before acting.
   Do not treat the generic `Read` tool as a PDF parser; `[Unsupported Document]`
   means the tool failed, not that Lily's pdfplumber/PyMuPDF/OCR pipeline failed.
8. For Excel, choose sheet-level index/query for large workbooks instead of full-file reads.
9. For images/video, route to metadata/OCR/media probing first; install opencv/rapidocr/ffmpeg only when needed.
10. For generated/edited office files, verify with rendering when layout matters.
11. Return absolute output paths and note skipped or uncertain steps.

## Guardrails

- Do not invent document contents.
- Do not silently ignore unreadable files or missing placeholders.
- Do not use a visual model for deterministic conversion when a script exists.
- Do not block the conversation on a long index/extraction job; report status and continue with available evidence.
- Keep long document, image, video, and batch work progress observable: report
  what is running, current file/page/sheet when known, completion count, and
  whether the answer is based on partial or complete evidence.
- Route long document indexing, OCR batches, media probing, conversion batches,
  and workspace extraction through the generic `lily_process_jobs` supervisor
  when they are not handled by the platform's built-in pre-send pipeline. Observe
  them with `job_status` and `job_logs`; scripts should emit standard
  `[lily-progress]` events. Small ordinary extraction stays on the fast path.
