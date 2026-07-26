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

When a dependency appears missing or broken, first use Lily capability status
and managed runtime-pack install/repair routes. Do not ask the user to install
or fix local dependencies until Lily-managed repair, alternate bundled paths,
and deterministic fallbacks have all failed. Agent-facing runtime-pack installs
are background jobs: do not pass `wait: true`; observe progress with
`runtime_pack_list` and continue safe independent work while the repair runs.

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

## Authoring Quality Contract

For create, redesign, or substantial edit tasks, use this adaptive contract:

1. Derive a compact content and design brief from the request: audience,
   purpose, format, page/slide/sheet scale, brand constraints, tone, and required
   sections. Infer a restrained professional default when details are absent;
   ask only when an unknown would materially change the deliverable.
2. Preserve an existing template, theme, master, formulas, and document
   structure when supplied. For scratch authoring, use the bundled Python stack:
   `python-docx` for Word, `python-pptx` for PowerPoint, `openpyxl`/`xlsxwriter`
   for Excel, and ReportLab for direct-drawn PDFs when it imports successfully.
   Missing similarly named Node packages is not evidence that the capability is
   unavailable; a stale runtime without ReportLab uses the structured-source
   LibreOffice route instead of installing packages ad hoc.
3. For layout-rich business PDFs, prefer a structured DOCX or other editable
   source and export through managed LibreOffice. Use direct ReportLab drawing
   when fixed coordinates are genuinely appropriate. Use
   `LILY_CJK_FONT_PATH` whenever direct PDF drawing contains CJK text.
4. Establish a small design system before authoring: page geometry, type scale,
   CJK-safe font choices, spacing rhythm, color roles, table style, chart style,
   headers/footers, and image treatment. Font choices mean the PAIR: a latin
   typeface plus an East Asian one (`w:eastAsia` in Word, `a:ea` in PowerPoint)
   — a latin-only setting guarantees per-machine CJK fallback drift. The shared
   helper `resources/runtime-scripts/lily_office_style.py` (`style_docx`,
   `style_pptx`, `LIGHT_THEME`, `contrast_ok`) applies the defaults
   deterministically; decks default to light backgrounds. Apply the system
   consistently instead of formatting elements one at a time.
5. Reopen the generated file with its deterministic library and validate its
   structure. Recalculate formula workbooks, render the final artifact, inspect
   the required pages, fix observed defects, and repeat until the delivery gate
   passes or the remaining blocker is explicitly reported.

## Conversion Source Protection

For conversion/export-only requests (`convert`, `export as`, `save as`,
`重新转换`, `导出为`, `另存为`) the source file is evidence, not an edit target.
Treat the input document as immutable unless the user explicitly asks to edit
that source file.

1. Produce or replace only the requested output artifact. Do not edit,
   normalize, repair, or overwrite the source Office/PDF file while converting.
2. If conversion exposes a problem that appears to require source edits
   (for example a glyph that renders poorly, a missing font, or broken document
   XML), stop and ask the user before changing the source. Offer a separate
   repaired copy when useful.
3. If every deterministic conversion route fails, report the missing local
   dependency or broken executable precisely, but only after trying Lily-managed
   runtime-pack install/repair and alternate bundled paths. Do not silently
   regenerate substitute content.

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
