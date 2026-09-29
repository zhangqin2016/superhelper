#!/usr/bin/env python3
"""Does an Office package carry markup that a strict Office reader will refuse?

LibreOffice renders almost anything, so a render proves the pages, not that
Word/PowerPoint will open the file. 2026-09-29: a generated report carried 238
DrawingML <a:latin>/<a:ea> elements inside WordprocessingML <w:rPr>; LibreOffice
and the PDF were fine, Word said "experienced an error trying to open the file".

The judge is the OOXML schema — the XSDs and part→schema mapping bundled with
the vendored office validator (anthropics-docx), with its markup-compatibility
preprocessing. What is reported is narrower than "schema-invalid": files Word
itself saves fail those XSDs (transitional attribute values, WPS style element
order), so raw validity would flag good files. Reported: a schema violation on an
element from a DIFFERENT vocabulary than its parent — one markup language's
element inside another's content where the schema does not allow it.

Usage: python ooxml_conformance.py <file>   → JSON on stdout
"""

import json
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path

OOXML_EXTS = {".docx", ".docm", ".dotx", ".pptx", ".pptm", ".potx", ".xlsx", ".xlsm", ".xltx"}
MAX_PART_BYTES = 16 * 1024 * 1024
DEFAULT_BUDGET_SECONDS = 20.0
MAX_REPORTED = 20


def _validator_dir():
    """The vendored office validator, beside this script in the app resources."""
    here = Path(__file__).resolve().parent
    for skill in ("anthropics-docx", "anthropics-pptx", "anthropics-xlsx"):
        candidate = here.parent / "skills-catalog" / skill / "scripts" / "office"
        if (candidate / "validators" / "base.py").exists() and (candidate / "schemas").is_dir():
            return candidate
    return None


def _namespace(tag):
    tag = str(tag)
    return tag[1:].split("}", 1)[0] if tag.startswith("{") else ""


def check_package(path, budget_seconds=DEFAULT_BUDGET_SECONDS):
    """{"checked": bool, "violations": [...], "count": N} — never raises.

    checked:false (with a reason) means "could not judge", never "fine" and never
    "broken": a missing validator or an overrun budget must not fail a delivery."""
    ext = os.path.splitext(str(path))[1].lower()
    if ext not in OOXML_EXTS:
        return {"checked": False, "reason": "not_ooxml"}
    validator_dir = _validator_dir()
    if validator_dir is None:
        return {"checked": False, "reason": "validator_unavailable"}
    try:
        import lxml.etree as etree
        if str(validator_dir) not in sys.path:
            sys.path.insert(0, str(validator_dir))
        from validators.base import BaseSchemaValidator
    except Exception as exc:  # noqa: BLE001
        return {"checked": False, "reason": "validator_import_failed: %s" % type(exc).__name__}

    started = time.monotonic()
    violations, count, partial = [], 0, False
    try:
        with tempfile.TemporaryDirectory(prefix="lily-ooxml-") as tmp:
            with zipfile.ZipFile(path) as package:
                package.extractall(tmp)
            base = Path(tmp).resolve()  # the validator resolves (macOS /var → /private/var)
            validator = BaseSchemaValidator(base)
            schemas = {}
            for part in sorted(validator.xml_files):
                relative = part.relative_to(base)
                if not relative.parts or relative.parts[0] not in validator.MAIN_CONTENT_FOLDERS:
                    continue  # package plumbing (rels, content types, docProps) is not content markup
                schema_path = validator._get_schema_path(part)
                if schema_path is None:
                    continue
                if part.stat().st_size > MAX_PART_BYTES or time.monotonic() - started > budget_seconds:
                    partial = True
                    continue
                if schema_path not in schemas:
                    schemas[schema_path] = etree.XMLSchema(etree.parse(str(schema_path)))
                schema = schemas[schema_path]
                tree = validator._preprocess_for_mc_ignorable(etree.parse(str(part)))
                tree = validator._clean_ignorable_namespaces(tree)
                if schema.validate(tree):
                    continue
                by_path = None
                for error in schema.error_log:
                    if by_path is None:
                        by_path = {tree.getpath(node): node for node in tree.iter() if isinstance(node.tag, str)}
                    node = by_path.get(getattr(error, "path", None) or "")
                    parent = node.getparent() if node is not None else None
                    if parent is None or _namespace(node.tag) == _namespace(parent.tag):
                        continue
                    count += 1
                    if len(violations) < MAX_REPORTED:
                        violations.append({
                            "part": relative.as_posix(),
                            "node": error.path,
                            "message": error.message[:240],
                        })
    except Exception as exc:  # noqa: BLE001 — a package we cannot read is judged elsewhere (structure header checks)
        return {"checked": False, "reason": "check_failed: %s: %s" % (type(exc).__name__, str(exc)[:160])}
    result = {"checked": True, "count": count, "violations": violations}
    if partial:
        result["partial"] = True
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"checked": False, "reason": "USAGE"}))
        sys.exit(2)
    print(json.dumps(check_package(sys.argv[1]), ensure_ascii=False))
