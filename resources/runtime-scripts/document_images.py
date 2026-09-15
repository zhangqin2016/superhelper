#!/usr/bin/env python3
"""Recognize the content that documents carry only as pixels.

The text extractors walk paragraphs, cells and text frames, so anything that
exists solely inside an embedded picture — a pasted invoice, a chart
screenshot, a stamped scan — was dropped silently: the model saw a document
with a hole in it and never knew. This module harvests those pictures and runs
the same local OCR the scanned-PDF path already uses.

Design rules, in order of importance:
1. NEVER make extraction worse. Every failure here is caught by the caller and
   degrades to today's text-only result.
2. Say when a picture could not be read. A silent drop is what made the
   original bug invisible; "[Image 3: no readable text]" keeps the model honest.
3. Stay bounded on an ordinary laptop: decorative icons are skipped, repeated
   logos are recognized once, oversized bitmaps are downscaled, and the whole
   pass has a wall-clock budget.
"""

import hashlib
import io
import os
import time
import zipfile

# Pictures below this are furniture — bullets, rules, inline icons. Judged in
# PIXELS, never in bytes: text on a flat background compresses so well that a
# readable 300x160 logo lands under 6 KB, and a byte threshold silently dropped
# exactly the small-but-meaningful pictures this module exists to recover.
MIN_EDGE_PX = 110
# Long edge fed to OCR. RapidOCR gains nothing above this and the render cost
# grows quadratically.
MAX_EDGE_PX = 2600
MAX_IMAGES = 40
TIME_BUDGET_S = 60.0
# A PDF image object smaller than this share of the page is an icon or rule.
MIN_PDF_AREA_RATIO = 0.02


def _limit_int(name, fallback):
    try:
        value = int(os.environ.get(name, "") or 0)
        return value if value > 0 else fallback
    except ValueError:
        return fallback


class ImageHarvest:
    """Bounded, deduplicated OCR over the pictures found in one document."""

    def __init__(self, ocr, export_dir=None):
        self._ocr = ocr
        # When the caller wants a second opinion (a vision model reads charts
        # and photos that OCR can only spell), every recognized picture is
        # written here so the caller can upgrade it without re-parsing the
        # document. OCR text stays authoritative for exact strings.
        self._export_dir = export_dir
        self.exported = []
        self._seen = {}
        self._started = time.monotonic()
        self._index = 0
        self.skipped = 0
        self.failed = 0
        # A runtime without the OCR pack must not turn every picture into an
        # "unreadable" line: the engine is probed lazily on the first picture
        # and, when it is simply absent, the document says so ONCE.
        self.unavailable = False
        self.max_images = _limit_int("LILY_DOC_IMAGE_MAX", MAX_IMAGES)
        self.budget = float(_limit_int("LILY_DOC_IMAGE_BUDGET_S", int(TIME_BUDGET_S)))

    def _out_of_budget(self):
        return time.monotonic() - self._started > self.budget

    def _prepare(self, data):
        """Decode, reject furniture, downscale. Returns an RGB array or None."""
        from PIL import Image
        import numpy as np

        try:
            image = Image.open(io.BytesIO(data))
            image.load()
        except Exception:  # noqa: BLE001 — an unreadable picture is not an extraction failure
            return None
        if min(image.size) < MIN_EDGE_PX:
            return None
        if max(image.size) > MAX_EDGE_PX:
            scale = MAX_EDGE_PX / max(image.size)
            image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))))
        return np.asarray(image.convert("RGB"))

    def read(self, data):
        """Recognize one picture. Returns a marker line, or "" when skipped.

        The marker always carries an index so a model can refer to "the third
        image"; a picture that yields nothing still gets a line, because
        "there is a figure here I could not read" is information.
        """
        if not data or self.unavailable:
            if data:
                self.skipped += 1
            return ""
        digest = hashlib.sha256(data).hexdigest()
        if digest in self._seen:
            # A logo repeated on every page is recognized once. Later
            # occurrences become a short back-reference so the document still
            # shows where the picture sits without repeating its text; a
            # repeated picture that carried no text is pure noise and is
            # dropped entirely.
            index = self._seen[digest]
            return f"[Image {index} again]" if index else ""
        if self._index >= self.max_images or self._out_of_budget():
            self.skipped += 1
            return ""
        frame = self._prepare(data)
        if frame is None:
            self.skipped += 1
            return ""
        self._index += 1
        index = self._index
        try:
            text = (self._ocr(frame) or "").strip()
        except ImportError:
            # No OCR runtime at all. Roll the index back so the document does
            # not number pictures it never read, and stay quiet from here on.
            self.unavailable = True
            self._index -= 1
            self.skipped += 1
            return ""
        except Exception:  # noqa: BLE001 — OCR must never break extraction
            self.failed += 1
            self._seen[digest] = index
            return f"[Image {index}: not readable]"
        self._export(index, data, text)
        self._seen[digest] = index if text else 0
        return f"[Image {index}] {text}" if text else f"[Image {index}: no readable text]"

    def _export(self, index, data, text):
        """Write one recognized picture for the caller. Failure is silent: an
        export is an optional upgrade, never a reason to lose the OCR text."""
        if not self._export_dir:
            return
        try:
            os.makedirs(self._export_dir, exist_ok=True)
            target = os.path.join(self._export_dir, f"image-{index}.png")
            from PIL import Image

            with Image.open(io.BytesIO(data)) as image:
                image.convert("RGB").save(target, format="PNG")
            self.exported.append({"index": index, "path": target, "text": text})
        except Exception:  # noqa: BLE001
            return

    def footer(self):
        """One honest line about what was not read, or "" when nothing was lost."""
        notes = []
        if self.unavailable:
            return f"[Images: {self.skipped} picture(s) not read — image recognition runtime unavailable]"
        if self.skipped:
            notes.append(f"{self.skipped} picture(s) not read (decorative, limit or time budget)")
        if self.failed:
            notes.append(f"{self.failed} picture(s) failed recognition")
        return f"[Images: {'; '.join(notes)}]" if notes else ""


