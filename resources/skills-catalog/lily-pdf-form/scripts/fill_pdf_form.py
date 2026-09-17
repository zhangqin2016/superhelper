#!/usr/bin/env python3
"""Fill a fillable PDF form (AcroForm) with structured data — deterministic.

For real fillable PDFs — government / bank / application forms that carry named
text fields. pypdf writes the values into the existing fields and produces a new
PDF. The substitution is a deterministic transform (field name → value), so it
lives in code; the model's only job is to produce the data mapping.

This is NOT for laying out a brand-new PDF. For a designed/templated PDF (a
contract, certificate, invoice), fill a Word template with the template-fill
skill and convert it to PDF with LibreOffice (the document-verify renderer
already does docx → pdf) — far more faithful than drawing a PDF by hand.

Subcommands (single JSON object on stdout):
  inspect <form.pdf>
      → {"ok": true, "fields": ["full_name", "city", ...]}
  fill <form.pdf> <data.json> <output.pdf> [--flatten-cjk]
      → {"ok": true, "output": "<path>", "missing": [...], "provided": [...]}
        `missing` lists form fields absent from the data — surfaced, never
        hidden, so an empty field is visible rather than silently shipped.

Errors: {"ok": false, "error": "..."} and a non-zero exit code.
"""

import json
import os
import sys


def _emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    return code


def _field_names(reader):
    return sorted((reader.get_fields() or {}).keys())


def inspect(form):
    from pypdf import PdfReader

    return _emit({"ok": True, "fields": _field_names(PdfReader(form))})


def _has_cjk(text):
    # CJK Unified Ideographs (+ Ext-A), Hiragana/Katakana, Hangul, and the
    # common CJK punctuation/fullwidth ranges — enough to catch Chinese/Japanese/
    # Korean values whose glyphs the stock form font can't render.
    for ch in str(text):
        cp = ord(ch)
        if (
            0x3400 <= cp <= 0x9FFF      # CJK ideographs + Ext-A
            or 0xF900 <= cp <= 0xFAFF   # CJK compatibility ideographs
            or 0x3040 <= cp <= 0x30FF   # Hiragana + Katakana
            or 0xAC00 <= cp <= 0xD7A3   # Hangul syllables
            or 0x3000 <= cp <= 0x303F   # CJK symbols and punctuation
            or 0xFF00 <= cp <= 0xFFEF   # fullwidth/halfwidth forms
        ):
            return True
    return False


def _values_have_cjk(data):
    try:
        return any(_has_cjk(v) for v in data.values() if v is not None)
    except Exception:  # noqa: BLE001 — detection is advisory only
        return False


def _force_need_appearances(writer):
    # Set /NeedAppearances directly on the document's AcroForm dictionary as a
    # fallback in case the version-specific writer helper is a no-op. Creates
    # the AcroForm entry only if missing; never removes existing form settings.
    from pypdf.generic import BooleanObject, NameObject

    root = writer._root_object  # noqa: SLF001 — no stable public accessor
    acro = root.get("/AcroForm")
    if acro is None:
        return
    acro = acro.get_object()
    acro[NameObject("/NeedAppearances")] = BooleanObject(True)



def _cjk_field_rects(output, cjk_names):
    """[(page_index, rect)] for every widget whose value we wrote with CJK text."""
    from pypdf import PdfReader

    found = []
    reader = PdfReader(output)
    for page_index, page in enumerate(reader.pages):
        for ref in page.get("/Annots", []) or []:
            try:
                annot = ref.get_object()
            except Exception:  # noqa: BLE001 — a broken annot must not fail the fill
                continue
            name = annot.get("/T")
            # A widget may inherit its name from the field parent.
            parent = annot.get("/Parent")
            if name is None and parent is not None:
                try:
                    name = parent.get_object().get("/T")
                except Exception:  # noqa: BLE001
                    name = None
            if name is None or str(name) not in cjk_names:
                continue
            rect = annot.get("/Rect")
            if rect is None or len(rect) != 4:
                continue
            found.append((page_index, [float(v) for v in rect], str(name)))
    return found


