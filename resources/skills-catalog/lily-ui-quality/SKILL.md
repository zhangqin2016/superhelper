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
