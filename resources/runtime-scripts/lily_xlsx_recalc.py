"""Recalculate an XLSX into a separate verified copy, without user-profile macros."""
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from openpyxl import load_workbook
from lily_office_convert import convert


def recalculate(source, out_dir, timeout=60):
    source = Path(source).resolve()
    if source.suffix.lower() != ".xlsx":
        raise ValueError("Only .xlsx is supported; preserve other workbook formats unchanged")
    if source.parent == Path(out_dir).resolve():
        raise ValueError("Use a separate output directory; the original must remain unchanged")
    original = load_workbook(source, data_only=False)
    try:
        formulas = {(sheet.title, cell.coordinate) for sheet in original
                    for row in sheet for cell in row if cell.data_type == "f"}
    finally:
        original.close()
    output = convert(str(source), str(out_dir), "xlsx:Calc MS Excel 2007 XML", timeout=timeout)
    values = load_workbook(output, data_only=True)
    expressions = load_workbook(output, data_only=False)
    errors = []
    try:
        for sheet, address in sorted(formulas):
            if sheet not in expressions or expressions[sheet][address].data_type != "f":
                errors.append(f"{sheet}!{address}: formula lost")
            elif values[sheet][address].value is None:
                errors.append(f"{sheet}!{address}: cache missing (empty result is not verified)")
        for sheet in values:
            for row in sheet:
                for cell in row:
                    if cell.data_type == "e":
                        errors.append(f"{sheet.title}!{cell.coordinate}: {cell.value}")
    finally:
        values.close()
        expressions.close()
    if errors:
        raise ValueError("Recalculation not verified: " + "; ".join(errors[:30]))
    _record_in_ledger(output, len(formulas))
    return {"status": "verified", "output": str(output), "formula_count": len(formulas),
            "scope": "formula presence, cached values and Excel errors; layout/features need separate review"}


def _record_in_ledger(output, formula_count):
    """Tell the host which workbook bytes were verified (LILY_RECALC_RECEIPTS_DIR).

    Keyed by content: the verified copy is usually moved over the original, and
    the delivery gate recognises it by digest wherever it ends up. It used to
    look for "recalc.py" in the command text instead (2026-09-30).
    """
    ledger = os.environ.get("LILY_RECALC_RECEIPTS_DIR")
    if not ledger:
        return
    try:
        digest = hashlib.sha256(Path(output).read_bytes()).hexdigest()
        at_ms = int(time.time() * 1000)
        os.makedirs(ledger, exist_ok=True)
        day = time.strftime("%Y-%m-%d", time.gmtime(at_ms / 1000))
        line = json.dumps({"version": 1, "kind": "workbook_recalc", "output": str(Path(output).resolve()),
                           "sha256": digest, "formulas": formula_count, "at": at_ms}, ensure_ascii=False)
        with open(os.path.join(ledger, f"{day}.jsonl"), "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception as exc:  # noqa: BLE001 — the verified copy still stands
        print(f"recalc ledger not written: {type(exc).__name__}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    if not 0 < args.timeout <= 600:
        parser.error("timeout must be between 0 and 600 seconds")
    try:
        result = recalculate(args.source, args.out_dir, args.timeout)
    except Exception as error:
        print(json.dumps({"status": "unverified", "error": str(error)}))
        sys.exit(1)
    print(json.dumps(result))
