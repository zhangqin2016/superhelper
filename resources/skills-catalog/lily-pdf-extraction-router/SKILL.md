---
name: lily-pdf-extraction-router
description: Use when a PDF must be read or parsed and the agent needs to choose the right extraction route for digital PDFs, scanned PDFs, multi-column documents, dense tables, image-only PDFs, complex contracts, papers, or when deciding whether to recommend the optional pro-pdf runtime pack. Routes PDF extraction before summarizing, translating, converting, or rebuilding content.
---

# Lily PDF Extraction Router

Choose the lightest PDF parsing path that can preserve the user's needed
content. This is a routing skill, not a replacement for PDF tools.

## When to Use

- The user asks to read, summarize, translate, compare, convert, or extract data
  from a PDF.
- The PDF may contain scans, image-only pages, multi-column text, footnotes,
  dense tables, merged cells, forms, contracts, reports, academic papers, or
  mixed text and images.
- A previous extraction looks wrong: missing paragraphs, broken table order,
  columns interleaved, page headers mixed into content, or OCR errors.
- The task must decide whether the built-in path is enough or whether to suggest
  installing a runtime pack such as `pro-pdf`.

## When Not to Use

- Filling named AcroForm fields: use `pdf-form`.
- Creating a polished PDF from scratch: create Word/PPT/Excel first, then export
  or render.
- Simple file operations such as split, merge, rotate, watermark, encrypt, or
  decrypt when no content extraction decision is needed.
- Non-PDF Office files: let `lily-office-intent` route them.

## Routing Workflow

1. Identify the user's output goal: plain text, tables, citations, exact reading
   order, images, conversion to Word/PPT/Excel, or high-confidence legal/academic
   extraction.
2. Inspect the PDF type before committing to a path:
   - Digital text present: use the built-in digital PDF extraction path first.
   - Page is mostly raster/image or text extraction is empty: use OCR.
   - Mixed pages: process page ranges differently and report any low-confidence
     pages.
3. Choose the route:
   - **Ordinary digital PDF**: use built-in extraction. Good for invoices,
     reports, manuals, single-column documents, and normal tables.
   - **Scanned PDF / image-only PDF**: use OCR. Preserve page numbers and mark
     uncertain text instead of silently guessing.
   - **Multi-column paper or magazine layout**: try built-in extraction, then
     check reading order. If columns interleave or footnotes/captions pollute the
     flow, recommend `pro-pdf`.
   - **Dense or merged tables**: use built-in table extraction first. If headers,
     row spans, or numeric columns are damaged, recommend `pro-pdf`; for final
     analysis, move clean tables into Excel.
   - **Complex contracts / legal bundles**: preserve clauses, section numbers,
     exhibits, definitions, signatures, and page references. Recommend `pro-pdf`
     when layout, stamps, scans, or nested tables affect meaning.
   - **Academic papers**: preserve title, authors, abstract, section order,
     equations, figure/table captions, citations, and bibliography. Recommend
     `pro-pdf` when two-column layout or formulas break the base extraction.
4. Validate extraction against rendered pages when correctness matters:
   compare a few source pages to extracted text/tables, especially first page,
   table pages, scanned pages, and pages with figures.
5. Report limitations explicitly: page ranges skipped, OCR uncertainty, table
   structure loss, or pages that need the runtime pack.

## Runtime Pack Decision

Suggest `runtime-packs` / `pro-pdf` only when the built-in path is likely
insufficient or has already failed:

- multi-column reading order matters;
- dense tables, merged cells, or table structure must survive;
- scan quality, stamps, handwriting, or images make OCR uncertain;
- the user asks for "high accuracy", "Docling", "professional PDF engine", or
  "专业 PDF 引擎";
- contracts, papers, reports, or due-diligence files require page-faithful
  reconstruction.

Before installation, tell the user it is a large optional download and get
confirmation. Do not `pip install` heavy PDF engines; use the `runtime-packs`
skill.

## Quality Red Lines

- Do not summarize content that was not actually extracted.
- Do not hide bad OCR or broken table structure.
- Do not collapse page numbers when citations, contracts, or audit trails matter.
- Do not treat image captions, footers, watermarks, or headers as body text
  without checking.
- Do not promise exact layout recovery from the light path when the document is
  multi-column, scanned, or table-heavy.

## Coordination

- Start from `lily-office-intent` when the user's task spans PDF plus Word,
  Excel, PPT, or verification.
- Use `document-verify` after converting or rebuilding a PDF-derived deliverable
  when layout fidelity matters.
- Use `runtime-packs` for optional `pro-pdf` installation/status/removal only
  after the routing decision says the heavier engine is justified.
