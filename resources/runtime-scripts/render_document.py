#!/usr/bin/env python3
"""Render a document to per-page PNG images for visual verification.

The deterministic half of the quality loop: turn a .docx/.xlsx/.pptx/.pdf into
page images so a multimodal model can *look* at the result and catch what text
extraction can't — overflowed cells, broken tables, blank pages, layout that
ran off the margin. Office files are converted to PDF with the bundled
LibreOffice first; PDFs (and the converted PDF) are rasterized with pypdfium2.

Usage: python render_document.py <file_path> <out_dir> [scale]
Emits a single JSON object on stdout:
  {"ok": true, "images": ["<out_dir>/page-1.png", ...], "pages": N}
  {"ok": false, "error": "..."}
"""

import json
import os
import subprocess
import sys
from pathlib import Path


OFFICE_EXTS = {".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".odt", ".ods", ".odp"}


def _soffice():
    # The skill/agent runs with the bundled runtime on PATH; LILY_LIBREOFFICE_PROGRAM
    # is set by getRuntimeEnvExtras. Fall back to PATH lookup.
    program = os.environ.get("LILY_LIBREOFFICE_PROGRAM")
    if program:
        for name in ("soffice", "soffice.bin", "soffice.exe"):
            candidate = os.path.join(program, name)
            if os.path.exists(candidate):
                return candidate
    return "soffice"


def _profile_uri(path):
    return Path(path).resolve().as_uri()


def _office_to_pdf(path, out_dir):
    soffice = _soffice()
    # --convert-to writes <basename>.pdf into out_dir. headless + a throwaway
    # user profile so it never collides with a real LibreOffice session.
    profile = os.path.join(out_dir, ".lo-profile")
    subprocess.run(
        [
            soffice,
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            out_dir,
            f"-env:UserInstallation={_profile_uri(profile)}",
            path,
        ],
        check=True,
        capture_output=True,
        timeout=180,
    )
    base = os.path.splitext(os.path.basename(path))[0]
    pdf = os.path.join(out_dir, base + ".pdf")
    if not os.path.exists(pdf):
        raise RuntimeError("LibreOffice produced no PDF")
    return pdf


def _render_pdf(pdf, out_dir, scale):
    import pypdfium2 as pdfium

    images = []
    doc = pdfium.PdfDocument(pdf)
    try:
        for index in range(len(doc)):
            pil = doc[index].render(scale=scale).to_pil().convert("RGB")
            dest = os.path.join(out_dir, f"page-{index + 1}.png")
            pil.save(dest)
            images.append(dest)
    finally:
        doc.close()
    return images


def main(argv):
    if len(argv) < 3:
        print(json.dumps({"ok": False, "error": "USAGE"}))
        return 1
    path = argv[1]
    out_dir = argv[2]
    scale = float(argv[3]) if len(argv) > 3 else 2.0
    ext = os.path.splitext(path)[1].lower()

    os.makedirs(out_dir, exist_ok=True)
    try:
        if ext in OFFICE_EXTS:
            pdf = _office_to_pdf(path, out_dir)
        elif ext == ".pdf":
            pdf = path
        else:
            print(json.dumps({"ok": False, "error": f"UNSUPPORTED:{ext}"}))
            return 1
        images = _render_pdf(pdf, out_dir, scale)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or b"").decode("utf-8", "replace")[:500]
        print(json.dumps({"ok": False, "error": f"LIBREOFFICE_FAILED: {detail}"}))
        return 1
    except Exception as exc:  # noqa: BLE001 — surface the cause, never crash silently
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1

    print(json.dumps({"ok": True, "images": images, "pages": len(images)}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
