# Renderer Streaming & History Window (2026-07-21)

Three renderer-pipeline fixes from the session-rendering architecture audit
("站在巨人肩膀上" review: marked/DOMPurify/morphdom selection is healthy; the
gaps were ours).

## 1. Math preprocessing polluted code blocks

`renderMathBlocks` ran regex replacements on the raw markdown BEFORE marked,
blind to code fences and inline spans: `$x$` inside a ``` fence became KaTeX
HTML that marked then escaped into garbled text.

Fix: `src/renderer/modules/markdown-math-segments.js` (`mapPlainSegments`) —
splits source into fenced-code / inline-code / plain segments (exact
recombination) and applies the transform to plain segments only. Used by
`renderMathBlocks` in `markdown.js`. The math regexes themselves are unchanged.

## 2. Streaming render was O(n²)

Every 120ms tick re-parsed the ENTIRE accumulated answer (marked + DOMPurify
over hundreds of KB); morphdom saved DOM writes but not parsing.

Fix: `src/renderer/modules/markdown-stream-blocks.js` —
`stableStreamPrefix(text)` finds the longest prefix ending at a blank-line
block boundary with balanced code fences and closed `$$` math (single O(n)
line scan); `renderStreamBlocks` caches that prefix's sanitized HTML per
element (WeakMap) and only re-parses the growing tail. Concatenation at a
block boundary keeps the two sanitized fragments safe to join. Fail-open: no
stable boundary or a prefix mismatch parses the whole text, exactly as before.

Known accepted edge: a setext heading split across the boundary renders as
plain text mid-stream (self-heals on the next tick / final render).

## 3. History window: remembered range + bounded DOM

Old: `committedMessagesForRender` was binary — last-80 window by default, or
EVERYTHING with `preserveScroll` (unbounded DOM as the user loads older
pages). Session switch/official-history reconcile rebuilt to 80, losing the
loaded range.

New semantics (`message-committed-render-model.js`):

- Rendered range is always a **suffix** of the ordered committed list, so it
  is fully described by one number, remembered per session
  (`committedWindowCounts`, capped at `COMMITTED_MAX_WINDOW = 240`).
- Explicit `windowCount` (loadOlder passes `merged.length`) is honored in
  full — user-requested history is never silently capped.
- Default count = `max(defaultRule, remembered)` — the remembered window can
  grow but never shrinks a small conversation.
- `resetCommittedWindowCount` is called on bottom-anchored official refreshes:
  bottom-readers snap back to the 80 tail; scrolled-up readers keep range.
- Eviction (`message-render-keys.js`): articles carry `data-message-key`;
  bottom-anchored renders (`allowEvict`) remove DOM nodes + keys outside the
  window. Detached (scrolled-up) renders never evict, so the user's reading
  position is never yanked mid-turn.
- `preserveScroll` no longer affects the window size — it only bypasses
  chunked append (callers manage the scroll anchor).

Not done (deliberately): bidirectional virtualization (re-mounting evicted
top/bottom on scroll). Evicted history is re-fetched via the existing
load-older paging when the user scrolls up again.

## Ratchet notes

`markdown.js` is at its 863-line cap and `message.js` at 949 — both exactly at
budget after these changes. New logic went into the three focused modules
above; further growth must extract, not append.
