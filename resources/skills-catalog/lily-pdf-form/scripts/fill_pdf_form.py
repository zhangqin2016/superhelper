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
  fill <form.pdf> <data.json> <output.pdf>
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


def fill(form, data_path, output):
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
    return _emit(
        {
            "ok": True,
            "output": output,
            "missing": missing,
            "provided": sorted(provided),
            # Signals a CJK value was written: NeedAppearances is set so the
            # viewer re-renders with a CJK font. Occlusion/tofu must still be
            # verified by rendering the output — treat as a delivery gate.
            "cjk": has_cjk,
        }
    )


def main(argv):
    if len(argv) < 2:
        return _emit({"ok": False, "error": "USAGE"}, 1)
    cmd = argv[1]
    try:
        if cmd == "inspect" and len(argv) == 3:
            return inspect(argv[2])
        if cmd == "fill" and len(argv) == 5:
            return fill(argv[2], argv[3], argv[4])
        return _emit({"ok": False, "error": "USAGE"}, 1)
    except FileNotFoundError as exc:
        return _emit({"ok": False, "error": f"NOT_FOUND: {exc.filename or exc}"}, 1)
    except json.JSONDecodeError as exc:
        return _emit({"ok": False, "error": f"BAD_JSON: {exc}"}, 1)
    except Exception as exc:  # noqa: BLE001 — surface the cause, never crash silently
        return _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
