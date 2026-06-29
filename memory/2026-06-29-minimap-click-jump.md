# Conversation Minimap Click Jump

## Debug Report

- Symptom: clicking the right-side conversation minimap ribs does not reliably
  jump the transcript to the selected user prompt.
- Root cause: the real runtime path builds minimap ribs from data-sourced items
  carrying `turnId`. The click handler delegated every `turnId` rib to
  `jumpToTurn`, even when the target prompt was already rendered in the current
  DOM window. That bypassed the minimap's explicit `panel.scrollTo` path and
  depended on `scrollIntoView`, which is less stable inside the nested chat
  scroller. Two UI details made the bug visible even after the first fix:
  1. The visual rib was also the button hit area (`18px x 2px`), so clicks near
     the line often landed on empty overlay space.
  2. Jumping to an older rib did not mark the panel as user-detached, so live
     auto-follow could pull the transcript back toward the latest turn.
  The renderer regression test only verified that clicking did not throw, not
  that the panel actually scrolled or stayed detached.
- Fix:
  - In `conversation-minimap`, resolve the local DOM target first and scroll the
    owning panel directly when it is already mounted.
  - Use the same explicit panel scroll after `jumpToTurnForSession` loads older
    history, instead of relying on `scrollIntoView`.
  - Separate rib visuals from rib hit targets: keep the clean horizontal-line
    look via `::before`, but make the transparent button target much larger.
  - Detach live auto-follow for older minimap navigation and resume it when the
    terminus/latest rib is clicked.
  - Strengthen the renderer regression so data-sourced `turnId` ribs must scroll
    locally, must not delegate to history loading when the prompt is already
    rendered, and must detach live auto-follow.
- Evidence:
  - `node scripts/test-conversation-minimap.mjs`
  - `npx electron scripts/test-renderer-import.cjs`
  - `node scripts/test-scroll-geometry.mjs`
  - `node scripts/test-renderer-css-tokens.mjs`
  - `node scripts/test-renderer-ui-primitives.mjs`
  - `node scripts/test-theme-tokens.mjs`

Important: minimap must remain non-essential. On any failure, remove/degrade the
rail; never let the chat renderer fail because the navigator failed.
