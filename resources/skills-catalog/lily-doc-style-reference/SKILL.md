---
name: doc-style-reference
description: Use this skill when the user wants a document created or edited BASED ON a reference document's appearance — "按照这个模板做", "参考这个文件的格式", "照这个样子生成", "make it look like this one", or any ask where a provided .docx/.xlsx/.pptx/.pdf is the STYLE source for the deliverable. Text extraction alone cannot see styling, so this skill renders the reference to page images and reads them before producing anything. Do not use it for placeholder-based mail merge (template-fill), for pure content extraction, or when there is no reference document — from-scratch design belongs to the document creation skills.
license: Proprietary
intent: Deliverables that must LOOK like a user-supplied reference keep its styling. The model sees the reference visually, chooses copy-as-base vs style-matched rebuild by judgment, and visually compares the result before delivery. No deterministic style rules; the model judges what "matching" means.
type: reference
---

# Doc Style Reference

A reference document given as a style source loses almost everything when the
workflow is "extract its text, then build a new file from library defaults":
text extraction carries words and table values, but never fonts, colors,
borders, number formats, column widths, headers/footers, or page setup. This
skill exists so the styling survives.

## Workflow

1. Identify the reference document(s) and what the deliverable must take from
   them — overall look, one section's layout, a letterhead, a table format.
   The user's words decide; do not assume the whole file is always the
   template.
2. SEE the reference before writing anything. Render it with
   `{{RUNTIME_SCRIPTS_DIR}}/render_document.py` and actually open the page
   images with an image-reading tool. Note the concrete style decisions:
   fonts and sizes per level, theme colors, table borders and shading, cell
   number formats, column widths, margins, headers/footers, logo placement.
   Extract the text too (`extract_document.py`) for content structure.
3. Choose the production route by fidelity need:
   - **Copy-as-base (default whenever the structure maps)**: copy the
     reference file and edit the COPY. python-docx / openpyxl / python-pptx
     opening the copy keep the theme, styles, numbering, headers/footers,
     and cell formatting by construction. Replace only the content that must
     change; add new content using the styles already present.
   - **Style-matched rebuild (only when the structure differs fundamentally)**:
     create the new document but replicate the style decisions observed in
     step 2 — never accept library defaults for anything the reference
     defines.
4. Compare before delivery. Render the output with
   `{{RUNTIME_SCRIPTS_DIR}}/render_document.py`, open the page images, and
   hold them against the reference pages. Fix observed mismatches and
   re-render affected pages. Differences that remain must be intentional,
   not accidental.
5. Deliver through the normal visual verification route (document-verify).

## Rules

- Never start a reference-based deliverable from a blank library document
  when a copy of the reference can carry its styles.
- Never modify the user's reference file in place — always work on a copy.
- The model judges which route applies and what "matching" means; do not
  hardcode domain, language, or brand rules into the workflow.
- When there is no reference document, this skill does not apply — the
  creation skills own from-scratch design quality.
