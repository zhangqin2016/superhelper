# False stall: the unfinished-todo gate (2026-09-02)

Field case: a 36-minute IM-refactor turn ("全部实施。不要中断 安排长任务", 278 tool
calls) delivered a complete 11-item answer and was reported to the user as
`turn.stalled` under "本轮没有形成完整最终回答". The user reasonably read it as a
failed task and asked the model to analyse its own failure — which it then did on
a false premise.

## Forensics (messages.db + opencode-shared/opencode.db)

The turn ended CLEANLY at 01:24:01: `stopReason: "stop"`, `session.idle`,
`assistant.final` with the full 5851-char answer, `code: 0`. No watchdog fired —
`TURN_WATCHDOG_MS` defaults to 0 and the 600s no-progress window never elapsed
(thousands of progress events per minute right up to the end).

The `stalled` flag was fabricated by `_continueUnfinishedTodosBeforeCompletion`
(`opencode-agent-session.js`). Final todo state: 11 completed, 2 pending, both
explicitly parked on a user decision ("需定框架方向" / "需定协议").

`part` rows in opencode.db show **7 injected `Task continuity check` prompts** in
that one turn:

```
01:11:16 0/11   01:18:41 10/12 (no change)   01:22:17 11/13 (no change)
01:14:16 9/11   01:21:22 11/13 (list grew)   01:23:14 11/13 (no change)
01:17:11 10/12 (list grew, unfinished still 2)
```

The unfinished count was pinned at 2 from 01:17 on. The 3-attempt cap never bit
because `_rememberLatestTodos` reset the counter on ANY todo-list signature
change — every re-plan/rename refilled the budget. That is CAPABILITY-GATE rule 3
inverted: it bounded *effort*, not *confirmed no-progress*.

Install-wide numbers at the time: 21 stalled turns, **13 of them carried ≥200
chars of real answer above the banner**; stall rate by duration 0% (<1m) → 11%
(5–15m) → 17% (>30m). Four sessions had runaway nudge counts (5/6/7/10).

## Fixes

1. `opencode-todo-completion-policy.js` — `todoContinuationDecision()` and
   `buildTodoGiveUpPayload()`; `MAX_ATTEMPTS` is now 2 CONSECUTIVE no-progress
   nudges plus an absolute `MAX_TOTAL_ATTEMPTS = 6` per turn.
2. `_rememberLatestTodos` refills the budget only when the unfinished set
   actually SHRINKS (`_todoGate = { attempts, total, best }`).
3. Giving up on a turn that produced output settles NORMALLY (no `stalled`) with
   `unfinishedTodoCount` and one appended line, `本轮还有 N 项待办没有标记完成：…`.
   Only an answerless turn keeps the stalled terminal.
4. `turn-error-classify.js` — `buildIncompleteTurnSummary(state, payload,
   { hasAnswer })`. With an answer it never prints "本轮没有形成完整最终回答",
   drops the successful-tool dump, and skips the failure framing.
   `collectToolCompletionSnapshot` also separates `recovered` failures (a later
   same-tool success) from real ones — the field summary blamed a
   `LILY_LIVE_FILE_READ_REQUIRED` edit rejection from 28 minutes earlier that the
   turn had recovered from, out of 278 calls.

Guard: `[gate: turn-completion-honesty]` in CAPABILITY-GATE.md →
`test-opencode-agent-session.mjs` (field scenario end-to-end),
`test-opencode-session-policies.mjs`, `test-turn-error-classify.mjs`,
`test-turn-orchestrator.mjs`. Kill switch `LILY_DISABLE_TODO_COMPLETION_GATE=1`
still restores the ungated baseline.

## Follow-up: one shared turn re-entry budget

The same audit found the structural version of this bug. THREE gates push a
cleanly-ended turn back into the model — required-tool persistence (≤2), the
todo gate, and the Pillar 3-B deliverable gate (≤1). Each is individually
bounded; nothing bounded their SUM, and they can hand off to each other, so a
long turn could be re-entered up to nine times.

`turn-continuation-budget.js` gives all three ONE per-turn budget (default 4,
`LILY_TURN_CONTINUATION_BUDGET` overrides, `0` restores per-gate-only bounds),
and records which gate spent it. Per-turn gate state is consolidated into
`session._turnGates` (`{ continuations, byGate, deliverableGated, todo }`),
created by `createTurnGateState()`.

Exhausting the shared budget takes each gate's own GRACEFUL path — this is the
part to preserve if it is ever touched:

- todo gate → settles with the answer + the unfinished-todo line;
- deliverable gate → simply does not fire (it is advisory);
- required-tool gate → still emits `CHARACTER_DRAFT_PERSISTENCE_FAILED`. It must
  NEVER degrade to silent success: the check exists so a turn cannot claim a
  character was saved when the persistence tool never confirmed.

Guard: `[gate: turn-continuation-budget]`. The e2e case in
`test-opencode-agent-session.mjs` uses a todo list whose unfinished set SHRINKS
every round — the todo gate keeps refilling its own budget, so only the shared
cap can stop it — and asserts the kill switch restores the old behaviour.

## Not resolved

Failure-recovery re-prompts (transient replay, empty-completion replay,
attachment fallback) are deliberately OUTSIDE this budget — they retry a turn
that errored rather than re-enter one that finished. If those ever start
compounding on long turns, they need their own accounting, not this one.
