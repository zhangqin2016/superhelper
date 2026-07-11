---
name: lily-browser-qa
description: Use when a browser-visible artifact must be verified by actually opening it. Covers supervised dev-server startup, explicit viewports, primary-flow interaction, console/runtime errors, state checks, screenshots, and evidence-based reporting.
---

# Lily Browser QA

This skill is the execution and evidence layer for browser-visible work. Design judgment belongs to `lily-ui-quality`; code repair belongs to `lily-code-repair`.

## Preconditions

- Determine the exact URL or standalone file to open.
- Reuse an existing server when safe. Start a long-lived server through `lily_process_jobs` and confirm readiness with `job_status` and `job_logs`.
- If the platform reports `BROWSER_RUNTIME_UNAVAILABLE`, do not improvise an unverified result. Report the missing `web-automation` runtime pack and use the supported installation path. The rest of chat and coding work must remain available.

## Workflow

1. Record the URL, build/start command, process job id when used, and expected user path.
2. Wait for real content and a ready state; do not judge or screenshot a blank loading transition.
3. Exercise the primary steps: click main actions, enter representative data, submit forms, navigate, and trigger relevant dialogs or menus.
4. Inspect console and relevant network/runtime errors. A fatal error or failed primary action is a failed check.
5. Use explicit viewports. At minimum test one representative desktop viewport and one narrow/mobile viewport for responsive work.
6. Check the states that exist in scope: loading, empty, error, disabled, success, validation, permission, and destructive confirmation.
7. Check keyboard navigation, visible focus, labels, long text, 200% zoom, reduced motion, and RTL/localized layout when relevant to the request.
8. Capture screenshots only after the intended state is visible. After a fix, repeat the original steps and collect new evidence.
9. Stop temporary process jobs unless they are intentionally handed back to the user.

## Evidence Report

Report all of the following:

- URL or file opened.
- Browser/runtime used and process job id when applicable.
- Viewport dimensions.
- Steps executed.
- Expected result and actual result.
- Console or network failures that affected the path.
- Screenshot paths or identifiers.
- States and viewports not tested.

## Quality Bar

- A blank page, fatal console error, or unclickable primary action fails QA.
- Mobile overflow, overlap, clipped text, invisible focus, or inaccessible required controls fails the affected path.
- Form submission without clear feedback fails the interaction check.
- Never claim visual or browser verification without opening the artifact and reporting actual results.
