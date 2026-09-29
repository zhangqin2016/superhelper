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
import re
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
            doc.init_forms()  # without it pdfium draws no form field at all
            page = doc[page_index]
            height = page.get_height()
            bitmap = page.render(scale=scale, may_draw_forms=True).to_pil().convert("L")
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


def _inherited(annot, key):
    """A widget's attribute, or its field parent's (DA, Q and Ff are inheritable)."""
    node = annot
    for _ in range(8):
        if node is None:
            return None
        value = node.get(key)
        if value is not None:
            return value
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
    return None


def _field_name(annot):
    name = annot.get("/T")
    parent = annot.get("/Parent")
    if name is None and parent is not None:
        name = parent.get_object().get("/T")
    return None if name is None else str(name)


def _da_style(da):
    """(font size, rgb) from a /DA string; size 0 means auto-fit."""
    text = str(da or "")
    size = re.search(r"([\d.]+)\s+Tf", text)
    rgb = re.search(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg", text)
    gray = re.search(r"(?:^|\s)([\d.]+)\s+g(?:\s|$)", text)
    color = tuple(float(v) for v in rgb.groups()) if rgb else ((float(gray.group(1)),) * 3 if gray else (0.0, 0.0, 0.0))
    return (float(size.group(1)) if size else 0.0), color


def _wrap(text, font, size, width, measure):
    lines = []
    for paragraph in str(text).split("\n"):
        line = ""
        for ch in paragraph:
            if line and measure(line + ch, font, size) > width:
                lines.append(line)
                line = ch
            else:
                line += ch
        lines.append(line)
    return lines


def _text_xobject(writer, font, value, width, height, size, color, align, multiline):
    """The value drawn with the embedded CJK font, as a Form XObject in `writer`."""
    from io import BytesIO

    from pypdf import PdfReader
    from pypdf.generic import ArrayObject, DecodedStreamObject, FloatObject, NameObject
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from reportlab.pdfgen import canvas as rl_canvas

    pad = 4.0  # pypdf's own text inset, so CJK and ASCII fields line up
    avail = max(1.0, width - 2 * pad)
    if size <= 0:
        size = max(4.0, min(12.0, height * 0.7))
        while size > 4.0 and not multiline and stringWidth(str(value), font, size) > avail:
            size -= 0.5
    buffer = BytesIO()
    canvas = rl_canvas.Canvas(buffer, pagesize=(width, height))
    canvas.setFillColorRGB(*color)
    canvas.setFont(font, size)
    lines = _wrap(value, font, size, avail, stringWidth) if multiline else [str(value).replace("\n", " ")]
    y = height - 2 - size if multiline else (height - size) / 2 + size * 0.141  # pypdf's single-line baseline
    for line in lines:
        line_width = stringWidth(line, font, size)
        x = pad if align == 0 else (width - line_width) / 2 if align == 1 else width - pad - line_width
        canvas.drawString(x, y, line)
        y -= size * 1.15
    canvas.showPage()
    canvas.save()
    buffer.seek(0)
    page = PdfReader(buffer).pages[0]
    xobject = DecodedStreamObject()
    xobject.set_data(page.get_contents().get_data())
    xobject[NameObject("/Type")] = NameObject("/XObject")
    xobject[NameObject("/Subtype")] = NameObject("/Form")
    xobject[NameObject("/BBox")] = ArrayObject([FloatObject(0), FloatObject(0), FloatObject(width), FloatObject(height)])
    xobject[NameObject("/Resources")] = page["/Resources"].clone(writer)
    return writer._add_object(xobject)  # noqa: SLF001 — pypdf has no public add-object helper


def _embed_cjk_appearances(writer, data):
    """Give every CJK-valued field an appearance drawn with an embedded CJK font.

    pypdf builds each field's appearance with the form's own font (Helvetica,
    WinAnsi), which cannot encode CJK: the stream holds literal "?" — what our
    preview, Chrome, WeChat and printers draw — while viewers that regenerate
    appearances (macOS Preview) looked fine (2026-09-29 field case). The value
    in /V was always right. This is what Acrobat and pdf-lib do: the field's own
    background and border are kept, the text part is replaced by the value set
    in a subset-embedded CJK font. Returns (fields written, fields left as-is).
    """
    import re as _re

    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    wanted = {str(k): str(v) for k, v in data.items() if v is not None and _has_cjk(v)}
    if not wanted:
        return 0, []
    font_path = _resolve_cjk_font()
    if not font_path:
        return 0, sorted(wanted)
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont

        pdfmetrics.registerFont(TTFont("LilyFormCJK", font_path, subfontIndex=0))
    except Exception:  # noqa: BLE001 — an unusable font leaves the old appearance
        return 0, sorted(wanted)
    acro = writer._root_object.get("/AcroForm")  # noqa: SLF001
    acro = acro.get_object() if acro is not None else {}
    # Text extraction reads the ToUnicode map, so a character the font has no
    # glyph for still "reads back" right while drawing as a box. A field whose
    # value the font cannot fully draw is left to the viewer instead.
    glyphs = getattr(pdfmetrics.getFont("LilyFormCJK").face, "charToGlyph", None) or {}
    drawable = {name for name, value in wanted.items() if all(ord(ch) in glyphs or ord(ch) < 32 for ch in value)}
    written, left = 0, sorted(set(wanted) - drawable)
    for page in writer.pages:
        for ref in page.get("/Annots", []) or []:
            annot = ref.get_object()
            name = _field_name(annot)
            if annot.get("/Subtype") != "/Widget" or name not in drawable:
                continue
            try:
                x0, y0, x1, y1 = [float(v) for v in annot["/Rect"]]
                width, height = abs(x1 - x0), abs(y1 - y0)
                size, color = _da_style(_inherited(annot, "/DA") or acro.get("/DA"))
                align = int(_inherited(annot, "/Q") or acro.get("/Q") or 0)
                multiline = bool(int(_inherited(annot, "/Ff") or 0) & 4096)
                text_ref = _text_xobject(writer, "LilyFormCJK", wanted[name], width, height, size, color, align, multiline)
                old = annot.get("/AP", {}).get("/N") if annot.get("/AP") is not None else None
                old = old.get_object() if old is not None else None
                frame = _re.sub(rb"/Tx BMC.*?EMC", b"", old.get_data(), flags=_re.S) if old is not None and hasattr(old, "get_data") else b""
                stream = DecodedStreamObject()
                stream.set_data(frame + b"\n/Tx BMC\nq\n1 1 %.2f %.2f re W n\n/LilyFormText Do\nQ\nEMC\n" % (max(0.0, width - 2), max(0.0, height - 2)))
                for key in ("/BBox", "/Matrix"):
                    if old is not None and old.get(key) is not None:
                        stream[NameObject(key)] = old[key]
                stream[NameObject("/Type")] = NameObject("/XObject")
                stream[NameObject("/Subtype")] = NameObject("/Form")
                if stream.get("/BBox") is None:
                    from pypdf.generic import ArrayObject, FloatObject
                    stream[NameObject("/BBox")] = ArrayObject([FloatObject(0), FloatObject(0), FloatObject(width), FloatObject(height)])
                resources = DictionaryObject()
                if old is not None and old.get("/Resources") is not None:
                    resources.update(old["/Resources"].get_object())
                xobjects = DictionaryObject(resources.get("/XObject", DictionaryObject()).get_object() if resources.get("/XObject") is not None else {})
                xobjects[NameObject("/LilyFormText")] = text_ref
                resources[NameObject("/XObject")] = xobjects
                stream[NameObject("/Resources")] = resources
                annot[NameObject("/AP")] = DictionaryObject({NameObject("/N"): writer._add_object(stream)})  # noqa: SLF001
                written += 1
            except Exception:  # noqa: BLE001 — one odd widget keeps its old appearance
                left.append(name)
    return written, sorted(set(left) | (set(wanted) - _names_seen(writer, wanted)))


def _names_seen(writer, wanted):
    seen = set()
    for page in writer.pages:
        for ref in page.get("/Annots", []) or []:
            name = _field_name(ref.get_object())
            if name in wanted:
                seen.add(name)
    return seen


def _verify_text_render(output, data):
    """What a reader draws in each CJK field, read back as TEXT.

    Counting dark pixels passed "??????" as rendered (a question mark is ink).
    pdfium flattens every field's appearance onto its page exactly as a viewer
    would draw it; the text inside each field box must then be the value.
    Returns None when pdfium is unavailable.
    """
    cjk = {str(k): str(v) for k, v in data.items() if v is not None and _has_cjk(v)}
    if not cjk:
        return None
    try:
        import pypdfium2 as pdfium
        import pypdfium2.raw as pdfium_c
    except Exception:  # noqa: BLE001 — verification is an enhancement, never a gate
        return None
    try:
        rects = _cjk_field_rects(output, set(cjk))
        doc = pdfium.PdfDocument(output)
        try:
            mismatched = []
            for page_index in sorted({item[0] for item in rects}):
                page = doc[page_index]
                pdfium_c.FPDFPage_Flatten(page.raw, pdfium_c.FLAT_NORMALDISPLAY)
                page.close()
                text = doc[page_index].get_textpage()
                for index, rect, name in [item for item in rects if item[0] == page_index]:
                    x0, y0, x1, y1 = rect
                    seen = text.get_text_bounded(left=min(x0, x1), bottom=min(y0, y1), right=max(x0, x1), top=max(y0, y1))
                    if "".join(seen.split()) != "".join(cjk[name].split()):
                        mismatched.append({"page": index + 1, "rect": rect, "field": name, "value": cjk[name], "rendered": seen.strip()[:120]})
            return {"checked": len(rects), "verified": not mismatched, "method": "flattened-text", "blankFields": mismatched}
        finally:
            doc.close()
    except Exception:  # noqa: BLE001 — a failed probe falls back to the pixel check
        return None


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
    embedded, left_to_viewer = _embed_cjk_appearances(writer, data) if has_cjk else (0, [])
    # With every CJK field given a correct embedded-font appearance, the
    # appearances are authoritative and every viewer draws the same thing.
    # Anything left (no usable CJK font) keeps the old hint for the viewer.
    need_appearances = bool(left_to_viewer) or not has_cjk
    try:
        writer.set_need_appearances_writer(need_appearances)
    except Exception:  # noqa: BLE001 — older/newer pypdf may differ; values still write
        pass
    if need_appearances:
        try:
            _force_need_appearances(writer)
        except Exception:  # noqa: BLE001 — fail-open; the flag is a hint, not the fill
            pass

    with open(output, "wb") as handle:
        writer.write(handle)

    render_report = (_verify_text_render(output, data) or _verify_cjk_render(output, data)) if has_cjk else None
    if render_report is not None:
        render_report["embeddedAppearances"] = embedded
        if left_to_viewer:
            render_report["leftToViewer"] = left_to_viewer
    if flatten_cjk and render_report and render_report.get("blankFields"):
        drawn = _flatten_values(output, data, render_report["blankFields"])
        if drawn:
            render_report = _verify_text_render(output, data) or _verify_cjk_render(output, data) or render_report
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
