#!/usr/bin/env python3
"""Fill a .docx template with structured data — deterministic, no model.

A template is an ordinary Word document whose text holds Jinja2 placeholders:
  {{ customer_name }}            simple value
  {%p for item in items %}...{%p endfor %}   repeat a paragraph/row
docxtpl (python-docx + Jinja2) substitutes the data and writes a new .docx.
The substitution itself is a deterministic transform, so it lives in code, not
in the model: the model's only job is to produce the data mapping.

Subcommands (single JSON object on stdout):
  inspect <template.docx>
      → {"ok": true, "variables": ["customer_name", "items", ...]}
        the placeholder names the template declares, so the caller knows what
        data to provide.
  fill <template.docx> <data.json> <output.docx>
      → {"ok": true, "output": "<path>", "missing": [...], "provided": [...]}
        renders <data.json> (a JSON object) into the template. `missing` lists
        declared placeholders absent from the data — surfaced, never hidden, so
        an unfilled blank is visible rather than silently shipped.

Errors: {"ok": false, "error": "..."} and a non-zero exit code.
"""

import json
import os
import sys


def _emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    return code


def _declared_variables(doc):
    # docxtpl surfaces the top-level Jinja2 variables the template references.
    return sorted(doc.get_undeclared_template_variables())


def inspect(template):
    from docxtpl import DocxTemplate

    doc = DocxTemplate(template)
    return _emit({"ok": True, "variables": _declared_variables(doc)})


def fill(template, data_path, output):
    from docxtpl import DocxTemplate

    with open(data_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        return _emit({"ok": False, "error": "DATA_NOT_OBJECT"}, 1)

    doc = DocxTemplate(template)
    declared = set(_declared_variables(doc))
    provided = set(data.keys())
    missing = sorted(declared - provided)

    doc.render(data)
    doc.save(output)
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
