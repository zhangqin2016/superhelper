# User-blocked time is not latency (2026-09-02)

Field case: "为什么 Lily 不能像 Claude Code CLI 一样丝滑". Screenshot showed
`✓ question  已完成 · 507.8s`. Forensics on turn `turn_b4f67f5c` (session
`d11645d0`): the card was raised 09:43:22 and answered 09:51:49 — **507.8s was
the user's own reading/deciding time, displayed as Lily's**.

The engine was never slow. Four DISPLAY paths lied.

## 1. Human wait billed as tool latency

`turn-view-status.js buildToolDurationSuffix` computed `ts - startTs` for every
tool. The question entry had `startTs` = card raised, `ts` = answer received.
Same class of bug hit the 2026-07-22 `rm -rf` permission card: 1200s of "tool
latency" that was really an unattended card.

Fix: `turn-user-wait.js` attributes it. The turn state machine ALREADY knew —
`phase = "awaiting_user"` plus the pending permission/question/hook maps — so
this only accounts for it: one open interval per turn (concurrent cards share
it), credited as `entry.waitMs` bounded by the overlap with each tool's own
lifetime. Hooked at the existing `awaiting_user` transitions in
`turn-runtime-event-router.js`; `upsertTimelineTool` credits a tool that reaches
a terminal status while a card is still open, so BOTH event orders
(resolve-first / tool-done-first) credit exactly once.

Renderer subtracts it: `· 5.0s · 等你 20m` instead of `· 1205.0s`.
i18n `timeline.toolAwaitingYou` (zh-CN/en/ar). `formatWaitDuration` FLOORS to
match `formatDuration` in the liveness module — the live panel and the sealed
card must not disagree by a second.

No `turn-terminal-finalizer` hook is needed: its existing forced-terminal loop
(`tool.status = done/failed` → `upsertTimelineTool`) already credits suspended
tools through the running→terminal transition.

## 2. The heartbeat claimed to be working while blocked on the user

For the whole 8m27s the panel repeated, verbatim from `runtime_events`:

```
09:47:15  question 正在运行 · 已运行 3m 59s · 最近活动 3m 53s 前
09:51:45  question 正在运行 · 已运行 8m 29s · 最近活动 8m 23s 前
```

`forceEndTurn` DID check `hasPendingUserInput()` (the watchdog correctly pauses);
`emitLongWaitNotice` / `emitGenericToolProgressNotice` did not. Fixed at the
single choke point `emitGenericToolProgressNotice`, which now emits a distinct
`awaitingUser` code sharing one replace slot with `toolProgress`. Needs
`pendingUserInputSince` in the session's `getState()` — derived by
`earliestPendingRequestAt` from `requestedAt` now stamped on each pending card.
"Waiting on you" also outranks the `hasKnownSubagents()` early return: silence
during an open card reads as a hang.

## 3. Replaceable notices desynced position from timestamp

`appendTimelineNotice`'s replace branch wrote the NEW `ts` back at the OLD index,
so a 45s heartbeat first seen at 13:40 sat at timeline index 1 stamped 13:57.
Now it keeps its anchor `ts` and records `updatedAt`.

NOTE the invariant that actually holds: `ts` on a streaming block is its LAST
update, so the timeline is NOT globally monotonic in `ts` by design. The property
to assert is monotonicity of CREATION time (`startTs ?? ts`).

## 4. Persisted question options became "[object]"

`store/runtime-event-persistence.js compactValue` returned the literal
`"[object]"` at `depth >= 3`. Option objects `{label, description}` sit at depth
4 under `input.questions[].options[]`, so every stored question event kept
`options: ["[object]","[object]","[object]"]`. Live UI and the message envelope
were fine — this hit event replay (compaction index, mobile projection). Now the
depth cap keeps SCALAR LEAVES (≤8 keys, strings ≤300, thumbnail/base64 still
stripped); an all-nested leaf still yields the old marker.

## What was NOT a defect (checked, do not "fix" again)

- **The question card rendering ABOVE the answer prose is BY DESIGN.**
  `turn-article-layout.js` comment: "process (work) above, answer below". The
  renderer does not sort the timeline anywhere — it renders insertion order.
- **`hasPendingUserInput()` is not always-true.** The session passes
  `pendingUserInput: Boolean(size || size)`, a real boolean — not the Maps
  (an empty Map would be truthy and would have killed the watchdog entirely).
- **思考了 49 秒** is model reasoning latency (deepseek-v4-pro; 1250 thinking
  deltas / 3m18s in that turn), not a Lily path.

## 5. Silent provider retries (fixed in the same pass)

`opencode serve` logged `message="stream error" … error.error="AI_APICallError:
Server Overloaded"` to stderr; the host only `log.warn`ed it, so a 4s/7s backoff
read as a hang. `agent-runner.js`'s overload classification only fires once the
error becomes a TERMINAL failure, so retries that eventually succeeded narrated
nothing.

`runtime/opencode-serve-diagnostics.js` parses the logfmt stderr;
`opencode-shared-server` re-publishes it on a dedicated **`diagnostic`
EventEmitter channel** — NOT as a synthetic turn event. That was the second
design and the right one: a diagnostic is not turn content, and riding the turn
event stream also cost a guard branch inside `_handleEvent`. ServerManager routes
it with `diagnosticBelongsToSession` (exact session-id match — one shared serve
hosts many sessions), the session wires it in one line next to
`server.on("event")`, and liveness narrates it as an `engineRetry` notice naming
the model service, the upstream reason and the attempt count.

It shares the heartbeat's replace slot (`replacesCode: "genericToolProgress"`),
so real progress clears it — no stale "retrying" line, and no extra code to
clear it.

NARROW BY DESIGN: only the transient family (overload / rate-limit / quota / 5xx
/ timeout / socket) becomes "retrying". A bad key or unknown model must keep
reaching the normal terminal-failure path — softening a broken config into a
reassuring progress line would be worse than silence.

Guards: `[gate: user-wait-attribution]`, `[gate: persisted-event-fidelity]`,
`[gate: engine-retry-visibility]`.
