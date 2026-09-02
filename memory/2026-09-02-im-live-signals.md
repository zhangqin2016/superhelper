# IM live signals: typing, read receipts, reactions (2026-09-02)

## The finding that mattered most

I told the user these three "need server/WS protocol work". **Two of them did
not.** Check before proposing server work here:

| Feature | Server before this change | Client before |
|---|---|---|
| typing / presence | **already complete** — `realtime-gateway.js` validates frames, caps TTL at 30s, authorizes against conversation membership, fans out via `ephemeralRecipients` | nothing; `realtime-client.js` handled ONLY `sync.available` and dropped every other frame |
| read receipt | **already complete** — the `conversation.read` command already attached `recipientUserIds`, so peers already received it | `conversation-hydration.js` ingested only the account's OWN read event and explicitly dropped everyone else's |
| reactions | absent | absent |

The desktop already held the websocket (`realtime-client.js`, wired in
`service.js` with `realtimeEnabled = true`). The only genuine server additions
were **one field** (the outbound ephemeral frame did not name its origin, so a
recipient could not tell WHO was typing — fine for 1:1, useless for a group)
and the whole reaction path.

## Invariants that are load-bearing

**Typing is a hint.** `ephemeral-presence.js` is a self-expiring registry with
NO timers — entries are pruned on read, so a crashed or disconnected peer stops
showing as typing by itself and there is nothing to leak. Bounded per
conversation and per user. A far-future `expiresAt` is clamped to the cap, so a
hostile peer cannot pin an indicator open. Missed frame → nobody typing.

**A double tick is a claim about other people**, so it means read by EVERY known
peer: the slowest peer holds the watermark and a group never claims read-by-all
from its fastest member. Monotonic, so a replayed sync page cannot walk a tick
backwards. **Unknown membership yields NO tick** — filling it in from whoever
happened to report would over-claim. (I wrote that rule in the test docstring
and then violated it in the first implementation; the test caught it.)

**A reaction is NOT a message revision.** Own table on both sides, one row per
(message, user, emoji), and NO `expectedRevision` anywhere in its path. If a
reaction ever bumped `messages.revision` it would read as an edit to reply
snapshots and to edit/revoke conflict detection. Consequences:
- the outbox intent branches away from the edit/revoke normalization, which
  requires a positive `expectedRevision`;
- `committedView` needs its own branch — a reaction receipt has no `message`
  projection, so its commit evidence is the event id plus the server echoing
  the exact (messageId, emoji, active) it applied. Borrowing the create/edit
  receipt shape would have meant inventing evidence.

Emoji are bounded (≤8 code points, ≤32 chars, no whitespace) but deliberately
NOT allowlisted, on both sides, so new emoji need no deploy. Chip tie-break is
by CODE POINT, not `localeCompare`: emoji collation is locale-dependent and the
order must be identical for every user.

Forward compatibility is why adding `message.reaction` is safe: `contracts.js`
promises a newer event can be recorded and skipped by an older client while it
still advances its cursor, and the client has no event-type allowlist.

## Mistakes worth not repeating

- Three separate `python str.replace` edits landed **silently as no-ops** because
  I omitted the assert. Always assert the match count in this repo.
- I inserted code that read `reactionList` **before its declaration**, and
  earlier appended the meta line to a bubble **before the body existed**. Same
  class: inserting at a point where the dependency does not exist yet. Only the
  Electron DOM test caught it.
- `service.js` (498) and `server .../messages.js` (495) were both ~2 lines under
  the 500 hotspot threshold, so ANY feature trips the boundary gate. Extracted
  `reaction-command.js` (client) and `message-reaction-command.js` (server)
  rather than relaxing it; the two collaboration files are now tracked hotspots.

Migrations: client v17 `conversation_peer_reads`, v18 `message_reactions`;
server `042_collaboration_message_reactions.sql`.

Guard: `[gate: im-live-signals]`.
