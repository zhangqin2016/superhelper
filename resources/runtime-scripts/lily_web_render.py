"""Render an SVG or an HTML page to page images, the way a browser shows it.

The same verification loop as documents (render -> look -> fix -> look again),
for the visual files a browser draws. Field case 2026-09-30: with no render
route for an .svg, the agent opened it in the browser tool; file: URLs are
blocked there, and an SVG opened as its own document has no <body>, so the
tool's page snapshot and its full-page screenshot both hang (30 s timeouts).

- SVG opens as its own document, so its references resolve exactly as in a
  browser; the viewport is sized to the drawing and captured as a viewport
  screenshot (the capture that works on an SVG document).
- HTML is laid out at a desktop width and cut into screen-height pages, so each
  page image is something a vision model can actually read.

The browser: Playwright's own build, else an installed Chrome/Edge, else the
Chromium of the Web Automation runtime pack (PLAYWRIGHT_BROWSERS_PATH), whose
build number need not match this Playwright. None of them -> a clear error.
"""
import glob
import math
import os
import re
from pathlib import Path

HTML_EXTS = {".html", ".htm"}
SVG_EXTS = {".svg"}
WEB_EXTS = HTML_EXTS | SVG_EXTS

PAGE_WIDTH = 1280
PAGE_HEIGHT = 800
MAX_PAGES = 30
MAX_SIDE = 8192
TIMEOUT_MS = 20000


class BrowserUnavailable(RuntimeError):
    pass


def _pack_executables():
    """Chromium executables in the runtime pack's browser folder, newest build first."""
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or ""
    if not root or not os.path.isdir(root):
        return []
    patterns = [
        "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
        "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chromium-*/chrome-win*/chrome.exe",
        "chromium-*/chrome-linux*/chrome",
        "chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell",
        "chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell.exe",
    ]
    found = [path for pattern in patterns for path in glob.glob(os.path.join(root, pattern))]
    build = lambda path: int((re.search(r"-(\d+)[\\/]", path) or [0, 0])[1])  # noqa: E731
    return sorted(set(found), key=build, reverse=True)


def _launch(playwright):
    attempts = [("playwright", {})]
    attempts += [(channel, {"channel": channel}) for channel in ("chrome", "msedge")]
    attempts += [(path, {"executable_path": path}) for path in _pack_executables()]
    reasons = []
    for label, options in attempts:
        try:
            return playwright.chromium.launch(**options), label
        except Exception as exc:  # noqa: BLE001 — try the next browser, keep why this one failed
            reasons.append(f"{label}: {str(exc).splitlines()[0][:160]}")
    raise BrowserUnavailable("no browser could be started (install the web-automation runtime pack); tried " + " | ".join(reasons))


def _svg_size(page):
    size = page.evaluate("""() => {
      const root = document.documentElement;
      const box = root.getBoundingClientRect();
      const vb = root.viewBox && root.viewBox.baseVal;
      return { hasW: root.hasAttribute('width'), hasH: root.hasAttribute('height'),
               w: box.width, h: box.height, vbw: vb ? vb.width : 0, vbh: vb ? vb.height : 0 };
    }""")
    width, height = size["w"], size["h"]
    if not (size["hasW"] and size["hasH"]) and size["vbw"] and size["vbh"]:
        # No fixed size: the drawing's own coordinate space is its natural size.
        width = size["w"] if size["hasW"] else size["vbw"]
        height = width * size["vbh"] / size["vbw"]
    width, height = max(1, math.ceil(width)), max(1, math.ceil(height))
    fit = min(1.0, MAX_SIDE / width, MAX_SIDE / height)
    return max(1, int(width * fit)), max(1, int(height * fit)), fit < 1.0


def render_web(path, out_dir, scale=2.0):
    """Render `path` to <out_dir>/page-N.png; returns (images, notes)."""
    from playwright.sync_api import sync_playwright

    source = Path(path).resolve()
    ext = source.suffix.lower()
    if ext not in WEB_EXTS:
        raise ValueError(f"UNSUPPORTED:{ext}")
    density = max(1.0, min(float(scale or 2.0), 2.0))
    notes = []
    images = []
    with sync_playwright() as playwright:
        browser, label = _launch(playwright)
        notes.append(f"browser: {label} {browser.version}")
        try:
            context = browser.new_context(viewport={"width": PAGE_WIDTH, "height": PAGE_HEIGHT}, device_scale_factor=density)
            page = context.new_page()
            page.set_default_timeout(TIMEOUT_MS)
            problems = []
            page.on("pageerror", lambda error: problems.append(f"page error: {error}"))
            page.on("console", lambda message: problems.append(f"console {message.type}: {message.text}") if message.type == "error" else None)
            page.goto(source.as_uri(), wait_until="load")
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:  # noqa: BLE001 — a page that keeps a connection open still renders
                notes.append("network did not go idle within 5 s; rendered as loaded")
            if ext in SVG_EXTS:
                width, height, capped = _svg_size(page)
                if capped:
                    notes.append(f"drawing larger than {MAX_SIDE}px; rendered scaled down")
                page.set_viewport_size({"width": width, "height": height})
                dest = os.path.join(out_dir, "page-1.png")
                page.screenshot(path=dest, animations="disabled", caret="initial")
                images.append(dest)
            else:
                total = page.evaluate("() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")
                count = max(1, math.ceil(total / PAGE_HEIGHT))
                if count > MAX_PAGES:
                    notes.append(f"page is {count} screens tall; rendered the first {MAX_PAGES}")
                    count = MAX_PAGES
                for index in range(count):
                    top = index * PAGE_HEIGHT
                    dest = os.path.join(out_dir, f"page-{index + 1}.png")
                    page.screenshot(path=dest, full_page=True, animations="disabled", caret="initial",
                                    clip={"x": 0, "y": top, "width": PAGE_WIDTH, "height": max(1, min(PAGE_HEIGHT, total - top))})
                    images.append(dest)
            notes.extend(problems[:20])
        finally:
            browser.close()
    return images, notes
