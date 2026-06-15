---
name: runtime-packs
description: "Use this skill to install, check, or remove optional local runtime engines on demand — when the user asks for higher-accuracy parsing of COMPLEX PDFs (multi-column layout, dense tables, scans), mentions Docling / 专业 PDF 引擎 / 高精度版面/表格解析, or needs LibreOffice for local Word/Excel/PPT/PDF conversion on a platform where it is not bundled. Triggers: 装/启用/卸载 专业PDF引擎, '上 Docling', 'install the pro PDF engine', '安装 LibreOffice 运行时', 'Office 转 PDF 不可用'. These engines are large downloads kept out of the base install. Do NOT use pro-pdf for ordinary PDFs — the built-in pdfplumber/RapidOCR path already handles those."
license: Proprietary
intent: >-
  按需安装/卸载本地运行时（如 Docling 专业 PDF 引擎、LibreOffice 运行时）。
  基础安装保持轻量；用户需要更高精度或本机缺少 Office 转换能力时由 agent
  通过自然语言触发安装。下载走服务端下发的七牛地址（国内可达），校验 sha256
  后解压；主进程会自动用上。
type: reference
---

# Runtime packs (on-demand local engines)

The base install is deliberately light (digital PDF + RapidOCR, no torch) so it
runs on ordinary laptops. For genuinely hard documents — complex multi-column
layout, dense/merged tables, high-accuracy structure recovery — a heavier engine
can be installed **on demand**. For platforms where LibreOffice is intentionally
not bundled, the LibreOffice runtime can also be installed on demand for Office
conversion, rendering, and spreadsheet recalculation. There is no settings UI:
you (the agent) install it when the user asks or when the local capability is
missing.

## When to use

Install `pro-pdf` only when the user needs more than the built-in path delivers
— e.g. "这个 PDF 的表格解析得不对,能不能用更强的引擎", "上专业 PDF 引擎",
"install Docling". For everyday PDFs/Office files, do nothing — the base path is
already good and far lighter.

Install `libreoffice` when Office/PDF conversion or spreadsheet recalculation is
unavailable because the current platform package does not include LibreOffice.

## Available packs

| id | what it is | cost |
|----|------------|------|
| `pro-pdf` | Docling engine: layout analysis, reading order, table-structure (TableFormer). Best for complex PDFs/contracts/reports. | ~230 MB download, ~900 MB installed; needs a capable machine |
| `libreoffice` | LibreOffice runtime: local Word/Excel/PPT/PDF conversion and spreadsheet formula recalculation. | ~500 MB download on Windows; installed only when needed |

## Commands

Run with the bundled Python (`python` resolves to it in this environment):

```bash
python scripts/manage_runtime_pack.py list                 # what's available + installed
python scripts/manage_runtime_pack.py status  pro-pdf       # is it installed?
python scripts/manage_runtime_pack.py install pro-pdf       # download (from our CDN) + verify + install
python scripts/manage_runtime_pack.py install libreoffice   # install Office conversion runtime
python scripts/manage_runtime_pack.py uninstall pro-pdf     # remove it
```

Each prints one JSON line. `install` downloads the artifact from the URL our
server returns (a Qiniu CDN object — reachable in China, never PyPI), verifies
its sha256, and extracts it where the app picks it up automatically.

## How to use it well

1. **Tell the user the cost before installing** (~230 MB for `pro-pdf`, ~500 MB
   for Windows `libreoffice`) and confirm, since it's a big download on their
   connection/disk.
2. Run `install <pack-id>`. On `{"ok": true, ...}` tell them it's ready — the next
   matching document task will use it automatically (no restart needed).
3. On `{"ok": false, "error": "NO_ARTIFACT ..."}` their platform has no published
   build yet — say so plainly; don't pretend it installed.
4. If they later want the space back, `uninstall pro-pdf`.

The app reads installed packs straight from disk, so once `install` succeeds the
high-accuracy path is live for subsequent documents.

## Always prefer OUR runtime, not PyPI

When a heavier engine is needed, install it through **this skill** — it fetches
OUR pre-built runtime from OUR CDN (China-reachable, version-pinned by us).
**Do NOT `pip install docling` (or other heavy ML libs) from PyPI** as a
substitute: in the packaged app the bundled venv is read-only and PyPI is
slow/blocked in China, so that path is unreliable. Our runtime pack is the
provided, supported way to get the engine. If no artifact exists for the user's
platform yet, say so — don't fall back to a raw PyPI install.
