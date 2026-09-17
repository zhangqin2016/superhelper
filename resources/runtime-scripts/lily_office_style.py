#!/usr/bin/env python3
"""Shared Office style helper for Lily's document authoring skills.

Deterministic typography for generated .docx/.pptx: OOXML viewers resolve
latin glyphs via ascii/hAnsi and CJK glyphs via eastAsia — setting only a
latin font guarantees CJK fallback drift (Word substitutes SimSun/DengXian
per machine, which is why generated documents read as "fonts all over the
place"). These helpers set the pair everywhere it matters, plus a light
default deck theme with a contrast checker.

Import from skills:
    import lily_office_style as los
    los.style_docx(doc)                    # apply to a python-docx Document
    los.style_pptx(prs)                    # apply to a python-pptx Presentation
    los.apply_light_background(slide)      # light deck default
    los.contrast_ok(fg, bg)                # WCAG ratio guard for dark designs

Self-test:  python3 lily_office_style.py --selftest
"""

import os

DEFAULT_LATIN_FONT = "Arial"
DEFAULT_CJK_FONT = "Microsoft YaHei"  # 微软雅黑 — present on every Windows; macOS viewers substitute PingFang automatically

LIGHT_THEME = {
    "background": "FFFFFF",
    "surface": "F7F7F5",
    "text": "1F2328",
    "muted": "6B6B66",
    "accent": "6366F1",
}


# ---------------------------------------------------------------- fonts: docx

def _docx_qn():
    from docx.oxml.ns import qn
    return qn


# A theme reference BEATS an explicit font name in LibreOffice's resolver, and the
# default theme's East Asian slot is empty — so setting w:eastAsia while leaving
# w:eastAsiaTheme in place changed nothing for headings. Acceptance 2026-09-17 D1:
# body text came out STSongti while every heading fell back to ArialUnicodeMS in
# the same document. [gate: cjk-theme-font-chain]
_RFONT_THEME_ATTRS = ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme")


def _set_rfonts(rpr, latin, cjk):
    qn = _docx_qn()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.insert(0, rfonts)
    for attr in _RFONT_THEME_ATTRS:
        # An explicit name only wins once the theme reference is gone.
        rfonts.attrib.pop(qn("w:%s" % attr), None)
    rfonts.set(qn("w:ascii"), latin)
    rfonts.set(qn("w:hAnsi"), latin)
    rfonts.set(qn("w:eastAsia"), cjk)
    rfonts.set(qn("w:cs"), latin)


def _set_theme_fonts(doc, latin, cjk):
    """Fill the document theme's major/minor East Asian slots.

    Anything the platform does not reach run by run — and anything a later edit
    adds — still resolves through the theme, so an empty <a:ea> there is a second
    way to lose the CJK face. Never raises."""
    ns = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    try:
        part = doc.part.package.part_related_by(
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
        )
    except Exception:
        try:
            part = next((p for p in doc.part.package.iter_parts()
                         if p.partname.endswith("theme1.xml")), None)
        except Exception:
            part = None
    if part is None:
        return False
    try:
        from lxml import etree
        root = etree.fromstring(part.blob)
        changed = False
        for scheme in ("majorFont", "minorFont"):
            node = root.find(".//%s%s" % (ns, scheme))
            if node is None:
                continue
            for tag, value in (("latin", latin), ("ea", cjk), ("cs", latin)):
                element = node.find("%s%s" % (ns, tag))
                if element is None:
                    element = etree.SubElement(node, "%s%s" % (ns, tag))
                element.set("typeface", value)
                changed = True
        if changed:
            part._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
        return changed
    except Exception:
        return False


