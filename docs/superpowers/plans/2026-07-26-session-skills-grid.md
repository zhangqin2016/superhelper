# Session Skills Responsive Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render per-session skills in a dense, responsive grid capped at three columns while preserving the Settings skill list and all existing selection behavior.

**Architecture:** Keep the existing shared skill-tree DOM and JavaScript behavior unchanged. Add a session-popover-only CSS layer in `composer.css`, using the popover list as a named inline-size container and changing only expanded category children to a row-major grid with three, two, and one-column states.

**Tech Stack:** Electron renderer, CSS Grid, CSS container queries, Node assertion tests.

---

### Task 1: Lock The Layout Contract

**Files:**
- Create: `scripts/test-session-skills-grid.mjs`

- [x] **Step 1: Write the failing CSS contract test**

Create a Node assertion test that reads `composer.css` and `skills-tree.css` and
requires:

```js
assert.match(composerCss, /\.session-skills-popover-list\s*\{[^}]*container-type:\s*inline-size[^}]*container-name:\s*session-skills-list/s);
assert.match(composerCss, /\.session-skills-popover-list\s+\.skills-tree-group--expanded\s+\.skills-tree-group-children\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
assert.match(composerCss, /@container\s+session-skills-list\s*\(max-width:\s*560px\)[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(composerCss, /@container\s+session-skills-list\s*\(max-width:\s*360px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
assert.doesNotMatch(skillsTreeCss, /\.skills-tree-group--expanded\s+\.skills-tree-group-children\s*\{[^}]*display:\s*grid/s);
```

Also require stable cell height, logical border separators, name truncation, and
no literal color values.

- [x] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node scripts/test-session-skills-grid.mjs
```

Expected: failure because `composer.css` does not yet define the scoped grid.

### Task 2: Implement The Scoped Responsive Grid

**Files:**
- Modify: `src/renderer/styles/composer.css`

- [x] **Step 1: Add the named container**

Extend `.session-skills-popover-list` with:

```css
container-type: inline-size;
container-name: session-skills-list;
```

- [x] **Step 2: Add the session-only three-column layout**

Add scoped rules:

```css
.session-skills-popover-list .skills-tree-group--expanded .skills-tree-group-children {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.session-skills-popover-list .skills-tree-row {
  min-height: 38px;
  border-inline-end: 1px solid var(--border);
  border-block-end: 1px solid var(--border);
}
```

Use `:nth-child(3n)` and last-row selectors to remove redundant separators.
Keep row names single-line with ellipsis and prevent the global-disabled badge
from resizing neighboring cells.

- [x] **Step 3: Add medium and narrow container fallbacks**

```css
@container session-skills-list (max-width: 560px) {
  .session-skills-popover-list .skills-tree-group--expanded .skills-tree-group-children {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@container session-skills-list (max-width: 360px) {
  .session-skills-popover-list .skills-tree-group--expanded .skills-tree-group-children {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

Provide equivalent separator rules in each state. The existing shared
single-column `display: block` remains the fallback when container queries are
unsupported.

- [x] **Step 4: Run the focused tests**

Run:

```bash
node scripts/test-session-skills-grid.mjs
node scripts/test-session-skill-tree.mjs
```

Expected: both pass.

### Task 3: Verify Renderer Integration

**Files:**
- Verify: `src/renderer/styles/composer.css`
- Verify: `src/renderer/styles/skills-tree.css`
- Verify: `src/renderer/modules/session-skills.js`

- [x] **Step 1: Run renderer style and skill tests**

```bash
node scripts/test-renderer-ui-primitives.mjs
node scripts/test-renderer-css-tokens.mjs
node scripts/test-session-skill-tree.mjs
```

Expected: all pass.

- [x] **Step 2: Run the complete unit suite**

```bash
npm run test:unit
```

Expected: all discovered tests pass with zero failures.

- [x] **Step 3: Perform visual verification**

Start the renderer through the existing development command, open a conversation
with the skill picker, and inspect at wide, medium, and narrow composer widths.
Confirm three, two, and one columns respectively; no overlap; category controls
remain full width; Settings remains vertical.

- [x] **Step 4: Review the final diff**

```bash
git diff --check
git status -sb
git diff -- scripts/test-session-skills-grid.mjs src/renderer/styles/composer.css
```

Expected: no whitespace errors and no unrelated tracked-file changes.
