# 2026-07-21 — Reference-style document generation (lily-doc-style-reference)

## Why

User report: "参考生成会丢失很多样式" — asking the platform to generate a
document based on a reference doc loses fonts, colors, borders, number
formats, headers/footers. Root-cause chain (verified in code):

1. **The model never sees the styles.** Attachments go through
   `resources/runtime-scripts/extract_document.py`, which is text-only:
   docx → headings/paragraphs/markdown tables; xlsx → `values_only` markdown
   (no fills/borders/formats/merges/widths); pptx → text. "参考生成" degrades
   to "参考文字内容生成".
2. **No prescribed route for "以 A 为样式生成 B".** anthropics-docx/xlsx
   cover edit-in-place and template preservation, but a NEW deliverable based
   on a reference has no owner, so the model defaults to
   `Document()`/`Workbook()` from scratch = library defaults = styles gone.
3. The fidelity-correct technique exists but nothing leads the model to it:
   **copy the reference as the base file and edit the copy** (python-docx /
   openpyxl / python-pptx keep theme/styles/numbering/headers by
   construction).

## What shipped

New first-party skill `lily-doc-style-reference`
(`resources/skills-catalog/lily-doc-style-reference/SKILL.md`):

- Trigger (model-judged, via description): user wants a deliverable styled
  after a provided reference ("按照这个模板/参考这个文件/照这个格式"). NOT for
  placeholder mail-merge (template-fill), NOT for no-reference from-scratch
  design (creation skills own that — keeps their design quality untouched).
- Workflow: render the reference with `render_document.py` and READ the page
  images (vision pipeline) before writing anything → choose copy-as-base
  (default) vs style-matched rebuild by judgment → render the output and
  visually compare against reference pages → deliver via document-verify.
- Rules: never start from a blank library document when a copy can carry the
  styles; never modify the reference in place; no domain/brand hardcoding —
  the model judges what "matching" means (user directive).

Registration (mirrors lily-document-verify): `registry.json` skill entry +
`capabilities` map entry (kind tool, verification methods
render_reference_pages/copy_base_preserves_styles/visual_compare_with_reference),
`skill-localization/zh-CN.json` + `ar.json`, `OFFICE_STARTER_SKILL_IDS` in
`src/main/skill-presets.js`. `scripts/stamp-skill-registry.mjs` re-stamped.

## Gotchas hit (for the next skill addition)

- Adding a curated skill breaks FIVE count pins across
  `test-skill-catalog.mjs` (28/29 counts in four places) and
  `test-skill-presets.mjs` (featured 23, preset total 14) — update all.
- Every skill needs a `capabilities` map entry in registry.json
  (`test-skill-capability-contracts`).
- The checked-in registry was STALE at HEAD: re-stamping changed ~17 other
  skills' contentRevisions (verified: HEAD entries recompute to the new
  values). A full stamp is correct maintenance, not collateral damage.
- `test-skill-catalog-governance` still fails at baseline (undeclared
  category "coding" for lily-coding-core) — pre-existing, untouched.