def _default_cjk():
    """The CJK family to declare when the caller did not name one.

    Acceptance 2026-09-17 P16: the hard default is a Windows font, so on macOS
    and Linux LibreOffice substituted it PER MODULE and one set of deliverables
    came out in two different typefaces. Resolving to a family the machine really
    has costs nothing on Windows — Microsoft YaHei is installed there, so it is
    returned unchanged — and makes every local export agree.
    Pass `cjk=` explicitly when the deliverable is the Office FILE and the reader
    is on a machine whose fonts you know. [gate: cjk-theme-font-chain]
    """
    try:
        family, _substituted = resolve_cjk_document_family()
        return family or DEFAULT_CJK_FONT
    except Exception:
        return DEFAULT_CJK_FONT


def style_docx(doc, latin=DEFAULT_LATIN_FONT, cjk=None):
    """Apply the latin+CJK font pair to document defaults and every style."""
    cjk = cjk or _default_cjk()
    qn = _docx_qn()
    styles_el = doc.styles.element
    doc_defaults = styles_el.find(qn("w:docDefaults"))
    if doc_defaults is not None:
        rprd = doc_defaults.find(qn("w:rPrDefault"))
        if rprd is not None:
            rpr = rprd.find(qn("w:rPr"))
            if rpr is None:
                rpr = rprd.makeelement(qn("w:rPr"), {})
                rprd.append(rpr)
            _set_rfonts(rpr, latin, cjk)
    for style in doc.styles:
        try:
            el = style.element
            rpr = el.find(qn("w:rPr"))
            if rpr is None:
                rpr = el.makeelement(qn("w:rPr"), {})
                el.append(rpr)
            _set_rfonts(rpr, latin, cjk)
        except Exception:
            continue  # a style that rejects rPr edits must not block authoring
    _set_theme_fonts(doc, latin, cjk)
    return doc


# ---------------------------------------------------------------- fonts: pptx

def _pptx_qn():
    from pptx.oxml.ns import qn
    return qn


def apply_ea_font(run, cjk=None, latin=DEFAULT_LATIN_FONT):
    """Set latin (a:latin) + East-Asian (a:ea) typefaces on one pptx run."""
    cjk = cjk or _default_cjk()
    qn = _pptx_qn()
    rPr = run._r.get_or_add_rPr()
    if latin:
        latin_el = rPr.find(qn("a:latin"))
        if latin_el is None:
            latin_el = rPr.makeelement(qn("a:latin"), {})
            rPr.append(latin_el)
        latin_el.set("typeface", latin)
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = rPr.makeelement(qn("a:ea"), {})
        rPr.append(ea)
    ea.set("typeface", cjk)


def _style_text_frame(tf, latin, cjk):
    for paragraph in tf.paragraphs:
        for run in paragraph.runs:
            apply_ea_font(run, cjk=cjk, latin=latin)


# Chart text is not a run. It lives in the chart PART, resolves through the
# presentation theme, and the default theme's East Asian slot is empty — so a
# native chart's axis labels, legend and title fell back to a system CJK face
# while every real run obeyed. Acceptance 2026-09-17 D2 also proved that filling
# the THEME alone is not enough: the font has to be written into the chart part.
# [gate: cjk-theme-font-chain]
_CHART_TEXT_TAGS = ("defRPr", "endParaRPr", "rPr")


