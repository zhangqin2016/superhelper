---
name: lily-ppt-design-qa
description: "Use after creating or editing a PowerPoint deck to visually inspect and fix presentation quality: hierarchy, layout, overflow, visual consistency, excessive text, image/chart quality, exported rendering, placeholders, and delivery readiness. A final QA workflow for .pptx generation or modification."
---

# Lily PPT Design QA

Treat every generated or edited deck as untrusted until it has been rendered and
visually inspected. This skill is a quality gate after PPT creation/editing.

## When to Use

- A `.pptx` was created, edited, converted, merged, or templated.
- The user asks whether the slides look professional, consistent, readable, or
  ready to send.
- A deck was generated from Word/PDF/Excel analysis and may have layout or chart
  issues.
- The deck must be exported to PDF/images or verified after export.

## When Not to Use

- Reading or editing PPT content before generation: use the PPT tooling skill.
- General web/UI visual QA: use UI/browser QA skills.
- Spreadsheet chart/data correctness before it enters slides: use
  `lily-excel-data-analysis`.
- PDF extraction before deck generation: use `lily-pdf-extraction-router`.

## QA Workflow

1. Render the deck to page images or PDF using `document-verify` / the local
   render path. Inspect actual rendered slides, not only the PPT XML or text.
2. Check slide by slide:
   - hierarchy: title prominence, section flow, emphasis, and reading order;
   - layout: margins, alignment, grid consistency, balance, and whitespace;
   - overflow: clipped text, text outside shapes, wrapped titles, hidden notes,
     table/chart labels cut off, and footer collisions;
   - consistency: typography, colors, spacing, icon style, page numbers,
     headers/footers, and repeated components;
   - density: too many bullets, paragraphs too small to read, overloaded charts,
     or slides that should be split;
   - visuals: image resolution, crop, distortion, relevance, contrast, and
     chart legibility;
   - leftovers: template placeholders, lorem ipsum, unused guides, wrong logo,
     stale source citations, or duplicate slides.
3. Fix issues in the deck source, not only the exported artifact.
4. Re-render affected slides. One layout fix can create a new overflow problem.
5. Verify export when the user needs PDF/images: open or render the exported
   file and confirm it matches the deck.
6. Report what was checked, what was fixed, and any remaining limitations.

## Quality Red Lines

- Do not deliver a generated deck without rendering at least the changed slides.
- Do not accept text that is visibly clipped, overlapping, or too small to read.
- Do not leave template placeholder text, broken image links, or missing charts.
- Do not hide low-resolution or distorted images.
- Do not let charts lose axis labels, legends, units, or source notes.
- Do not claim a PDF export is ready without verifying the exported output.

## Coordination

- Let `lily-office-intent` route mixed Office workflows such as "turn this PDF
  into a presentation" or "make slides from this Excel analysis".
- Use PPT tooling to create or edit the deck, then apply this skill as the final
  design and rendering gate.
- Use `document-verify` for rendering `.pptx` or exported `.pdf` to images.
- Use `lily-excel-data-analysis` when slide charts or numbers depend on a
  spreadsheet analysis.
- Use `runtime-packs` only when local Office conversion/rendering is unavailable
  and the optional LibreOffice runtime is needed.
