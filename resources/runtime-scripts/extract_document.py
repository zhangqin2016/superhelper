#!/usr/bin/env python3
"""Structured document extraction for the pre-send enrichment path.

Delegates to the bundled libraries instead of hand-rolling XML parsing in JS —
python-docx (docx), openpyxl (xlsx), python-pptx (pptx), pdfplumber (pdf).
Tables are preserved as Markdown so models without native document blocks still
receive real structure, not flattened text.

PDF/image strategy is consumer-first (no torch — stays light on ordinary
laptops): digital PDFs read their text layer with pdfplumber; only pages with
no text layer (scans) are rendered with pypdfium2 and OCR'd with RapidOCR
(onnxruntime). The OCR engine is imported lazily, so digital PDFs and Office
files never pay for it.

Usage: python extract_document.py <file_path>
Emits a single JSON object on stdout: {"ok": true, "text": "..."} or
{"ok": false, "error": "..."}.
"""

import json
import os
import sys


def _rows_to_markdown(rows):
    rows = [["" if c is None else str(c) for c in row] for row in rows if row is not None]
    rows = [row for row in rows if any(cell.strip() for cell in row)]
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    out = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    for row in rows[1:]:
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


def extract_docx(path):
    # python-docx walked in document order keeps headings, paragraphs and
    # tables interleaved correctly — and renders tables as real Markdown
    # tables (mammoth flattens table cells into loose paragraphs).
    from docx import Document
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(path)
    parts = []
    for child in doc.element.body.iterchildren():
        if isinstance(child, CT_P):
            para = Paragraph(child, doc)
            text = para.text.strip()
            if not text:
                continue
            style = (para.style.name or "").lower() if para.style else ""
            if style.startswith("heading"):
                level = "".join(ch for ch in style if ch.isdigit()) or "1"
                parts.append("#" * min(int(level), 6) + " " + text)
            else:
                parts.append(text)
        elif isinstance(child, CT_Tbl):
            table = Table(child, doc)
            rows = [[cell.text for cell in row.cells] for row in table.rows]
            md = _rows_to_markdown(rows)
            if md:
                parts.append(md)
    return "\n\n".join(parts)


def extract_xlsx(path):
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    parts = []
    for sheet in wb.worksheets:
        rows = list(sheet.iter_rows(values_only=True))
        table = _rows_to_markdown(rows)
        if table:
            parts.append(f"## Sheet: {sheet.title}\n\n{table}")
    wb.close()
    return "\n\n".join(parts)


def extract_pptx(path):
    from pptx import Presentation

    prs = Presentation(path)
    parts = []
    for index, slide in enumerate(prs.slides, start=1):
        lines = []
        for shape in slide.shapes:
            if shape.has_table:
                rows = [[cell.text for cell in row.cells] for row in shape.table.rows]
                table = _rows_to_markdown(rows)
                if table:
                    lines.append(table)
            elif shape.has_text_frame:
                text = shape.text_frame.text.strip()
                if text:
                    lines.append(text)
        if lines:
            parts.append(f"## Slide {index}\n\n" + "\n\n".join(lines))
    return "\n\n".join(parts)


_OCR_ENGINE = None


def _get_ocr():
    # Lazy + cached: importing rapidocr pulls onnxruntime/opencv, so digital
    # PDFs and Office files that never hit a scanned page pay nothing.
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR

        _OCR_ENGINE = RapidOCR()
    return _OCR_ENGINE


def _ocr(image):
    # image may be a file path or an HxWx3 numpy array (rendered PDF page).
    result, _ = _get_ocr()(image)
    if not result:
        return ""
    # result rows are [box, text, score]; reading order is left-to-right,
    # top-to-bottom as RapidOCR returns them.
    return "\n".join(line[1] for line in result)


def _ocr_pdf_pages(path, indices):
    # Render only the text-less pages with pypdfium2 (PDFium, Apache) and OCR
    # them. One PdfDocument for the whole batch. scale=2 ≈ 144 dpi — enough for
    # OCR without rendering oversized bitmaps on an ordinary laptop.
    import numpy as np
    import pypdfium2 as pdfium

    out = {}
    pdf = pdfium.PdfDocument(path)
    try:
        for i in indices:
            pil = pdf[i].render(scale=2).to_pil().convert("RGB")
            out[i] = _ocr(np.asarray(pil))
    finally:
        pdf.close()
    return out


def _try_pro_pdf(path):
    # Opt-in upgrade: if the "pro-pdf" pack is installed (Docling importable),
    # use its layout/reading-order/table-structure analysis for complex PDFs.
    # Absent or failing, return None so the light path below handles it — the
    # base install is never burdened with the heavy import. See runtime-packs.js.
    try:
        from docling.document_converter import DocumentConverter
    except Exception:  # noqa: BLE001 — pack not installed; this is the normal base case
        return None
    try:
        result = DocumentConverter().convert(path)
        return result.document.export_to_markdown()
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"pro-pdf (docling) failed, using light path: {exc}\n")
        return None


def extract_pdf(path):
    # Digital PDFs (the 90% case — exports from Word/WPS) read their text layer
    # directly: milliseconds, tens of MB. Pages with no text layer are scans,
    # so they fall through to render+OCR while preserving document page order.
    pro = _try_pro_pdf(path)
    if pro is not None:
        return pro

    import pdfplumber

    page_texts = []
    empty_pages = []
    with pdfplumber.open(path) as pdf:
        for index, page in enumerate(pdf.pages):
            chunks = []
            text = page.extract_text() or ""
            if text.strip():
                chunks.append(text.strip())
            for table in page.extract_tables() or []:
                md = _rows_to_markdown(table)
                if md:
                    chunks.append(md)
            if chunks:
                page_texts.append("\n\n".join(chunks))
            else:
                page_texts.append(None)
                empty_pages.append(index)

    if empty_pages:
        for index, text in _ocr_pdf_pages(path, empty_pages).items():
            if text.strip():
                page_texts[index] = text.strip()

    return "\n\n".join(part for part in page_texts if part)


def extract_image(path):
    # Standalone scan/photo: OCR the file directly (RapidOCR reads the path).
    return _ocr(path)


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"}

OFFICE_EXTRACTORS = {
    ".docx": extract_docx,
    ".xlsx": extract_xlsx,
    ".pptx": extract_pptx,
}


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "USAGE"}))
        return 1
    path = sys.argv[1]
    ext = os.path.splitext(path)[1].lower()

    if ext == ".pdf":
        extractor = extract_pdf
    elif ext in IMAGE_EXTS:
        extractor = extract_image
    elif ext in OFFICE_EXTRACTORS:
        extractor = OFFICE_EXTRACTORS[ext]
    else:
        print(json.dumps({"ok": False, "error": f"UNSUPPORTED:{ext}"}))
        return 1

    try:
        text = (extractor(path) or "").strip()
    except Exception as exc:  # noqa: BLE001 — surface the cause, never crash silently
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps({"ok": True, "text": text}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