def _set_chart_fonts(prs, latin, cjk):
    """Write explicit fonts into every native chart part. Returns how many parts
    were changed. Never raises — a chart that resists editing keeps its text."""
    A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    C = "{http://schemas.openxmlformats.org/drawingml/2006/chart}"
    changed = 0
    try:
        from lxml import etree
        parts = list(prs.part.package.iter_parts())
    except Exception:
        return 0

    def apply_fonts(node):
        for tag, value in (("latin", latin), ("ea", cjk), ("cs", latin)):
            child = node.find("%s%s" % (A, tag))
            if child is None:
                child = etree.SubElement(node, "%s%s" % (A, tag))
            child.set("typeface", value)

    for part in parts:
        try:
            name = str(getattr(part, "partname", ""))
            if "/charts/chart" not in name or not name.endswith(".xml"):
                continue
            root = getattr(part, "_element", None)
            if root is None:
                continue
            # Existing text properties, wherever the chart already has them.
            for tag in _CHART_TEXT_TAGS:
                for node in root.iter("%s%s" % (A, tag)):
                    apply_fonts(node)
            # A chart usually carries almost none, so also set the chart-wide
            # default: c:txPr on chartSpace covers axis labels, legend and title.
            tx_pr = root.find("%stxPr" % C)
            if tx_pr is None:
                tx_pr = etree.SubElement(root, "%stxPr" % C)
                etree.SubElement(tx_pr, "%sbodyPr" % A)
                etree.SubElement(tx_pr, "%slstStyle" % A)
                paragraph = etree.SubElement(tx_pr, "%sp" % A)
                p_pr = etree.SubElement(paragraph, "%spPr" % A)
                etree.SubElement(p_pr, "%sdefRPr" % A)
                etree.SubElement(paragraph, "%sendParaRPr" % A)
                # chartSpace order is chart, spPr, txPr, externalData.
                external = root.find("%sexternalData" % C)
                if external is not None:
                    root.remove(tx_pr)
                    external.addprevious(tx_pr)
            for tag in ("defRPr", "endParaRPr"):
                for node in tx_pr.iter("%s%s" % (A, tag)):
                    apply_fonts(node)
            changed += 1
        except Exception:
            continue
    return changed


def style_pptx(prs, latin=DEFAULT_LATIN_FONT, cjk=None):
    """Apply the latin+CJK font pair to every run in the presentation."""
    cjk = cjk or _default_cjk()
    for slide in prs.slides:
        for shape in slide.shapes:
            try:
                if shape.has_text_frame:
                    _style_text_frame(shape.text_frame, latin, cjk)
                if getattr(shape, "has_table", False):
                    for row in shape.table.rows:
                        for cell in row.cells:
                            _style_text_frame(cell.text_frame, latin, cjk)
            except Exception:
                continue
    _set_chart_fonts(prs, latin, cjk)
    return prs


# ---------------------------------------------------------------- deck theme

def apply_light_background(slide, hex_color=LIGHT_THEME["background"]):
    """Solid light slide background — the default for generated decks."""
    from pptx.dml.color import RGBColor
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = RGBColor.from_string(hex_color)


def _channel_luminance(value):
    c = value / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def contrast_ratio(fg_hex, bg_hex):
    """WCAG 2.x contrast ratio between two RRGGBB colors."""
    def lum(hex_color):
        r, g, b = (int(hex_color[i:i + 2], 16) for i in (0, 2, 4))
        return 0.2126 * _channel_luminance(r) + 0.7152 * _channel_luminance(g) + 0.0722 * _channel_luminance(b)
    hi, lo = max(lum(fg_hex), lum(bg_hex)), min(lum(fg_hex), lum(bg_hex))
    return (hi + 0.05) / (lo + 0.05)


def contrast_ok(fg_hex, bg_hex, minimum=4.5):
    return contrast_ratio(fg_hex, bg_hex) >= minimum


# ---------------------------------------------------------- document families

# Acceptance 2026-09-17 D-S06-03: the declared CJK font is "Microsoft YaHei",
# which does not exist on macOS, so LibreOffice substitutes — and substitutes
# DIFFERENTLY per module. The same source content came out as ArialUnicodeMS from
# Word and SimSong from PowerPoint. Measured: declaring a family the machine
# actually HAS makes every format embed the identical font.
#
# This is a capability, not a new default. Keeping "Microsoft YaHei" is right when
# the deliverable is the Office file itself and the reader is on Windows; pass an
# installed family instead when the deliverable is a set of PDFs exported here and
# they must look the same.

CJK_DOCUMENT_FALLBACKS = (
    "Microsoft YaHei",
    "Songti SC",
    "PingFang SC",
    "Heiti SC",
    "Arial Unicode MS",
    "Noto Sans CJK SC",
    "WenQuanYi Zen Hei",
    "SimSun",
    "SimHei",
)

