---
name: document-verify
description: "Use this skill to visually verify a generated or edited document before delivering it — catch layout problems that text extraction cannot see. Triggers: 检查文档排版/有没有溢出/空白页/表格错位, 'verify the document looks right', 'check the layout', 'did the PDF render correctly', or as a final QA step after creating a .docx/.xlsx/.pptx/.pdf. Renders the document to page images, then you inspect them. Do NOT use to extract text content (that is reading, not verifying)."
license: Proprietary
intent: >-
  文档质量闭环的"眼睛":把 .docx/.xlsx/.pptx/.pdf 渲染成逐页图片，
  再由多模态模型实际查看排版——溢出、错位表格、空白页、超出页边距等
  纯文本提取看不到的问题。渲染是确定性代码，视觉判断由模型做。
type: reference
---

# Document Verify (visual QA)

Text extraction tells you *what* a document says; it can't tell you whether it
*looks* right. This skill renders a document to per-page images so you can look
at the actual rendered result and catch layout defects before delivery.

Rendering is deterministic (LibreOffice → PDF → page images, in code). The
judgment — "does this look correct?" — is yours, from looking at the images.

## Workflow

1. **Render the document to page images:**

   ```bash
   python /path/to/resources/runtime-scripts/render_document.py /path/to/doc.docx /tmp/verify-out
   # → {"ok": true, "images": ["/tmp/verify-out/page-1.png", ...], "pages": 3}
   ```

   Works for `.docx/.xlsx/.pptx/.pdf` (and legacy `.doc/.xls/.ppt`). Office files
   are converted with LibreOffice first; PDFs are rasterized directly. An optional
   third argument sets the render scale (default `2.0` ≈ 144 dpi).

2. **Look at each page image** and check for:
   - text or table cells overflowing/clipped at the margin,
   - broken or misaligned table structure,
   - unexpected blank pages,
   - content that ran onto an extra page or got cut off,
   - missing images/charts, or obvious font/encoding fallback (e.g. CJK tofu).

3. **Report honestly.** State which page has which problem and propose a fix. If
   everything looks right, say so. Never claim a document is correct without
   having actually looked at the rendered pages — that is the whole point.

## Notes

- This is a final QA step. Pair it with the `docx`/`xlsx`/`pptx`/`template-fill`
  skills that *produce* the document.
- Rendering many large pages costs time and memory; verify the pages that matter
  rather than rasterizing a 200-page file at high scale.
