# Character Context Below Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the message-stream role banner and duplicate toolbar character entry with one accessible conversation-context selector below the composer.

**Architecture:** Keep character binding state and CAS behavior in the existing controller. Relocate the visible trigger into the composer, separate trigger rendering from toolbar-specific rendering, and reuse the existing popover and reducer. Renderer tests assert ownership, native/character states, focus, and session isolation.

**Tech Stack:** Electron renderer HTML, vanilla JavaScript modules, CSS design tokens, Node/Electron integration tests.

---

### Task 1: Lock The New DOM Contract

**Files:**
- Modify: `scripts/test-character-session-control.cjs`
- Modify: `scripts/test-character-binding-updates.mjs`

- [ ] **Step 1: Write failing renderer assertions**

Assert that `#sessionRoleBanner` is a `button` inside `#composer`, is not under
`#sessionMessagesStack`, and is the only visible element with
`aria-haspopup="dialog"` for the character popover.

```js
const context = document.getElementById("sessionRoleBanner");
if (context.tagName !== "BUTTON" || !context.closest("#composer")) throw new Error("context selector must belong to composer");
if (context.closest("#sessionMessagesStack")) throw new Error("context selector must not be message history");
```

- [ ] **Step 2: Write failing render assertions**

Extend the pure role-renderer test to require native mode copy, character mode
copy, localized persona/world labels, and hidden unavailable state.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
node scripts/test-character-binding-updates.mjs
npx electron scripts/test-character-session-control.cjs
```

Expected: failures report the old message-stack `div`, native mode hidden, and
duplicate toolbar trigger.

### Task 2: Relocate The Single Trigger

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/character-binding-updates.js`
- Modify: `src/renderer/modules/character-session-control.js`

- [ ] **Step 1: Move and upgrade markup**

Remove `#sessionRoleBanner` from `#sessionMessagesStack`. Add one real button
after composer previews/tags and before hidden inputs/popovers:

```html
<button id="sessionRoleBanner" class="session-role-banner" type="button"
  aria-haspopup="dialog" aria-expanded="false" aria-controls="characterPopover" hidden>
  <span class="session-role-banner-avatar" aria-hidden="true"></span>
  <span class="session-role-banner-copy">
    <span class="session-role-banner-name"></span>
    <span class="session-role-banner-context"></span>
  </span>
  <span class="session-role-banner-badges"></span>
</button>
```

Remove `#sessionCharacterBtn` from the toolbar after migrating every controller
reference. No hidden compatibility trigger remains in production markup.

- [ ] **Step 2: Render native and character states**

Change `createRoleBannerRenderer` so availability controls `hidden`, while mode
controls icon/name/indicators. Native mode uses `character.nativeOption` and
character mode uses the pinned name. Persona and world labels use existing
localized character keys.

- [ ] **Step 3: Make the context row the popover trigger**

Use `#sessionRoleBanner` for `aria-expanded`, open/close focus return, click
outside exclusion, and popover positioning. Remove toolbar button rendering and
do not expose a second selector.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
node scripts/test-character-binding-updates.mjs
npx electron scripts/test-character-session-control.cjs
```

Expected: both pass.

### Task 3: Apply Compact Footer Styling

**Files:**
- Modify: `src/renderer/styles/character-worlds.css`
- Modify: `scripts/test-renderer-css-tokens.mjs`

- [ ] **Step 1: Add failing CSS contract assertions**

Require the selector to use the chat-column width, one-line truncation,
logical alignment, stable height, and no message-style accent background.

- [ ] **Step 2: Replace banner styling**

Implement a quiet footer control with `width: min(100%, var(--chat-col))`,
`margin: 6px auto 0`, compact avatar, `min-width: 0` copy, ellipsis, textual
badges, and existing focus tokens. Do not add gradients, nested cards, or
directional left/right properties.

- [ ] **Step 3: Run CSS and renderer tests**

```bash
node scripts/test-renderer-css-tokens.mjs
npx electron scripts/test-character-session-control.cjs
```

Expected: both pass with no overlap assertions.

### Task 4: Localize Visible Context Labels

**Files:**
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Modify: `scripts/test-i18n-non-zh-leaks.mjs`

- [ ] **Step 1: Add failing locale assertions**

Require all three locales to define `character.contextPersona` and
`character.contextWorld` and ensure non-Chinese locales do not receive Chinese
fallback text.

- [ ] **Step 2: Add compact localized labels**

Use `设定` / `世界书`, `Persona` / `World`, and concise Arabic equivalents.

- [ ] **Step 3: Run locale tests**

```bash
node scripts/test-i18n-non-zh-leaks.mjs
node scripts/test-user-facing-copy.mjs
```

Expected: both pass.

### Task 5: Visual And Full Regression Verification

**Files:**
- Modify only if a verified defect is found in the files above.

- [ ] **Step 1: Run focused character and scroll tests**

```bash
npx electron scripts/test-character-session-control.cjs
npx electron scripts/test-scroll-autofollow.cjs
node scripts/test-scroll-geometry.mjs
```

- [ ] **Step 2: Run full test suite**

```bash
npm run test:unit
```

Expected: all discovered tests pass.

- [ ] **Step 3: Inspect desktop and narrow screenshots**

Launch the development app, capture the active-character composer at desktop
and narrow widths, and verify: the control is below the composer, no duplicate
trigger exists, no text wraps or overlaps, popover opens upward, and history
scroll position does not change when switching roles.

- [ ] **Step 4: Review diff scope**

```bash
git diff --check
git status --short
```

Confirm only the planned renderer, tests, design/plan, and previously existing
unrelated changes are present; do not stage or revert unrelated work.