_FONT_DIRECTORIES = (
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "/Library/Fonts",
    os.path.join(os.path.expanduser("~"), "Library", "Fonts"),
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    os.path.join(os.path.expanduser("~"), ".fonts"),
    os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts"),
)

_MAX_FONT_FILES = 4000
_installed_families_cache = None


def _sfnt_family_names(path):
    """Family names (name ID 1) declared inside one font file. Never raises."""
    import struct

    names = set()
    try:
        with open(path, "rb") as handle:
            head = handle.read(16)
            if len(head) < 16:
                return names
            offsets = []
            if head[:4] == b"ttcf":
                count = struct.unpack(">I", head[8:12])[0]
                if not 1 <= count <= 64:
                    return names
                handle.seek(12)
                raw = handle.read(4 * count)
                offsets = [struct.unpack(">I", raw[i * 4:i * 4 + 4])[0] for i in range(count)]
            else:
                offsets = [0]
            for offset in offsets:
                handle.seek(offset)
                directory = handle.read(12)
                if len(directory) < 12:
                    continue
                tables = struct.unpack(">H", directory[4:6])[0]
                if not 1 <= tables <= 512:
                    continue
                records = handle.read(tables * 16)
                name_offset = name_length = 0
                for index in range(tables):
                    record = records[index * 16:index * 16 + 16]
                    if record[:4] == b"name":
                        name_offset = struct.unpack(">I", record[8:12])[0]
                        name_length = struct.unpack(">I", record[12:16])[0]
                        break
                if not name_offset or name_length < 6:
                    continue
                handle.seek(name_offset)
                table = handle.read(min(name_length, 64 * 1024))
                if len(table) < 6:
                    continue
                count = struct.unpack(">H", table[2:4])[0]
                strings_at = struct.unpack(">H", table[4:6])[0]
                for index in range(min(count, 256)):
                    entry = table[6 + index * 12:18 + index * 12]
                    if len(entry) < 12:
                        break
                    platform_id, encoding_id, _lang, name_id, length, string_off = struct.unpack(">HHHHHH", entry)
                    if name_id != 1:
                        continue
                    raw = table[strings_at + string_off:strings_at + string_off + length]
                    if not raw:
                        continue
                    try:
                        if platform_id == 3 or (platform_id == 0) or encoding_id == 1 and platform_id == 3:
                            text = raw.decode("utf-16-be", "ignore")
                        else:
                            text = raw.decode("latin-1", "ignore")
                    except Exception:
                        continue
                    text = text.strip()
                    if text:
                        names.add(text)
    except Exception:
        return names
    return names


def installed_font_families(refresh=False):
    """Every font family name this machine declares. Empty when it cannot be read,
    which callers must treat as "unknown", never as "not installed". Never raises."""
    global _installed_families_cache
    if _installed_families_cache is not None and not refresh:
        return _installed_families_cache
    families = set()
    seen = 0
    for directory in _FONT_DIRECTORIES:
        try:
            if not os.path.isdir(directory):
                continue
            for root, _dirs, files in os.walk(directory):
                for name in files:
                    if not name.lower().endswith((".ttf", ".ttc", ".otf", ".otc")):
                        continue
                    seen += 1
                    if seen > _MAX_FONT_FILES:
                        break
                    families |= _sfnt_family_names(os.path.join(root, name))
                if seen > _MAX_FONT_FILES:
                    break
        except Exception:
            continue
    _installed_families_cache = families
    return families


def resolve_cjk_document_family(preferred=DEFAULT_CJK_FONT, fallbacks=CJK_DOCUMENT_FALLBACKS):
    """A CJK family this machine really has, so an export does not substitute.

    Returns (family, substituted). When the installed set cannot be read, the
    preferred family is returned unchanged — behaviour is exactly as before."""
    installed = installed_font_families()
    if not installed:
        return preferred, False
    if preferred in installed:
        return preferred, False
    for family in fallbacks:
        if family != preferred and family in installed:
            return family, True
    return preferred, False


# ------------------------------------------------------------- xlsx printing

