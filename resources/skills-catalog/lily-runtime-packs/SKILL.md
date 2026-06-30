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

- Document: libreoffice, pro-pdf (Docling), pandoc.
- Image: pillow, opencv, rapidocr, rembg.
- Browser automation: web-automation (Playwright modules and browser binaries).
- Audio/video: ffmpeg.

## Commands

Use scripts/manage_runtime_pack.py to list, check status, install, or uninstall packs.

## Rules

1. Check status first. If a pack is already installed or packaged with the app, treat it as available and do not download it.
2. Use this skill and Lily-provided artifacts; do not install libraries directly from PyPI/npm in the packaged app.
3. If no artifact exists for the platform, say so plainly.
4. Explain download and disk cost before installing large packs.
5. Once install succeeds, subsequent matching tasks can use the pack without restart.
