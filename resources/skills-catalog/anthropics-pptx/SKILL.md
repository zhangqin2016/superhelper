---
name: pptx
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX Skill

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `python -m markitdown presentation.pptx` |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [pptxgenjs.md](pptxgenjs.md) |

---

## Reading Content

```bash
# Text extraction
python -m markitdown presentation.pptx

# Visual overview
python scripts/thumbnail.py presentation.pptx

# Raw XML
python scripts/office/unpack.py presentation.pptx unpacked/
```

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `thumbnail.py`
2. Unpack → manipulate slides → edit content → clean → pack

---

## Creating from Scratch

**Read [pptxgenjs.md](pptxgenjs.md) for full details.**

Use when no template or reference presentation is available and the `pptxgenjs`
package is already available:

```bash
node -e "require.resolve('pptxgenjs')"
```

If that probe fails, do not install packages during the user task. Prefer a
template/editing workflow, raw OOXML packaging, or explain that the current
platform lacks a from-scratch PPT generator.

---

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Choose an interesting font pairing** — don't default to Arial. Pick a header font with personality and pair it with a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Preventing Overflow & Occlusion (Required)

Fixed, absolutely-positioned text boxes are the #1 cause of occluded slides:
long strings overflow the box and stack onto neighbors. This is especially
severe for Chinese/CJK because CJK text does not wrap on spaces and the
renderer substitutes fonts whose glyphs are WIDER than what you authored, so a
box that looks fine in code overflows in the rendered PDF. Follow these rules
when authoring — a box with no overflow risk is unaffected.

- **Never trust a fixed box to hold an unknown-length string.** Every text box
  must either auto-fit or be sized to its content. In `python-pptx`:

  ```python
  from pptx.enum.text import MSO_AUTO_SIZE
  tf = shape.text_frame
  tf.word_wrap = True                          # wrap instead of running off the edge
  tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE  # shrink text to fit the box
  ```

  In `pptxgenjs`, pass `{ shrinkText: true, autoFit: true }` and `wrap: true`
  (or `fit: 'shrink'`) on every text object. If a box's width/height is fixed
  and its content length is not known ahead of time, one of these MUST be set.

- **Keep a safe margin from every slide edge: >= 0.5in (1.27cm).** No text box
  may start or extend past this margin. Content clipped at the edge is a
  delivery blocker.

- **Never overlap text boxes with other shapes.** Position boxes so their
  bounding rectangles do not intersect any other shape or box. Do not pack
  boxes edge-to-edge; keep the 0.3-0.5in gaps from the Spacing rules.

- **Reserve a dedicated footer band.** Keep page numbers, source citations, and
  logos in a fixed strip at the bottom (e.g. the bottom 0.5-0.7in) and keep ALL
  body content out of that band. Footers colliding with body text is a common
  failure — the footer band is off-limits for content.

- **For Chinese/CJK, assume substituted fonts are WIDER than authored.** Leave
  horizontal headroom (do not fill a box to its nominal width), always set
  `word_wrap = True`, cap font sizes (prefer the smaller end of the ranges in
  the Typography table), and never pack CJK boxes edge-to-edge.

- **Cap text per box; split long content across slides.** Do not let a box grow
  or shrink to absurd sizes to swallow long content. If content is too long to
  fit the box comfortably at a readable size, move the overflow to a new slide
  rather than overflowing or auto-shrinking text to unreadable sizes.

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead

---

## QA (Required)

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

### Content QA

```bash
python -m markitdown output.pptx
```

Check for missing content, typos, wrong order.

**When using templates, check for leftover placeholder text:**

```bash
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

If grep returns results, fix them before declaring success.

### Visual QA

**⚠️ USE SUBAGENTS** — even for 2-3 slides. You've been staring at the code and will see what you expect, not what's there. Subagents have fresh eyes.

Convert slides to images (see [Converting to Images](#converting-to-images)), then use this prompt:

```
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.

Read and analyze these images:
1. /path/to/slide-01.jpg (Expected: [brief description])
2. /path/to/slide-02.jpg (Expected: [brief description])

Report ALL issues found, including minor ones.
```

### Verification Loop

1. Generate slides → Convert to images → Inspect
2. **List issues found** (if none found, look again more critically)
3. Fix issues
4. **Re-verify affected slides** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one fix-and-verify cycle.**

### Occlusion Gate (Hard Stop)

The visual QA above is a GATE, not an advisory check. If the rendered slide
shows ANY of the following, it MUST be fixed before delivering — do not ship the
deck:

- Text overflowing its box or stacking onto a neighboring box (classic CJK
  overflow: long Chinese strings running past the box and onto adjacent text)
- Any text or shape clipped at a slide edge, or violating the >= 0.5in margin
- Text drawn through/over a shape, or two shapes/boxes overlapping
- Footer/page-number/citation band colliding with body content

If you see any of these, apply the authoring rules in **Preventing Overflow &
Occlusion** (enable `word_wrap` / auto-fit, shrink the font, enlarge the box,
move it inside the margins, or split content across slides), then re-verify the
affected slides. Repeat until a full pass shows none of the above.

---

## Converting to Images

Convert presentations to individual slide images for visual inspection:

```bash
python scripts/office/soffice.py --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
```

This creates `slide-01.jpg`, `slide-02.jpg`, etc.

To re-render specific slides after fixes:

```bash
pdftoppm -jpeg -r 150 -f N -l N output.pdf slide-fixed
```

---

## Dependencies

- `markitdown` - text extraction; use if `python -c "import markitdown"` succeeds
- `Pillow` - thumbnail grids; use if `python -c "from PIL import Image"` succeeds
- `pptxgenjs` - optional from-scratch PPT generator; use only if `node -e "require.resolve('pptxgenjs')"` succeeds
- LibreOffice (`soffice`) - PDF conversion; use bundled/runtime-pack paths exposed by `scripts/office/soffice.py`
- Poppler (`pdftoppm`) - PDF to images; use only if `command -v pdftoppm` succeeds