# A column narrower than its own number renders as ### once the sheet is printed
# or exported — the value is simply unreadable, and nothing reports it.
# Acceptance 2026-09-17 D8. [gate: office-delivery-completeness]
_MIN_COLUMN_WIDTH = 8.0
_MAX_COLUMN_WIDTH = 60.0


def _rendered_cell_width(cell):
    """Roughly how many characters this cell needs, honouring its number format."""
    value = cell.value
    if value is None:
        return 0
    if isinstance(value, bool):
        return 5
    if isinstance(value, (int, float)):
        fmt = str(cell.number_format or "")
        digits = len(str(abs(int(value))))
        width = digits
        if "," in fmt:
            width += max(0, (digits - 1) // 3)
        if "." in fmt:
            width += 1 + fmt.split(".")[-1].count("0")
        if value < 0:
            width += 1
        if "%" in fmt:
            width += 1
        if fmt.strip().startswith(("¥", "$", "€", "£")) or "\"" in fmt:
            width += 2
        return width
    text = str(value)
    # A CJK glyph occupies about two character widths.
    wide = sum(1 for ch in text if ord(ch) > 0x2E7F)
    return len(text) + wide


def fit_column_widths(sheet, minimum=_MIN_COLUMN_WIDTH, maximum=_MAX_COLUMN_WIDTH, padding=2.0):
    """Widen columns so their own content is readable after export.

    Only ever widens, and only where no explicit width was set, so a deliberate
    layout is preserved. Returns the columns changed. Never raises."""
    widened = []
    try:
        from openpyxl.utils import get_column_letter
    except Exception:
        return widened
    try:
        # Neither `width` nor `customWidth` distinguishes "nobody set this":
        # openpyxl hands back a default ColumnDimension with width 13.0 and
        # customWidth True, and merely ACCESSING one materialises it into the
        # file. So presence before we touch anything is the only honest signal.
        preset = set(sheet.column_dimensions.keys())
        needed = {}
        for row in sheet.iter_rows():
            for cell in row:
                width = _rendered_cell_width(cell)
                if width and width > needed.get(cell.column, 0):
                    needed[cell.column] = width
        for index, width in needed.items():
            letter = get_column_letter(index)
            if letter in preset:
                continue  # a width someone chose is a decision; respect it
            dimension = sheet.column_dimensions[letter]
            target = max(minimum, min(maximum, width + padding))
            # customWidth is derived from width and has no setter; assigning it
            # raised, the fail-open except swallowed it, and this whole function
            # became a silent no-op. Setting width is what openpyxl wants.
            dimension.width = target
            widened.append(letter)
    except Exception:
        return widened
    return widened


def style_xlsx_print(workbook, landscape_charts=True, fit_widths=True):
    """Keep exported worksheets whole.

    Acceptance 2026-09-16 DEF-006: rendering a budget workbook to PDF put the
    table and its bar chart on page 3 and left page 4 almost empty, carrying only
    the chart's vertical axis title. A floating chart straddled a horizontal page
    break because the sheet declared no page setup at all, so LibreOffice paginated
    on default paper.

    A sheet that carries a chart is fitted to ONE page in both directions, which
    makes a split impossible; a plain data sheet is fitted to one page WIDE and
    allowed to flow down as many pages as it needs. Returns the sheet names that
    were treated as chart sheets. Never raises."""
    chart_sheets = []
    try:
        worksheets = list(workbook.worksheets)
    except Exception:
        return chart_sheets
    for sheet in worksheets:
        try:
            has_chart = bool(getattr(sheet, "_charts", []) or getattr(sheet, "_images", []))
            setup_pr = sheet.sheet_properties.pageSetUpPr
            if setup_pr is not None:
                setup_pr.fitToPage = True
            sheet.page_setup.fitToWidth = 1
            sheet.page_setup.fitToHeight = 1 if has_chart else 0
            if fit_widths:
                fit_column_widths(sheet)
            if has_chart:
                if landscape_charts:
                    sheet.page_setup.orientation = "landscape"
                chart_sheets.append(sheet.title)
        except Exception:
            # Print setup is a polish step; never fail a workbook over it.
            continue
    return chart_sheets


# ------------------------------------------------------------- CJK PDF font

# ReportLab embeds TrueType glyph outlines only. A font carrying PostScript
# (CFF) outlines raises "postscript outlines are not supported", and macOS ships
# CFF for PingFang and Hiragino Sans GB while Linux ships CFF for Noto CJK — so
# "the file exists" was never a strong enough test, and a drawn PDF silently
# lost every Chinese character to the Helvetica fallback.

OUTLINE_TRUETYPE = "truetype"
OUTLINE_POSTSCRIPT = "postscript"
OUTLINE_UNKNOWN = "unknown"

# Same order as src/main/document-fonts.js. The host normally hands a verified
# path down as LILY_CJK_FONT_PATH; this list is what keeps a bare `python3`
# invocation outside the managed runtime working too.
CJK_FONT_CANDIDATES = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\msyhbd.ttc",
    "C:\\Windows\\Fonts\\simhei.ttf",
    "C:\\Windows\\Fonts\\simsun.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
)


