# Character Context Below Composer

## Goal

Move the conversation-level character indicator out of the message history and
place it directly below the composer. The control must make the active role,
persona, and world-book context obvious without competing with messages or
duplicating another character entry in the composer toolbar.

## Final Layout

The character context control is the last visible row of the composer form,
below the input card and its attachment/skill previews. Its width follows the
chat column. It is a quiet, single-line button rather than a bordered message
banner.

The control is visible whenever Character Worlds is available:

- Native mode shows the standard Lily icon and the localized native-Lily name.
- Character mode shows the character monogram and pinned display name.
- Pinned persona and world book are shown as localized text indicators, not
  unexplained `P` and `W` letters.
- Long names truncate to one line while the full name remains available through
  the button title and accessible name.

The existing toolbar character button is removed from the visible toolbar so
the same session state is not presented twice. The context row becomes the
single character selector.

## Interaction

Clicking the context row opens the existing character popover upward, aligned
to the composer inline start and constrained to the composer width. Keyboard
activation uses native button behavior. Closing the popover returns focus to
the context row.

Switching between native Lily and a character keeps the existing optimistic
selection, binding-version CAS, conflict reconciliation, and session-isolation
logic. This change only relocates and restyles the trigger; it does not change
binding semantics or historical messages.

The row is hidden when Character Worlds is unavailable. Failure therefore
continues to fall open to native Lily without leaving a dead control.

## DOM And State Ownership

- `src/renderer/index.html` owns the context button inside `#composer`, after
  composer-owned previews and before hidden inputs/popovers.
- `character-session-control.js` remains the sole owner of rendering and
  interaction state. It uses one visible trigger for popover positioning,
  `aria-expanded`, and focus return.
- `character-binding-updates.js` renders both native and character modes into
  the relocated control. It does not read global session state directly.
- `character-worlds.css` owns the compact footer-row styling and responsive
  truncation.

The message stack no longer contains character chrome. This prevents message
history reflow and keeps scrolling behavior independent from character state.

## Responsive And Accessibility Rules

- The row has a stable minimum height and does not wrap.
- Name text uses `min-width: 0`, ellipsis, and logical alignment.
- Indicator labels use compact localized copy and remain textual at narrow
  widths; the character name takes the remaining space and truncates first.
- The trigger is a real `button` with an accessible name, `aria-haspopup`,
  `aria-expanded`, and visible focus treatment.
- Color is not the only state signal: native/character names and persona/world
  labels remain textual.

## Verification

Automated renderer coverage must verify:

1. The role control is inside `#composer` and absent from the message stack.
2. There is only one visible character selector.
3. Native and character modes render the correct name and indicators.
4. The popover opens upward, traps focus as before, and restores focus to the
   context row when closed.
5. Session switches cannot paint a stale character into the new conversation.
6. Character Worlds unavailable mode hides the control and preserves native
   Lily behavior.
7. Desktop and narrow viewport screenshots have no overlap, wrapping, or
   message-scroll regression.

## Non-Goals

- No changes to character creation, persistence, binding, persona, world-book,
  or historical-message semantics.
- No new role-management surface or second popover.
- No changes to the live-task strip, prompt suggestions, attachments, queued
  messages, or scheduled-task controls beyond preserving their layout order.
