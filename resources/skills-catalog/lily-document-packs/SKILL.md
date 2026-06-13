---
name: document-packs
description: "Use this skill to install, check, or remove optional heavy document engines on demand — when the user asks for higher-accuracy parsing of COMPLEX PDFs (multi-column layout, dense tables, scans) than the light built-in path gives, or mentions Docling / 专业 PDF 引擎 / 高精度版面/表格解析. Triggers: 装/启用/卸载 专业PDF引擎, '上 Docling', 'install the pro PDF engine', 'this PDF's tables come out wrong, can we use a better engine'. These engines are large downloads kept out of the base install. Do NOT use for ordinary PDFs — the built-in pdfplumber/RapidOCR path already handles those."
license: Proprietary
intent: >-
  按需安装/卸载重型文档引擎（如 Docling 专业 PDF 引擎）。基础安装保持轻量，
  重型 ML 引擎不内置；用户要更高精度时由 agent 通过自然语言触发安装。下载走
  服务端下发的七牛地址（国内可达），校验 sha256 后解压；主进程会自动用上。
type: reference
---

# Document capability packs (on-demand heavy engines)

The base install is deliberately light (digital PDF + RapidOCR, no torch) so it
runs on ordinary laptops. For genuinely hard documents — complex multi-column
layout, dense/merged tables, high-accuracy structure recovery — a heavier engine
can be installed **on demand**. There is no settings UI: you (the agent) install
it when the user asks.

## When to use

Install a pack only when the user needs more than the built-in path delivers —
e.g. "这个 PDF 的表格解析得不对,能不能用更强的引擎", "上专业 PDF 引擎",
"install Docling". For everyday PDFs/Office files, do nothing — the base path is
already good and far lighter.

## Available packs

| id | what it is | cost |
|----|------------|------|
| `pro-pdf` | Docling engine: layout analysis, reading order, table-structure (TableFormer). Best for complex PDFs/contracts/reports. | ~230 MB download, ~900 MB installed; needs a capable machine |

## Commands

Run with the bundled Python (`python` resolves to it in this environment):

```bash
python scripts/manage_pack.py list                 # what's available + installed
python scripts/manage_pack.py status  pro-pdf       # is it installed?
python scripts/manage_pack.py install pro-pdf       # download (from our CDN) + verify + install
python scripts/manage_pack.py uninstall pro-pdf     # remove it
```

Each prints one JSON line. `install` downloads the artifact from the URL our
server returns (a Qiniu CDN object — reachable in China, never PyPI), verifies
its sha256, and extracts it where the app picks it up automatically.

## How to use it well

1. **Tell the user the cost before installing** (~230 MB download) and confirm,
   since it's a big download on their connection/disk.
2. Run `install pro-pdf`. On `{"ok": true, ...}` tell them it's ready — the next
   complex PDF they send will use it automatically (no restart needed).
3. On `{"ok": false, "error": "NO_ARTIFACT ..."}` their platform has no published
   build yet — say so plainly; don't pretend it installed.
4. If they later want the space back, `uninstall pro-pdf`.

The app reads installed packs straight from disk, so once `install` succeeds the
high-accuracy path is live for subsequent documents.
