---
name: lily-browser-qa
description: Use when a web page, local app, dashboard, form, generated HTML, React/Vue app, or browser-visible artifact needs to be verified by actually opening it. Covers running a dev server when needed, checking desktop/mobile viewports, clicking through primary flows, inspecting console errors, validating loading/empty/error states, capturing screenshots, and fixing regressions before delivery.
---

# Lily Browser QA

Use this skill as the default delivery gate for anything that can be opened in a browser. Do not rely on imagination when the page can be inspected.

## When to Use

- Creating or changing a website, admin screen, dashboard, form, generated HTML file, React/Vue app, or browser-visible tool.
- Changing frontend layout, styles, interactions, uploads, navigation, dialogs, charts, or forms.
- The user reports that a page is blank, broken, misaligned, unclickable, or has console errors.
- Delivery needs proof that the page opens and primary flows work.

## Workflow

1. Determine how to open it: reuse an existing dev server, start one when required, or open a standalone HTML file.
2. Wait for real content. Do not screenshot or judge a blank loading state.
3. Exercise the primary path: click main buttons, fill key forms, trigger common states.
4. Inspect console and network errors; fix errors that affect the user path.
5. Check at least one desktop width and one narrow/mobile width.
6. Verify loading, empty, error, disabled, and success states when they are part of the feature.
7. Re-open or re-screenshot after fixes.
8. Report what was verified: page, route, viewport, command, or screenshot evidence.

## Quality Bar

- Blank page, fatal console error, or unclickable primary button means not complete.
- Obvious mobile overflow, overlap, clipped text, or compressed controls means not complete.
- Form submission without feedback is not acceptable.
- Never claim visual verification without opening the page or stating why that was impossible.
