# Collaboration Right Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-workbench three-column Collaboration Center with a default-collapsed, adaptive right-side IM panel.

**Architecture:** Keep the existing collaboration controller and IPC/data contracts, but move its root into a shell-owned right panel. A small renderer panel controller owns only visibility, responsive dock/overlay mode, resize persistence, focus restoration, and home/conversation presentation state.

**Tech Stack:** Electron renderer, semantic HTML, vanilla JavaScript ES modules, CSS grid/custom properties, Node/Electron DOM tests.

---

## File structure

- Create `src/renderer/modules/collaboration-panel-shell.js`: deterministic presentation controller for open/close, responsive mode, resize, focus, and conversation-level navigation.
- Create `scripts/test-collaboration-right-panel.cjs`: actual Electron DOM regression test for default collapse, dock/overlay behavior, keyboard dismissal, width persistence, and workbench preservation.
- Modify `src/renderer/index.html`: top-bar toggle, scrim, resize handle, semantic right panel, single-column home/conversation levels.
- Modify `src/renderer/modules/collaboration-center.js`: delegate shell presentation and switch levels without changing collaboration transport/data behavior.
- Modify `src/renderer/styles/layout.css`, `src/renderer/styles/right-panel.css`, and `src/renderer/styles/collaboration.css`: four-column docked shell, zero-width closed state, overlay mode, and top-tier single-column IM styling.
- Modify renderer locale JSON files: accessible toggle, close, back, panel, and section labels.
- Modify `CAPABILITY-GATE.md`: register the new unchanged-workbench/default-collapse guard.

### Task 1: Lock shell behavior with a failing Electron test

**Files:**
- Create: `scripts/test-collaboration-right-panel.cjs`

- [ ] **Step 1: Write the failing test**

Load the real `src/renderer/index.html`, import the real collaboration panel module, and assert:

```js
assert.equal(panel.hidden, true);
assert.equal(toggle.getAttribute("aria-expanded"), "false");
assert.equal(shell.classList.contains("collaboration-panel-open"), false);
controller.openPanel();
assert.equal(panel.hidden, false);
assert.equal(toggle.getAttribute("aria-expanded"), "true");
assert.equal(shell.classList.contains("collaboration-panel-open"), true);
```

Also assert wide docked mode, narrow overlay mode, Escape focus restoration, resize clamp, remembered width, restart-closed behavior, and absence of the old center-panel child relationship.

- [ ] **Step 2: Run test to verify RED**

Run: `npx electron scripts/test-collaboration-right-panel.cjs`

Expected: FAIL because the right panel shell/controller and default-collapsed toggle contract do not exist.

- [ ] **Step 3: Commit the RED test**

```bash
git add scripts/test-collaboration-right-panel.cjs
git commit -m "test(collaboration): define right panel shell behavior"
```

### Task 2: Implement the adaptive panel shell

**Files:**
- Create: `src/renderer/modules/collaboration-panel-shell.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles/layout.css`
- Modify: `src/renderer/styles/right-panel.css`

- [ ] **Step 1: Implement the minimal controller**

Expose:

```js
export function initCollaborationPanelShell({
  shell,
  panel,
  toggle,
  closeButton,
  scrim,
  resizeHandle,
  storage = window.localStorage,
  matchMedia = window.matchMedia.bind(window),
}) {
  return {
    openPanel(),
    closePanel(),
    setConversationOpen(open),
    destroy(),
  };
}
```

Use `--collaboration-panel-w`, clamp stored widths to 360–560, set `data-mode` to `docked` or `overlay`, always initialize closed, and restore focus on close. Hidden content must remain non-focusable through the native `hidden` attribute.

- [ ] **Step 2: Move Collaboration markup into the shell right-panel slot**

Add the top-bar toggle and unread badge. Place the resize handle, scrim, and `aside#collaborationCenter` after `section#centerPanel`. Remove `workbenchNavButton` and the old center replacement surface.

- [ ] **Step 3: Add shell geometry**

Use:

```css
.app-shell { grid-template-columns: var(--left-w) 4px minmax(0, 1fr) 0; }
.app-shell.collaboration-panel-open[data-collaboration-mode="docked"] {
  grid-template-columns: var(--left-w) 4px minmax(0, 1fr) var(--collaboration-panel-w, 420px);
}
```

Overlay mode positions the panel at logical inline-end with a scrim and leaves the center column unchanged. Reduced-motion disables transitions.

- [ ] **Step 4: Run the Electron test to verify GREEN**

Run: `npx electron scripts/test-collaboration-right-panel.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/modules/collaboration-panel-shell.js src/renderer/styles/layout.css src/renderer/styles/right-panel.css scripts/test-collaboration-right-panel.cjs
git commit -m "feat(collaboration): add adaptive right panel shell"
```

