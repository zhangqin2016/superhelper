# Collaboration Panel Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the administration-form appearance of the right-side collaboration panel with a compact, conversation-first desktop IM experience.

**Architecture:** Preserve all collaboration APIs, permission checks, navigation generations, and message reliability logic. Restructure only renderer presentation: compact shell, list rows with avatars and metadata, and disclosure-based creation controls that stay out of the default browsing flow.

**Tech Stack:** Electron renderer, semantic HTML, vanilla JavaScript, CSS custom properties, existing controlled Electron tests.

---

### Task 1: Lock the visual contract

**Files:**
- Modify: `scripts/test-collaboration-right-panel.cjs`

- [ ] Assert the panel exposes compact header actions, disclosure-based creation controls, semantic row classes, and no permanently expanded creation form.
- [ ] Run `npx electron scripts/test-collaboration-right-panel.cjs` and confirm the new assertions fail.

### Task 2: Restructure people and team presentation

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/collaboration-inbox.js`
- Modify: `src/renderer/modules/collaboration-friends.js`
- Modify: `src/renderer/modules/collaboration-teams.js`
- Modify: `src/renderer/modules/collaboration-social-ui.js`

- [ ] Replace text-only conversation buttons with avatar, title, scope, activity, and unread slots.
- [ ] Put add-friend, create-group, and create-channel forms behind compact disclosure actions.
- [ ] Render contacts, teams, members, and conversations as consistent rows with quiet secondary actions.
- [ ] Preserve drafts across refreshes and preserve every existing permission-confirmation flow.

### Task 3: Rebuild the visual system

**Files:**
- Modify: `src/renderer/styles/collaboration.css`

- [ ] Establish a 56px header, compact segmented navigation, 52–60px rows, 14px primary text, and 12px metadata.
- [ ] Style every button/input/select inside the panel; remove browser-default control rendering.
- [ ] Add subtle hover/selected states, generated avatars, polished empty states, and a compact disclosure/card treatment.
- [ ] Verify light/dark themes and 360–560px panel widths.

### Task 4: Verify and visually iterate

**Files:**
- Test: `scripts/test-collaboration-right-panel.cjs`
- Test: existing collaboration renderer suites

- [ ] Run the focused collaboration tests.
- [ ] Run `node scripts/run-capability-gate.mjs`.
- [ ] Restart the Electron app, capture the open panel, inspect hierarchy and density, and adjust until the panel reads as a desktop IM rather than an admin form.
- [ ] Commit the verified redesign without staging user-owned files.