def _rect_has_ink(output, page_index, rect, scale=2.0):
    """True when the field's box actually contains drawn pixels.

    /NeedAppearances asks the VIEWER to regenerate a field's appearance with a
    font that can draw the value. A renderer that ignores the flag draws nothing,
    or tofu — which is invisible to a check that only reads /V back. Rasterising
    the box is the only way to know what a reader will see.
    Acceptance 2026-09-17 DEF-02. Returns None when rasterising is unavailable.
    """
    try:
        import pypdfium2 as pdfium
    except Exception:  # noqa: BLE001 — verification is an enhancement, never a gate
        return None
    try:
        doc = pdfium.PdfDocument(output)
        try:
            page = doc[page_index]
            height = page.get_height()
            bitmap = page.render(scale=scale).to_pil().convert("L")
            x0, y0, x1, y1 = rect
            box = (
                max(0, int(min(x0, x1) * scale)),
                max(0, int((height - max(y0, y1)) * scale)),
                min(bitmap.width, int(max(x0, x1) * scale)),
                min(bitmap.height, int((height - min(y0, y1)) * scale)),
            )
            if box[2] - box[0] < 1 or box[3] - box[1] < 1:
                return None
            crop = bitmap.crop(box)
            dark = sum(count for value, count in zip(range(256), crop.histogram()) if value < 200)
            return dark > 0
        finally:
            doc.close()
    except Exception:  # noqa: BLE001 — a failed probe reports "unknown", never False
        return None


def _verify_cjk_render(output, data):
    """Did the CJK values actually come out visible? {"checked": n, "blank": [...]}"""
    cjk_names = {str(k) for k, v in data.items() if v is not None and _has_cjk(v)}
    if not cjk_names:
        return None
    try:
        rects = _cjk_field_rects(output, cjk_names)
    except Exception:  # noqa: BLE001
        return None
    checked = 0
    blank = []
    for page_index, rect, name in rects:
        ink = _rect_has_ink(output, page_index, rect)
        if ink is None:
            continue
        checked += 1
        if not ink:
            blank.append({"page": page_index + 1, "rect": rect, "field": name, "value": str(data.get(name, ""))})
    if not checked:
        return {"checked": 0, "verified": False, "reason": "RASTERIZER_UNAVAILABLE"}
    return {
        "checked": checked,
        "verified": not blank,
        "blankFields": blank,
        **({"warning": (
            "A CJK value was written but its field renders blank. The reader is not "
            "honouring /NeedAppearances. Flatten the values onto the page (the "
            "annotation filler) or deliver a Word template converted to PDF instead."
        )} if blank else {}),
    }


def _resolve_cjk_font():
    """The platform's verified CJK font, or None. Never raises.

    lily_office_style checks that the font's glyph outlines are ones ReportLab can
    actually embed, which an exists()-only chain does not."""
    import importlib.util

    # The host exports where its own helpers live; walking up from a skill
    # directory is a guess that can land on a different build.
    scripts_dir = os.environ.get("LILY_RUNTIME_SCRIPTS") or os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "runtime-scripts")
    )
    helper = os.path.join(scripts_dir, "lily_office_style.py")
    try:
        if os.path.exists(helper):
            spec = importlib.util.spec_from_file_location("lily_office_style", helper)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            path, _outline = module.resolve_cjk_font()
            if path:
                return path
    except Exception:  # noqa: BLE001 — fall through to the env hint
        pass
    env = os.environ.get("LILY_CJK_FONT_PATH")
    return env if env and os.path.exists(env) else None


def _flatten_values(output, data, blank_fields_by_name):
    """Draw CJK values onto the page itself, for readers that ignore /NeedAppearances.

    The field keeps its value in /V — this ADDS the visible text a compliant
    viewer would have drawn. Opt-in, because a viewer that does honour the flag
    would then draw the value twice. Returns the number of values drawn, or 0.
    """
    if not blank_fields_by_name:
        return 0
    font_path = _resolve_cjk_font()
    if not font_path:
        return 0
    try:
        from io import BytesIO

        from pypdf import PdfReader, PdfWriter
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.pdfgen import canvas as rl_canvas
    except Exception:  # noqa: BLE001
        return 0

    try:
        pdfmetrics.registerFont(TTFont("LilyFormCJK", font_path, subfontIndex=0))
    except Exception:  # noqa: BLE001 — an unusable font must not break the fill
        return 0

    reader = PdfReader(output)
    writer = PdfWriter(clone_from=output)
    drawn = 0
    for page_index, page in enumerate(reader.pages):
        entries = [item for item in blank_fields_by_name if item["page"] == page_index + 1]
        if not entries:
            continue
        box = page.mediabox
        width, height = float(box.width), float(box.height)
        buffer = BytesIO()
        overlay = rl_canvas.Canvas(buffer, pagesize=(width, height))
        for entry in entries:
            x0, y0, x1, y1 = entry["rect"]
            size = max(6.0, min(14.0, (max(y0, y1) - min(y0, y1)) * 0.62))
            overlay.setFont("LilyFormCJK", size)
            overlay.drawString(min(x0, x1) + 2, min(y0, y1) + (abs(y1 - y0) - size) / 2 + 1, str(entry["value"]))
            drawn += 1
        overlay.showPage()
        overlay.save()
        buffer.seek(0)
        writer.pages[page_index].merge_page(PdfReader(buffer).pages[0])
    if not drawn:
        return 0
    with open(output, "wb") as handle:
        writer.write(handle)
    return drawn


