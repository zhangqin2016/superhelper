#!/usr/bin/env python3
"""Render a document to per-page PNG images for visual verification.

The deterministic half of the quality loop: turn a .docx/.xlsx/.pptx/.pdf into
page images so a multimodal model can *look* at the result and catch what text
extraction can't — overflowed cells, broken tables, blank pages, layout that
ran off the margin. Office files are converted to PDF with the bundled
LibreOffice first; PDFs (and the converted PDF) are rasterized with pypdfium2.
SVG and HTML are drawn by a browser (lily_web_render.py): an SVG as one page,
an HTML page cut into screen-height pages.

Usage: python render_document.py <file_path> <out_dir> [scale]
Emits a single JSON object on stdout:
  {"ok": true, "images": ["<out_dir>/page-1.png", ...], "pages": N}
  {"ok": false, "error": "..."}

A successful render also leaves <out_dir>/.lily-render-receipt.json naming the
source file (path, mtime, size) and its page images. The delivery gate reads
it, so a render counts whatever a calling script prints; a later edit of the
source makes the receipt stale by its mtime/size.

An Office package is also checked against the OOXML schema for markup a strict
Office reader refuses (ooxml_conformance.py). LibreOffice renders such files
anyway, so the pages alone never showed it. The result rides in the stdout JSON
and the receipt as "package"; checked:false means it could not be judged.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


OFFICE_EXTS = {".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".odt", ".ods", ".odp"}


def _soffice():
    # The skill/agent runs with the bundled runtime on PATH; LILY_LIBREOFFICE_PROGRAM
    # is set by getRuntimeEnvExtras. Fall back to PATH lookup.
    program = os.environ.get("LILY_LIBREOFFICE_PROGRAM")
    if program:
        names = ("soffice.exe", "soffice", "soffice.bin") if os.name == "nt" else ("soffice", "soffice.bin")
        for name in names:
            candidate = os.path.join(program, name)
            if os.path.exists(candidate):
                return candidate
    if os.name == "nt":
        return shutil.which("soffice.exe") or shutil.which("soffice") or "soffice.exe"
    return shutil.which("soffice") or "soffice"


def _office_env():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from lily_office_convert import _env
    return _env()


def _subprocess_options():
    if os.name != "nt":
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}


def _profile_uri(path):
    return Path(path).resolve().as_uri()


def _office_to_pdf(path, out_dir):
    # One conversion path for the whole platform, and it cannot fail silently:
    # soffice exits 0 with no output when it has no export filter for the target.
    # See lily_office_convert. [gate: office-conversion-no-silent-failure]
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from lily_office_convert import ConversionError, convert
    try:
        return convert(path, out_dir, "pdf")
    except ConversionError as error:
        raise RuntimeError(str(error)) from error


def _render_pdf(pdf, out_dir, scale):
    import pypdfium2 as pdfium

    images = []
    doc = pdfium.PdfDocument(pdf)
    # Draw form fields the way a viewer does. Without the form environment
    # pdfium leaves every filled AcroForm field blank, so a correctly filled
    # form looked empty to the verifier — and a model "fixed" it by drawing the
    # values onto the page and dropping the form (2026-09-29).
    try:
        doc.init_forms()
    except Exception:  # noqa: BLE001 — a document without forms renders as before
        pass
    try:
        for index in range(len(doc)):
            pil = doc[index].render(scale=scale, may_draw_forms=True).to_pil().convert("RGB")
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
    notes = []
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from lily_web_render import WEB_EXTS, render_web
        if ext in WEB_EXTS:
            images, notes = render_web(path, out_dir, scale)
        elif ext in OFFICE_EXTS:
            images = _render_pdf(_office_to_pdf(path, out_dir), out_dir, scale)
        elif ext == ".pdf":
            images = _render_pdf(path, out_dir, scale)
        else:
            print(json.dumps({"ok": False, "error": f"UNSUPPORTED:{ext}"}))
            return 1
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or b"").decode("utf-8", "replace")[:500]
        print(json.dumps({"ok": False, "error": f"LIBREOFFICE_FAILED: {detail}"}))
        return 1
    except Exception as exc:  # noqa: BLE001 — surface the cause, never crash silently
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1

    package = _package_check(path)
    _write_receipt(path, out_dir, images, package)
    result = {"ok": True, "images": images, "pages": len(images)}
    if package is not None:
        result["package"] = package
    if notes:
        result["notes"] = notes  # browser used, console/page errors, truncation
    print(json.dumps(result, ensure_ascii=False))
    return 0


def _package_check(path):
    try:
        from ooxml_conformance import OOXML_EXTS, check_package
    except Exception as exc:  # noqa: BLE001 — the render stands; say why the package was not judged
        return {"checked": False, "reason": "checker_unavailable: %s" % type(exc).__name__}
    if os.path.splitext(path)[1].lower() not in OOXML_EXTS:
        return None
    package = check_package(path)
    if package.get("count"):
        package["note"] = ("Word/PowerPoint/Excel will refuse to open this file although it rendered: "
                           "an element from one markup vocabulary sits where the schema does not allow it "
                           "(see violations). Fix the generating code, regenerate, and render again.")
    return package


RECEIPT_NAME = ".lily-render-receipt.json"


def _write_receipt(source, out_dir, images, package=None):
    try:
        stat = os.stat(source)
        receipt = {
            "version": 1,
            "kind": "document_render",
            "source": os.path.abspath(source),
            "sourceMtimeMs": int(stat.st_mtime * 1000),
            "sourceBytes": stat.st_size,
            "images": [os.path.abspath(image) for image in images],
            "pages": len(images),
            "renderedAtMs": int(time.time() * 1000),
        }
        if package is not None:
            receipt["package"] = package
        target = os.path.join(out_dir, RECEIPT_NAME)
        partial = target + ".partial"
        with open(partial, "w", encoding="utf-8") as handle:
            json.dump(receipt, handle, ensure_ascii=False)
        os.replace(partial, target)
        _record_in_ledger(receipt["source"], target, receipt["renderedAtMs"])
    except Exception as exc:  # noqa: BLE001 — the render itself succeeded; say why the receipt did not
        print(f"render receipt not written: {type(exc).__name__}: {exc}", file=sys.stderr)


def _record_in_ledger(source, receipt_path, at_ms):
    """Tell the host where this render's receipt is (LILY_RENDER_RECEIPTS_DIR).

    The delivery gate used to find a receipt only beside pages it saw inspected;
    a PDF whose pages were byte-identical to its inspected .docx render was
    never looked up, and one loop's output was then read as every file's pages
    (2026-09-30: a 7-page PDF counted as 38 pages, 0 inspected).
    """
    ledger = os.environ.get("LILY_RENDER_RECEIPTS_DIR")
    if not ledger:
        return
    try:
        os.makedirs(ledger, exist_ok=True)
        day = time.strftime("%Y-%m-%d", time.gmtime(at_ms / 1000))
        line = json.dumps({"version": 1, "kind": "document_render", "source": source,
                           "receipt": os.path.abspath(receipt_path), "at": at_ms}, ensure_ascii=False)
        with open(os.path.join(ledger, f"{day}.jsonl"), "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception as exc:  # noqa: BLE001 — the receipt beside the pages still stands
        print(f"render ledger not written: {type(exc).__name__}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
