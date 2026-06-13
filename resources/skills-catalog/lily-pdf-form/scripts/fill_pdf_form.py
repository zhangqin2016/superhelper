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
    # NeedAppearances tells the viewer to regenerate field appearances with its
    # own fonts — important for CJK, which the built-in Helvetica can't render.
    try:
        writer.set_need_appearances_writer(True)
    except Exception:  # noqa: BLE001 — older/newer pypdf may differ; values still write
        pass
    for page in writer.pages:
        writer.update_page_form_field_values(page, data, auto_regenerate=False)

    with open(output, "wb") as handle:
        writer.write(handle)
    return _emit(
        {
            "ok": True,
            "output": output,
            "missing": missing,
            "provided": sorted(provided),
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