def fill(form, data_path, output, flatten_cjk=False):
    from pypdf import PdfReader, PdfWriter

    with open(data_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        return _emit({"ok": False, "error": "DATA_NOT_OBJECT"}, 1)

    declared = set(_field_names(PdfReader(form)))
    provided = set(data.keys())
    missing = sorted(declared - provided)

    writer = PdfWriter(clone_from=form)
    has_cjk = _values_have_cjk(data)

    for page in writer.pages:
        # auto_regenerate=False leaves NeedAppearances to the viewer rather than
        # baking a (possibly tofu) appearance stream with the form's own font.
        # NOTE: this call resets /NeedAppearances to False, so the flag below
        # MUST be set AFTER the fill loop, or the viewer won't re-render CJK.
        writer.update_page_form_field_values(page, data, auto_regenerate=False)

    # NeedAppearances tells the viewer to regenerate field appearances with its
    # own (CJK-capable) fonts. The stock Helvetica in a form's default
    # appearance can't draw CJK, so without this a Chinese value renders as
    # tofu/boxes or invisibly. Set it AFTER filling (the fill resets it) and
    # via two paths for cross-version safety — each guarded so values still
    # ship if either path is unavailable. Harmless for ASCII-only fills.
    try:
        writer.set_need_appearances_writer(True)
    except Exception:  # noqa: BLE001 — older/newer pypdf may differ; values still write
        pass
    try:
        _force_need_appearances(writer)
    except Exception:  # noqa: BLE001 — fail-open; the flag is a hint, not the fill
        pass

    with open(output, "wb") as handle:
        writer.write(handle)

    render_report = _verify_cjk_render(output, data) if has_cjk else None
    if flatten_cjk and render_report and render_report.get("blankFields"):
        drawn = _flatten_values(output, data, render_report["blankFields"])
        if drawn:
            render_report = _verify_cjk_render(output, data) or render_report
            render_report["flattened"] = drawn
    return _emit(
        {
            "ok": True,
            "output": output,
            "missing": missing,
            "provided": sorted(provided),
            # Signals a CJK value was written: NeedAppearances is set so the
            # viewer re-renders with a CJK font. That is a HINT to the reader,
            # not a guarantee, so the output is rasterised and the field boxes
            # are checked for actual ink rather than trusting the flag.
            "cjk": has_cjk,
            **({"cjkRender": render_report} if has_cjk else {}),
        }
    )


def main(argv):
    if len(argv) < 2:
        return _emit({"ok": False, "error": "USAGE"}, 1)
    cmd = argv[1]
    try:
        if cmd == "inspect" and len(argv) == 3:
            return inspect(argv[2])
        if cmd == "fill" and len(argv) >= 5:
            # --flatten-cjk also DRAWS a CJK value onto the page when the field
            # itself renders blank, for readers that ignore /NeedAppearances.
            return fill(argv[2], argv[3], argv[4], flatten_cjk="--flatten-cjk" in argv[5:])
        return _emit({"ok": False, "error": "USAGE"}, 1)
    except FileNotFoundError as exc:
        return _emit({"ok": False, "error": f"NOT_FOUND: {exc.filename or exc}"}, 1)
    except json.JSONDecodeError as exc:
        return _emit({"ok": False, "error": f"BAD_JSON: {exc}"}, 1)
    except Exception as exc:  # noqa: BLE001 — surface the cause, never crash silently
        return _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
