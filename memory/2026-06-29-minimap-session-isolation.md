# Conversation Minimap Session Isolation

## Debug Report

- Symptom: the current conversation can show right-side minimap ribs that belong
  to another conversation, making it look like messages are crossed between
  sessions.
- Root cause:
  1. The minimap rail is mounted on the shared `.session-messages-stack`, not
     inside an individual session panel. When switching to a conversation with
     too few messages for a minimap, the previous conversation's rail could
     remain visible.
  2. `renderRuntimeSession` lazy-loads `conversation-minimap.js`; a previous
     active session's async import callback could resolve after the user already
     switched sessions and still update the shared rail.
- Fix:
  - Clear shared-stack minimap rails immediately in `showSessionMessages`.
  - In the async minimap import callback, re-check that the session is still
    active, the panel is still connected, and the panel still belongs to that
    session before calling `updateMinimap`.
  - Make `updateMinimap` remove shared host rails when the new active panel has
    no `.messages` list or too few entries for a minimap.
- Evidence:
  - `npx electron scripts/test-renderer-import.cjs`
  - `node scripts/test-conversation-minimap.mjs`
  - `node scripts/test-scroll-geometry.mjs`

Important: minimap is a non-essential overlay. It must never be allowed to show
state from a hidden/background session. If isolation is uncertain, remove the
rail and degrade to normal scrolling.