A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def docx_element_images(part, element):
    """Picture bytes referenced by one docx paragraph or table, in order."""
    blobs = []
    for blip in element.iter(f"{A_NS}blip"):
        rid = blip.get(f"{R_NS}embed") or blip.get(f"{R_NS}link")
        if not rid:
            continue
        try:
            blobs.append(part.related_parts[rid].blob)
        except Exception:  # noqa: BLE001 — a broken relationship is not an extraction failure
            continue
    return blobs


def pptx_shape_image(shape):
    """Picture bytes for one pptx shape, or None when it carries no picture."""
    try:
        if getattr(shape, "shape_type", None) is None:
            return None
        image = getattr(shape, "image", None)
        return image.blob if image is not None else None
    except Exception:  # noqa: BLE001 — placeholders and charts raise here by design
        return None


def zip_media(path, prefix):
    """Embedded media of an OOXML package, in package order (xlsx has no
    reliable cell anchor without a full workbook load, so those land in a
    trailing section rather than being dropped)."""
    out = []
    try:
        with zipfile.ZipFile(path) as package:
            for name in package.namelist():
                if not name.startswith(prefix):
                    continue
                if os.path.splitext(name)[1].lower() not in {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"}:
                    continue
                out.append((name, package.read(name)))
    except Exception:  # noqa: BLE001
        return []
    return out


def pdf_page_pictures(page, render_page):
    """OCR-ready crops of the picture objects on a page that already has text.

    A page with no text layer is rendered whole by the caller. This covers the
    common mixed page — prose plus a chart or screenshot — where the old
    "page has text, so skip it" rule hid the picture entirely.
    """
    images = getattr(page, "images", None) or []
    if not images:
        return []
    page_area = float(page.width or 0) * float(page.height or 0)
    if page_area <= 0:
        return []
    boxes = []
    for item in images:
        try:
            x0, x1 = float(item["x0"]), float(item["x1"])
            top, bottom = float(item["top"]), float(item["bottom"])
        except Exception:  # noqa: BLE001
            continue
        if x1 <= x0 or bottom <= top:
            continue
        if ((x1 - x0) * (bottom - top)) / page_area < MIN_PDF_AREA_RATIO:
            continue
        boxes.append((x0, top, x1, bottom))
    if not boxes:
        return []
    rendered = render_page()
    if rendered is None:
        return []
    scale_x = rendered.width / float(page.width)
    scale_y = rendered.height / float(page.height)
    crops = []
    for x0, top, x1, bottom in boxes:
        box = (
            max(0, int(x0 * scale_x)), max(0, int(top * scale_y)),
            min(rendered.width, int(x1 * scale_x)), min(rendered.height, int(bottom * scale_y)),
        )
        if box[2] - box[0] < MIN_EDGE_PX or box[3] - box[1] < MIN_EDGE_PX:
            continue
        buffer = io.BytesIO()
        rendered.crop(box).save(buffer, format="PNG")
        crops.append(buffer.getvalue())
    return crops
