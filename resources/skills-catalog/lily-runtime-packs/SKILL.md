---
name: lily-runtime-packs
description: Use when the user needs to check, install, repair, or upgrade local dependency packs. Packs are prebuilt artifacts from Lily's CDN with sha256 verification; do not run live pip/npm installs on the user's machine.
license: Proprietary
type: reference
---

# Dependency Packs

The desktop app bundles only the base Python/Node runtime. Optional libraries and
native tools are dependency packs: prebuilt artifacts resolved from Lily's server,
downloaded from Lily's CDN, sha256-verified, and extracted locally. This skill is
for checking status, installing a missing pack, repairing one, or upgrading with a
user-installed override. It must not run pip/npm directly in normal use.

## Available Dependency Packs

- Document: libreoffice, pro-pdf (Docling), large-document, pandoc.
- Image: pillow, opencv, rapidocr, rembg.
- Browser automation: web-automation (Playwright modules and browser binaries).
- Audio/video: ffmpeg.

## Large File and Media Routing

- large-document: install when a large PDF, Word, Excel, CSV/JSON, or columnar
  file needs streaming extraction, sheet/page/paragraph indexing, DuckDB/Polars
  querying, or PyMuPDF/pikepdf-level PDF inspection.
- pro-pdf: install when layout quality matters for complex PDFs: multi-column
  documents, dense tables, papers, contracts, and reading-order recovery.
- libreoffice: install for Office conversion, rendering, formula recalculation,
  legacy .doc/.xls/.ppt conversion, and visual verification.
- rapidocr/opencv: install for scanned pages, image OCR, image preprocessing,
  or screenshot/table-image cleanup.
- ffmpeg: install for video/audio metadata, frame probing, clipping, conversion,
  thumbnails, and media duration/stream inspection.

## Commands

Use scripts/manage_runtime_pack.py to list, check status, install, or uninstall packs.

## Long Task Supervision

Dependency installs can take minutes and must stay observable without blocking the
chat. For `install` and large `repair`/`upgrade` work, run
`scripts/manage_runtime_pack.py` through the generic `lily_process_jobs`
supervisor, then observe it with `job_status` and `job_logs` until it returns a
concrete result or blocker. The script emits standard `[lily-progress]` events
for resolve, download, verify, extract, and install phases. Do not invent
pack-specific progress protocols; the platform owns progress display.

Short `list`, `status`, and already-installed checks may run directly because
they finish quickly.

## Rules

1. Check status first. If a pack is already installed or packaged with the app, treat it as available and do not download it.
2. Use this skill and Lily-provided artifacts; do not install libraries directly from PyPI/npm in the packaged app.
3. If no artifact exists for the platform, say so plainly.
4. Explain download and disk cost before installing large packs.
5. Once install succeeds, subsequent matching tasks can use the pack without restart.
