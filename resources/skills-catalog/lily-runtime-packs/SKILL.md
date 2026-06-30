---
name: lily-runtime-packs
description: Use when the user needs to check, repair, or upgrade local engines/runtimes. Release builds may already bundle common packs; missing packs can be installed from Lily's CDN with sha256 verification.
license: Proprietary
type: reference
---

# Runtime Packs

Release builds should be directly usable: common platform runtimes can be bundled
read-only under the app resources. This skill is for checking status, repairing a
missing pack, or upgrading with a user-installed override. It must not reinstall a
pack that is already reported as bundled.

## Available Packs

- pro-pdf: high-accuracy PDF layout, reading order, and table structure. Large download and install size.
- libreoffice: Office conversion, rendering, and spreadsheet recalculation. Usually bundled in full release builds; large download when repaired separately.
- web-automation: Playwright modules and browser binaries for web learning, authenticated QA, and controlled browser automation.
- ffmpeg: Local audio/video probing, conversion, clipping, and packaging tools.
- pandoc: Advanced document format conversion for Markdown, HTML, LaTeX, EPUB, and related workflows.

## Commands

Use scripts/manage_runtime_pack.py to list, check status, install, or uninstall packs.

## Rules

1. Check status first. If a pack is bundled, treat it as available and do not download it.
2. Use this skill and Lily-provided artifacts; do not install heavy ML libraries directly from PyPI in the packaged app.
3. If no artifact exists for the platform, say so plainly.
4. Explain download and disk cost before installing large packs.
5. Once install succeeds, subsequent matching tasks can use the pack without restart.
