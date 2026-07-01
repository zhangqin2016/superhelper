---
name: lily-pdf-extraction-router
description: Use before reading or extracting PDF content. Selects the right path for digital PDFs, scanned PDFs, multi-column layouts, dense tables, forms, contracts, papers, page images, and optional pro PDF runtime packs.
---

# Lily PDF Extraction Router

Use this skill before parsing PDFs. The goal is to avoid choosing a weak extraction path for a hard document.

## Classify First

Determine whether the PDF is digital text, scanned pages, mixed, form-based, table-heavy, multi-column, contract-like, paper-like, presentation-like, image-heavy, or low-quality scan.

## Routing

- Digital text: use Lily's document extraction/index path first (pdfplumber or
  PyMuPDF-backed Python extraction), not the engine's generic `Read` tool.
- Scanned pages: use OCR path.
- Forms: inspect form fields and use PDF form filling when filling fields.
- Dense tables or complex layout: try Lily's fast extraction first, then
  recommend/install pro PDF runtime if structure quality matters.
- Docling/pro-pdf is explicit opt-in for extraction scripts. When a task truly
  needs Docling quality, run the extraction with `LILY_PDF_ENGINE=pro-pdf`;
  installing the pack alone must not change ordinary PDF reads.
- Layout verification: render pages and inspect images.
- Long PDFs: build or use a page-level workspace index first; then process
  relevant page ranges only. Use large-document for PyMuPDF/pikepdf-style page
  indexing and pro-pdf (Docling) when layout/reading order is the hard part.

## Quality Checks

- Preserve page references when summarizing.
- Mention extraction limits and uncertain structure.
- For tables, keep source page and header assumptions.
- For legal/financial content, distinguish extracted text from interpretation.

## Guardrails

- Do not use the generic `Read` tool as the source of truth for PDF content.
  `Read` returning `[Unsupported Document]` is only a limitation of that tool,
  not proof that the PDF is unreadable. Retry with Lily's document pipeline,
  pdfplumber/PyMuPDF extraction, OCR, or the document index before answering.
- Do not pretend OCR is exact.
- Do not use a heavy runtime for ordinary PDFs without need.
- Do not install large packs without explaining cost and getting confirmation when appropriate.
- Do not block the user while indexing a long PDF; indexing should be resumable
  or backgrounded, with answers limited to available evidence until it finishes.
- Route long PDF indexing, OCR, Docling/pro-pdf extraction, and page-render
  batches through the generic `lily_process_jobs` supervisor when the platform's
  built-in document pipeline is not already handling them. Observe with
  `job_status` and `job_logs`; extraction scripts should emit standard
  `[lily-progress]` events instead of PDF-specific progress protocols.
