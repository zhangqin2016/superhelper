---
name: lily-office-intent
description: Use when the user asks to create, edit, read, verify, convert, fill, summarize, or analyze Word, PDF, PowerPoint, Excel, templates, forms, or document batches. Routes the task to the correct office/document capability before acting.
---

# Lily Office Intent Router

Use this skill before office-document work. The job is to select the right path before acting.

## Task Types

- Word: author, edit, format, comment, compare, template output.
- PDF: read, extract, verify, fill form, convert, render, inspect layout.
- PowerPoint: create, edit, redesign, verify, export.
- Excel: analyze, clean, chart, compare, formula/recalculation, export.
- Templates: fill existing placeholders deterministically.
- Mixed batches: convert, extract, summarize, or verify multiple files.

## Routing Rules

1. Identify deliverable and file type.
2. Prefer deterministic scripts for conversion, extraction, filling, rendering, and recalculation.
3. Use model judgment for summarization, classification, writing, review, and interpretation.
4. For PDFs, choose digital extraction, OCR, form filling, visual verification, or pro runtime before acting.
5. For generated/edited office files, verify with rendering when layout matters.
6. Return absolute output paths and note skipped or uncertain steps.

## Guardrails

- Do not invent document contents.
- Do not silently ignore unreadable files or missing placeholders.
- Do not use a visual model for deterministic conversion when a script exists.