### Task 3: Convert the Collaboration Center to single-column IM navigation

**Files:**
- Modify: `src/renderer/modules/collaboration-center.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles/collaboration.css`
- Modify: `scripts/test-collaboration-right-panel.cjs`

- [ ] **Step 1: Extend the failing test**

Assert one visible level at a time:

```js
assert.equal(home.hidden, false);
assert.equal(conversation.hidden, true);
await center.open("conversation-id");
assert.equal(home.hidden, true);
assert.equal(conversation.hidden, false);
back.click();
assert.equal(home.hidden, false);
assert.equal(conversation.hidden, true);
```

Assert that closing and reopening preserves the selected level/draft while creating a new controller starts closed.

- [ ] **Step 2: Run test to verify RED**

Run: `npx electron scripts/test-collaboration-right-panel.cjs`

Expected: FAIL because both inbox and conversation columns are currently visible together.

- [ ] **Step 3: Implement level navigation**

The Collaboration controller calls `panelShell.setConversationOpen(true)` only after an authorized conversation opens, and the back button calls it with `false`. Section changes show the home level. Closing does not clear selection or drafts. Revocation returns to home without reopening the panel.

- [ ] **Step 4: Replace dashboard styling with IM styling**

Use a compact header, segmented tabs, 56–68px inbox rows, flexible timeline, sticky composer, refined empty state, logical properties, bounded scroll areas, and existing design tokens. Remove the three-column grid and large empty canvas.

- [ ] **Step 5: Run relevant renderer tests**

Run:

```bash
npx electron scripts/test-collaboration-right-panel.cjs
npx electron scripts/test-collaboration-timeline.cjs
npx electron scripts/test-collaboration-social-ui.cjs
npx electron scripts/test-collaboration-social-navigation.cjs
npx electron scripts/test-collaboration-reply-ui.cjs
npx electron scripts/test-collaboration-reply-navigation.cjs
npx electron scripts/test-collaboration-mentions-ui.cjs
npx electron scripts/test-collaboration-mention-navigation.cjs
npx electron scripts/test-collaboration-attachments-ui.cjs
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.html src/renderer/modules/collaboration-center.js src/renderer/styles/collaboration.css scripts/test-collaboration-right-panel.cjs
git commit -m "feat(collaboration): redesign center as single-column IM"
```

### Task 4: Complete accessibility and localization

**Files:**
- Modify: `src/renderer/i18n/*.json`
- Modify: `scripts/test-collaboration-right-panel.cjs`
- Modify: `scripts/test-collaboration-social-locales.mjs`

- [ ] **Step 1: Add failing locale/accessibility assertions**

Require every shipped locale to define panel open, close, back, Messages, Contacts, Teams, connected, unavailable, and empty-state strings. Assert toggle `aria-expanded`, panel role changes (`complementary` docked, `dialog` overlay), focus restoration, and reduced-motion CSS.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx electron scripts/test-collaboration-right-panel.cjs
node scripts/test-collaboration-social-locales.mjs
```

Expected: FAIL on missing new keys and roles.

- [ ] **Step 3: Add bounded localized strings and roles**

Reuse existing collaboration translations where wording is already correct; add only panel-specific keys. Do not expose transport or recovery internals in user-facing text.

- [ ] **Step 4: Run tests to verify GREEN**

Run the two commands from Step 2.

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/i18n scripts/test-collaboration-right-panel.cjs scripts/test-collaboration-social-locales.mjs
git commit -m "feat(collaboration): localize accessible IM panel"
```

### Task 5: Register the guard and verify the full product

**Files:**
- Modify: `CAPABILITY-GATE.md`

- [ ] **Step 1: Register the regression vector**

Add a gate row stating that collaboration must start collapsed, reserve zero workbench width while closed, adapt dock/overlay without losing drafts, and fail back to the unchanged workbench.

- [ ] **Step 2: Run source and focused checks**

Run:

```bash
git diff --check
node scripts/test-architecture-boundaries.mjs
node scripts/test-capability-gate-registry.mjs
npx electron scripts/test-collaboration-right-panel.cjs
```

Expected: all PASS.

- [ ] **Step 3: Run the full capability gate**

Run: `node scripts/run-capability-gate.mjs`

Expected: `capability-gate: ok` with the registered test included.

- [ ] **Step 4: Run manual Electron acceptance**

Start the app, verify wide docked and narrow overlay states, keyboard dismissal, resize, section/conversation transitions, draft preservation, and capture screenshots for visual review.

- [ ] **Step 5: Commit**

```bash
git add CAPABILITY-GATE.md
git commit -m "test(collaboration): guard adaptive right panel"
```

- [ ] **Step 6: Final branch review**

Confirm only the user-owned `:memory:.ses` remains untracked, review the branch diff, and report any skipped manual or automated acceptance explicitly.
