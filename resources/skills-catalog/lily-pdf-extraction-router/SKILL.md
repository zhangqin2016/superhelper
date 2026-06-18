---
name: lily-pdf-extraction-router
description: Use before reading or extracting PDF content. Selects the right path for digital PDFs, scanned PDFs, multi-column layouts, dense tables, forms, contracts, papers, page images, and optional pro PDF runtime packs.
---

# Lily PDF Extraction Router

Use this skill before parsing PDFs. The goal is to avoid choosing a weak extraction path for a hard document.

## Classify First

Determine whether the PDF is digital text, scanned pages, mixed, form-based, table-heavy, multi-column, contract-like, paper-like, presentation-like, image-heavy, or low-quality scan.

## Routing

- Digital text: use normal text extraction first.
- Scanned pages: use OCR path.
- Forms: inspect form fields and use PDF form filling when filling fields.
- Dense tables or complex layout: try built-in extraction, then recommend/install pro PDF runtime if structure quality matters.
- Layout verification: render pages and inspect images.
- Long PDFs: sample pages first; then process relevant ranges.

## Quality Checks

- Preserve page references when summarizing.
- Mention extraction limits and uncertain structure.
- For tables, keep source page and header assumptions.
- For legal/financial content, distinguish extracted text from interpretation.

## Guardrails

- Do not pretend OCR is exact.
- Do not use a heavy runtime for ordinary PDFs without need.
- Do not install large packs without explaining cost and getting confirmation when appropriate.
