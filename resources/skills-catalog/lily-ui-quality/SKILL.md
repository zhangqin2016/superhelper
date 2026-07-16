---
name: lily-ui-quality
description: Use when creating, editing, or reviewing a visual interface. Defines Lily's hierarchy, typography, color, spacing, responsive, interaction, accessibility, localization, state, and evidence standards without claiming browser verification that was not executed.
---

# Lily UI Quality

Use this skill for anything users will see or operate. It supplies design judgment; `lily-browser-qa` supplies runtime evidence.

## Modes

### Creation mode

Use for a new or redesigned page. Establish the user goal, information hierarchy, visual direction, typography, color roles, spacing rhythm, layout grid, component states, responsive behavior, and motion before polishing details. Reuse the project's tokens and components when they exist; do not flatten a distinctive product into a generic template.

### Review mode

Use for an existing implementation or screenshot. Identify observable problems, rank them by user impact, explain the governing principle, and propose a concrete correction. Separate direct evidence from inference. Do not say the page passed browser QA unless it was actually opened.

## Quality Matrix

- **Hierarchy and task clarity:** the page purpose, primary action, grouping, and reading order are obvious.
- **Typography:** use a deliberate type scale, readable line length and line height, stable numeric alignment, and intentional wrapping for long text.
- **Color:** use semantic roles rather than decorative color noise; preserve readable contrast in normal, hover, disabled, error, success, selected, dark, and light states.
- **Spacing and composition:** align to a consistent rhythm; avoid arbitrary gaps, accidental card grids, clipped content, and unnecessary decoration.
- **Interaction:** use familiar controls, clear affordances, useful feedback, safe destructive confirmation, and no hover-only essential action.
- **Complete states:** loading, empty, error, disabled, success, offline/permission states, and content skeletons must fit the real workflow.
- **Responsive behavior:** verify intended reflow rather than shrinking desktop UI. Check narrow/mobile and desktop widths, touch targets, tables, dialogs, navigation, and horizontal overflow.
- **Keyboard and focus:** every primary flow works by keyboard; focus order follows reading order; focus is visible; dialogs trap and restore focus correctly.
- **Semantics and labels:** controls have accessible names, form labels and errors are associated, headings are ordered, and status changes are announced when needed.
- **Contrast and zoom:** text, controls, focus indicators, and essential graphics retain contrast; content remains usable at 200% zoom without lost actions or two-dimensional scrolling except where intrinsically required.
- **Motion:** animation explains change and stays restrained; support `prefers-reduced-motion` and never require motion to understand state.
- **Localization stress:** test Chinese, English, Arabic/RTL, long text, long numbers, empty values, and translated button labels. Mirroring must not reverse semantic icons or data direction.
- **Content stress:** test realistic long names, dense tables, validation errors, missing images, many/few items, and permission-limited states.

## Concrete Defaults (use these values, not adjectives)

When there is no existing project design system, do not invent values ad hoc — that is what makes output look cheap. Start from `lily-app-builder`'s shipped base (`assets/base.css` + `InterVariable.woff2` + `page-shell.html`) which encodes all of the below, or reproduce these values inline:

- **Font:** `"InterVariable", -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif`. Bundle/self-host the font — never rely on the OS having it (the default face is the #1 cheap tell). Always name a CJK fallback so Chinese never drops to a serif/tofu face.
- **Type scale (1.25):** 12 / 14 / 16 / 18 / 22 / 28 / 36 / 48 px. Body line-height 1.65, headings 1.2, reading measure ~68ch. Enable `font-variant-numeric: tabular-nums` so numbers do not jitter.
- **Spacing scale (8px):** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px. Every gap comes from the scale — no arbitrary values.
- **Palette — warm paper, not cold SaaS gray:** paper `#faf8f4`, raised `#fff`, sunken `#f3f0ea`; ink `#1c1a17`, secondary `#55514a`, tertiary `#8a857c`. **One** brand accent (Lily periwinkle `#5a4fd6`); muted status only (success `#2f855a`, warning `#b7791f`, danger `#c53030`). Dark mode = warm-dark, not pure black.
- **Lines & elevation:** hairlines `rgba(28,26,23,0.10)`, not hard 1px gray borders. Radius 6/10/16. Shadows soft and low (`0 2px 4px / 0 12px 28px` at ≤7% alpha).

### No cheap tells (do NOT)

- No default/system serif or link-blue `#0000EE` — always ship the font + accent.
- No big glowy drop-shadows, no gradient-washed alert boxes (Bootstrap-alert look), no rainbow of accent colors — one accent, muted status.
- No hard full-black `#000` on pure `#fff`; no cramped or arbitrary spacing; no full-viewport-width prose (cap at the measure).
- No decorative color used to carry meaning; no heavy table gridlines (use hairline zebra).

## Workflow

1. Select Creation mode or Review mode and state the primary user path.
2. Read the existing design tokens, components, content, and product constraints.
3. Define or assess hierarchy, typography, color, spacing, states, accessibility, responsive behavior, localization, and motion.
4. Make the smallest coherent set of changes; preserve established product identity unless redesign is requested.
5. When source or a running page is available, hand execution to `lily-browser-qa` with explicit routes, viewports, and primary interactions.
6. Reassess after fixes and report verified evidence, remaining inference, and any blocker.

## Report Format

- Scope and mode.
- Highest-impact findings or design decisions.
- Changes made, ordered by user impact.
- Browser/screenshot evidence, only when actually collected.
- Untested states and residual risk.
