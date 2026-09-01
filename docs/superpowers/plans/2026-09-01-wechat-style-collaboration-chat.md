# WeChat-style Collaboration Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the collaboration conversation view as quiet and direct as WeChat while retaining secure mentions, replies, attachments, and delivery semantics.

**Architecture:** Keep all collaboration data and IPC contracts unchanged. Simplify only renderer presentation: contextual `@` discovery, grouped messages, sparse timestamps, one-line conversation header, and a compact composer.

**Tech Stack:** Electron renderer, vanilla JavaScript, CSS, controlled Chromium tests.

---

### Task 1: Contextual mentions

**Files:**
- Modify: `scripts/test-collaboration-mentions-ui.cjs`
- Modify: `src/renderer/modules/collaboration-mentions.js`
- Modify: `src/renderer/styles/collaboration.css`

- [ ] Assert the closed mention controller renders no reminder button or explanatory hint.
- [ ] Assert typing `@` opens the authorized candidate picker and selection still stores stable user IDs.
- [ ] Run the Electron test and confirm the new assertion fails.
- [ ] Remove the manual opener and permanent hint while preserving keyboard selection, retries, tags, authorization fences, and accessibility.
- [ ] Re-run the test and confirm it passes.

### Task 2: WeChat message grouping

**Files:**
- Modify: `scripts/test-collaboration-timeline.cjs`
- Modify: `src/renderer/modules/collaboration-timeline.js`
- Modify: `src/renderer/styles/collaboration.css`

- [ ] Assert own messages omit author/avatar, consecutive messages share visual grouping, and timestamps appear only after a meaningful interval.
- [ ] Run the Electron test and confirm failure.
- [ ] Add deterministic grouping metadata and sparse timestamp separators without changing keyed DOM identity.
- [ ] Re-run timeline, reply, mention, attachment, and scroll tests.

### Task 3: Remove shell noise

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/collaboration-attachments.js`
- Modify: `src/renderer/styles/collaboration.css`

- [ ] Collapse conversation navigation into one 48px row and remove scope badges from the primary visual path.
- [ ] Hide attachment UI completely when the policy disables attachments and no recovery warning exists.
- [ ] Reduce the composer to text, contextual `@`, attachment icon when available, and send icon.
- [ ] Run renderer import and the complete capability gate.
- [ ] Commit without staging user-owned files.