def font_outline_format(path):
    """Which glyph outlines a font file carries, read from its sfnt table
    directory. Returns 'truetype', 'postscript' or 'unknown'. Never raises —
    'unknown' means no opinion and must never be treated as a rejection."""
    import struct

    try:
        with open(path, "rb") as handle:
            header = handle.read(16)
            if len(header) < 16:
                return OUTLINE_UNKNOWN
            offset_table = 0
            if header[:4] == b"ttcf":
                if struct.unpack(">I", header[8:12])[0] < 1:
                    return OUTLINE_UNKNOWN
                offset_table = struct.unpack(">I", header[12:16])[0]
            handle.seek(offset_table)
            directory = handle.read(12)
            if len(directory) < 12:
                return OUTLINE_UNKNOWN
            count = struct.unpack(">H", directory[4:6])[0]
            if not 1 <= count <= 512:
                return OUTLINE_UNKNOWN
            records = handle.read(count * 16)
            if len(records) < count * 16:
                return OUTLINE_UNKNOWN
            tags = {records[i * 16:i * 16 + 4] for i in range(count)}
    except Exception:
        return OUTLINE_UNKNOWN
    if b"glyf" in tags:
        return OUTLINE_TRUETYPE
    if b"CFF " in tags or b"CFF2" in tags:
        return OUTLINE_POSTSCRIPT
    return OUTLINE_UNKNOWN


def resolve_cjk_font(env_path=None):
    """Return (path, outline) for a CJK font ReportLab can embed.

    Falls back to the first font that merely exists when nothing embeddable is
    found, so behaviour is never worse than a plain existence check. Returns
    (None, 'unknown') when no candidate exists at all. Never raises."""
    import os

    configured = env_path if env_path is not None else os.environ.get("LILY_CJK_FONT_PATH")
    seen = set()
    candidates = []
    for candidate in (configured,) + CJK_FONT_CANDIDATES:
        if candidate and candidate not in seen:
            seen.add(candidate)
            candidates.append(candidate)

    fallback = None
    for candidate in candidates:
        try:
            if not os.path.exists(candidate):
                continue
        except Exception:
            continue
        if fallback is None:
            fallback = candidate
        if font_outline_format(candidate) != OUTLINE_POSTSCRIPT:
            return candidate, font_outline_format(candidate)
    if fallback is not None:
        return fallback, OUTLINE_POSTSCRIPT
    return None, OUTLINE_UNKNOWN


def register_cjk_font(name="LilyCJK"):
    """Register an embeddable CJK font with ReportLab and return the font name to
    draw with, or 'Helvetica' when none is available. Never raises."""
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except Exception:
        return "Helvetica"

    path, _outline = resolve_cjk_font()
    if not path:
        return "Helvetica"
    kwargs = {"subfontIndex": 0} if path.lower().endswith(".ttc") else {}
    try:
        pdfmetrics.registerFont(TTFont(name, path, **kwargs))
        return name
    except Exception:
        return "Helvetica"


