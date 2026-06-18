---
name: lily-runtime-packs
description: Use when the user needs optional local engines or runtimes that are not bundled by default, such as pro PDF parsing or LibreOffice runtime. Installs, checks, or removes runtime packs from Lily's CDN with sha256 verification.
license: Proprietary
type: reference
---

# Runtime Packs

The base install stays light for ordinary laptops. Heavy engines are installed on demand when the user needs them.

## Available Packs

- pro-pdf: high-accuracy PDF layout, reading order, and table structure. Large download and install size.
- libreoffice: Office conversion, rendering, and spreadsheet recalculation when not bundled. Large download, especially on Windows.

## Commands

Use scripts/manage_runtime_pack.py to list, check status, install, or uninstall packs.

## Rules

1. Explain download and disk cost before installing large packs.
2. Use this skill and Lily-provided artifacts; do not install heavy ML libraries directly from PyPI in the packaged app.
3. If no artifact exists for the platform, say so plainly.
4. Once install succeeds, subsequent matching tasks can use the pack without restart.
