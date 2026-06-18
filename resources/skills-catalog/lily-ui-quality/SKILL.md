---
name: lily-ui-quality
description: Use when the task creates, edits, reviews, or verifies any visual interface or web artifact: websites, dashboards, forms, tools, landing pages, admin screens, mobile/desktop layouts, generated HTML, React/Vue components, or visual app prototypes. Enforces Lily UI quality: hierarchy, spacing, responsive layout, states, accessibility, no overlap/overflow, professional aesthetics, browser/screenshot verification when possible.
---

# Lily UI Quality Gate

Use this skill for anything users will see or operate. It covers design quality, interaction clarity, state coverage, and browser-verifiable layout.

## When to Use

- Building or changing websites, admin screens, dashboards, forms, tools, HTML, React/Vue components, or visual prototypes.
- The user asks for better visual quality, responsive layout, interaction polish, or layout fixes.
- The artifact includes buttons, menus, inputs, lists, cards, charts, uploads, dialogs, or navigation.
- Reviewing screenshots or browser-rendered pages.

## Quality Standards

- Clear hierarchy: users know what the page is and what to do next.
- Familiar controls: buttons for commands, inputs for data, selects for choices, switches for binary settings.
- Complete states: loading, empty, error, disabled, success, and dangerous confirmations.
- Responsive reliability: no overlap, clipping, horizontal overflow, or unreadable controls on normal desktop/mobile widths.
- Professional aesthetics: avoid generic gradients, meaningless decorative blobs, large card piles, and one-note palettes.
- Text fit: button, table, card, and sidebar text must fit or wrap intentionally.
- Density fits the domain: operational tools should be calm and scannable; expressive pages can be richer.
- Verification: open the page or screenshot when possible, then fix visible defects.

## Workflow

1. Identify page type and user workflow.
2. Reuse the project's existing design tokens and component patterns.
3. Check desktop and mobile layouts when a browser is available.
4. Fix visible problems and re-check.
5. Report what was verified and what could not be verified.