def configure_matplotlib_cjk():
    """Point matplotlib at a real CJK face so Chinese labels are not tofu boxes.

    Returns the family name in use, or None when matplotlib is unavailable or no
    CJK font exists. Never raises — a chart with Latin-only labels still renders."""
    try:
        import matplotlib
        from matplotlib import font_manager
    except Exception:
        return None
    path, _outline = resolve_cjk_font()
    if not path:
        return None
    try:
        font_manager.fontManager.addfont(path)
        family = font_manager.FontProperties(fname=path).get_name()
        matplotlib.rcParams["font.sans-serif"] = [family] + list(
            matplotlib.rcParams.get("font.sans-serif", [])
        )
        # A CJK face usually has no ASCII minus glyph; without this every
        # negative tick label renders as a box.
        matplotlib.rcParams["axes.unicode_minus"] = False
        return family
    except Exception:
        return None


# ---------------------------------------------------------------- self-test

def _selftest():
    import tempfile
    from docx import Document
    from pptx import Presentation
    from pptx.util import Inches

    doc = Document()
    doc.add_heading("季度报告 Quarterly Report", 0)
    doc.add_paragraph("中文正文 mixed with English and 12345.")
    style_docx(doc)
    qn = _docx_qn()
    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
        doc.save(tmp.name)
    from docx import Document as ReopenDoc
    reopened = ReopenDoc(tmp.name)
    rpr = reopened.styles["Normal"].element.find(qn("w:rPr"))
    rfonts = rpr.find(qn("w:rFonts"))
    expected_cjk = _default_cjk()
    assert rfonts.get(qn("w:eastAsia")) == expected_cjk, "docx eastAsia must persist after save/reopen"
    assert rfonts.get(qn("w:ascii")) == DEFAULT_LATIN_FONT, "docx latin must persist after save/reopen"

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[5])
    slide.shapes.title.text = "季度回顾 Q3 Review"
    body = slide.placeholders[1].text_frame if len(slide.placeholders) > 1 else None
    box = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(6), Inches(1))
    box.text_frame.text = "中文要点 mixed bullets"
    apply_light_background(slide)
    style_pptx(prs)
    pqn = _pptx_qn()
    title_run = slide.shapes.title.text_frame.paragraphs[0].runs[0]
    ea = title_run._r.get_or_add_rPr().find(pqn("a:ea"))
    assert ea is not None and ea.get("typeface") == expected_cjk, "pptx run must carry a:ea typeface"

    # A chart sheet must be fitted to ONE page in both directions, or LibreOffice
    # splits the chart across a page break and leaves a near-empty page carrying
    # just the axis title. A plain data sheet keeps flowing downward.
    from openpyxl import Workbook, load_workbook
    from openpyxl.chart import BarChart, Reference
    wb = Workbook()
    grid = wb.active
    grid.title = "数据"
    grid.append(["区域", "金额"])
    for index in range(12):
        grid.append(["区域%d" % index, 1000 + index])
    charts = wb.create_sheet("图表")
    bar = BarChart()
    bar.y_axis.title = "金额"
    bar.add_data(Reference(grid, min_col=2, min_row=1, max_row=13), titles_from_data=True)
    charts.add_chart(bar, "B2")
    assert style_xlsx_print(wb) == ["图表"], "only the chart sheet is treated as a chart sheet"
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as book:
        wb.save(book.name)
    reopened = load_workbook(book.name)
    chart_sheet = reopened["图表"]
    assert chart_sheet.sheet_properties.pageSetUpPr.fitToPage is True, "fitToPage must persist"
    assert chart_sheet.page_setup.fitToWidth == 1 and chart_sheet.page_setup.fitToHeight == 1, "a chart sheet is one page"
    assert chart_sheet.page_setup.orientation == "landscape"
    data_sheet = reopened["数据"]
    assert data_sheet.page_setup.fitToWidth == 1 and data_sheet.page_setup.fitToHeight == 0, "data flows down"
    assert style_xlsx_print(object()) == [], "a non-workbook never raises"

    # A column narrower than its own number exports as ###.
    money = wb.create_sheet("金额")
    money.append(["项目", "金额"])
    money.append(["营收合计", 218377010.0])
    money["B2"].number_format = "#,##0.00"
    widened = fit_column_widths(money)
    assert "B" in widened, "a wide number must widen its column"
    assert money.column_dimensions["B"].width >= 14
    money.column_dimensions["C"].width = 4.0
    money["C1"] = 123456789
    assert "C" not in fit_column_widths(money), "an explicit width is a decision, not a defect"

    # The theme must not out-vote the font we just set, in either direction.
    theme_doc = Document()
    theme_doc.add_heading("一、关键指标摘要", 1)
    style_docx(theme_doc)
    for style_obj in theme_doc.styles:
        rpr = style_obj.element.find(qn("w:rPr"))
        if rpr is None:
            continue
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            continue
        for attr in _RFONT_THEME_ATTRS:
            assert rfonts.get(qn("w:%s" % attr)) is None, "a theme reference beats the explicit font"

    # Declaring a family the machine does not have is what makes LibreOffice
    # substitute differently per module, so the same content leaves Word and
    # PowerPoint wearing different fonts.
    families = installed_font_families()
    assert isinstance(families, set)
    if families:
        assert len(families) > 20, "a machine with fonts should report more than a handful"
        present = next(iter(families))
        assert resolve_cjk_document_family(preferred=present) == (present, False), "an installed family is kept"
        chosen, substituted = resolve_cjk_document_family(preferred="No Such Font Family ZZZ")
        assert chosen != "No Such Font Family ZZZ" and substituted is True, "a missing family is replaced by one that exists"
        assert chosen in families
    # Unknowable installed set must behave exactly as before: keep the preferred.
    assert resolve_cjk_document_family(preferred="Whatever", fallbacks=()) [0] in ("Whatever", *CJK_DOCUMENT_FALLBACKS)
    assert _sfnt_family_names("/definitely/not/a/font.ttc") == set(), "an unreadable file is silence"

    assert contrast_ok(LIGHT_THEME["text"], LIGHT_THEME["background"]), "theme text/bg must pass AA"
    assert not contrast_ok("1F2328", "1E2761"), "dark-on-dark must fail the guard"

    # The CJK PDF font must be one ReportLab can actually embed, and the outline
    # probe must agree with ReportLab itself on every candidate that exists.
    import os
    path, outline = resolve_cjk_font()
    if path:
        assert outline in (OUTLINE_TRUETYPE, OUTLINE_UNKNOWN, OUTLINE_POSTSCRIPT)
        try:
            from reportlab.pdfbase import pdfmetrics
            from reportlab.pdfbase.ttfonts import TTFont
        except Exception:
            pdfmetrics = None
        if pdfmetrics is not None:
            for index, candidate in enumerate(CJK_FONT_CANDIDATES):
                if not os.path.exists(candidate):
                    continue
                probed = font_outline_format(candidate)
                kwargs = {"subfontIndex": 0} if candidate.lower().endswith(".ttc") else {}
                try:
                    pdfmetrics.registerFont(TTFont("selftest%d" % index, candidate, **kwargs))
                    embeddable = True
                except Exception:
                    embeddable = False
                if probed == OUTLINE_POSTSCRIPT:
                    assert not embeddable, "probe called %s unusable but ReportLab embedded it" % candidate
                elif probed == OUTLINE_TRUETYPE:
                    assert embeddable, "probe called %s usable but ReportLab rejected it" % candidate
            assert register_cjk_font() != "Helvetica", "a machine with a CJK font must not fall back to Helvetica"
    print("lily_office_style selftest ok")


if __name__ == "__main__":
    import sys
    if "--selftest" in sys.argv:
        _selftest()
    else:
        print(__doc__)
