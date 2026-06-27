# Steer (插话) — implementation plan

Add a THIRD send-while-busy option besides today's two (interrupt-and-send, queue):
**steer** — inject the message into the *running* turn so the agent picks it up at
the next step, without aborting and without waiting for the whole turn to end.
This is the Claude Code `/btw` / steering behavior.

## Verified engine fact (static source trace, 2026-06)
OpenCode natively steers. Sending a prompt to a busy session:
- `SessionPrompt.prompt` appends the user message first (`createUserMessage`,
  `prompt.ts:1104`), then drives `loop()`.
- `loop → ensureRunning(work)` with state "Running" returns `awaitDone(existing run)`
  — does NOT reject, abort, or start a new run (`effect/runner.ts:120-122`).
- The running `runLoop` is `while(true)` and re-reads `MessageV2.latest(msgs)` every
  step (`prompt.ts:1126`), so the just-appended message enters the model context at
  the next step.
- `BusyError`/`assertNotBusy` is the **shell** path (`startShell`), NOT prompt.

So at the engine layer, steer == "call promptAsync WITHOUT aborting first." The work
is in our app layers, which today assume one user message per turn.

> ⚠️ Static-verified, NOT live-verified (opencode auth blocker). The two integration
> risks below MUST be confirmed at build time before flipping the flag on.

## Design principles (Rule 13 / CAPABILITY-GATE)
- **Ships behind a flag** `LILY_ENABLE_STEER` (default OFF) until build-verified.
- **Fail-open to baseline:** any steer failure (engine rejects, lifecycle can't
  attach, flag off) → fall back to **queue** (today's behavior). Worst case == today.
- **Closed-loop guard + failure-mode test** required; register vector in the gate doc.

## Layered changes

### 1. Engine wrapper — `src/main/opencode-agent-session.js`
- New `async steer(text, files)`:
  - Precondition `this.busy === true`; else return `{ ok:false, reason:"not-busy" }`
    (caller sends normally).
  - Call `this._server.sendPrompt({ text, files })` **without** `abort()` and
    **without** resetting turn state (no new `turnId`, no clearing
    `collectedOutput`/`_eventState`/`tools`).
  - Re-arm the no-progress timer (it's progress). Return `{ ok:true }`.
  - On any throw → `{ ok:false, reason:"engine-rejected" }` (caller falls back).
- Do NOT change `busy`/turn-settle logic — the ongoing turn keeps owning the SSE.

### 2. Server manager — `src/main/runtime/opencode-server-manager.js`
- Reuse `sendPrompt` as-is (it already does `promptAsync`). Optionally tag the body
  `delivery:"steer"` for telemetry parity with the engine schema. No new transport.

### 3. Turn orchestrator — `src/main/turn-orchestrator.js`
- New branch in the busy path of `sendUserMessage` when `opts.mode === "steer"`:
  - Do NOT call `_startTurn` (no turn reset).
  - Commit the steer text as a user message tied to the **current** `state.turnId`
    (transcript ordering preserved); emit `user.committed` so the UI shows it mid-turn.
  - Call `runner.session.steer(text, files)`.
  - If steer `ok` → emit a `turn.steered` event (telemetry: `state.steerCount++`).
  - If steer `!ok` → **fall back to queue** (existing `state.queue.push` path) and
    return `{ ok:true, queued:true, steerFellBack:true }`.
- Guard: if `!busy` when the call lands (race) → treat as a normal send.

### 4. IPC — `src/main/ipc-assistant.js` + `src/preload.js`
- New handler `assistant:steer` → orchestrator `sendUserMessage(..., { mode:"steer" })`.
- preload: `steerMessage: (text, files, sessionId, displayFiles) => invoke("assistant:steer", …)`.

### 5. Composer — `src/renderer/modules/composer.js`
- Busy `chooseDialog`: add a third option between queue and interrupt:
  `稍后发送 (queue)` · **`插话(补充给当前任务) (steer)`** · `停止并发送 (interrupt, danger)`.
- On `steer` → `window.assistantClient.steerMessage(...)`.
- Result handling: `steered` → subtle toast "已补充给当前任务"; `steerFellBack` →
  toast "当前任务无法插话，已排队".
- Gate the 3rd option on a renderer-visible flag mirror of `LILY_ENABLE_STEER`.

### 6. Mid-turn user bubble (highest UI risk)
`src/renderer/modules/message.js`, `turn-view-renderer.js`, `session-runtime-store.js`
- Today a turn = one user msg + assistant articles. Steer adds a **second user
  bubble inside an ongoing turn**.
- `session-runtime-store`: handle a `user.committed` arriving mid-live-turn WITHOUT
  resetting `liveTurn` — append it to the live timeline in order.
- `message.js`/`turn-view-renderer`: render the steer user bubble inline (with a small
  「插话」badge) positioned after the assistant content produced so far.
- MVP fallback if interleaving is too invasive: render the steer bubble with the badge
  at the tail of the current user-message group; refine ordering later.

### 7. i18n — 3 locales (`zh-CN`, `en`, `ar`)
- `composer.busyChoiceSteer` — "插话(补充给当前任务)" / "Add to current task" / AR
- `toast.messageSteered` — "已补充给当前任务" / "Added to the current task" / AR
- `toast.steerFellBackToQueue` — "当前任务无法插话，已排队" / "Couldn't steer — queued" / AR
- `message.steerBadge` — "插话" / "Steered" / AR

### 8. Capability gate — `CAPABILITY-GATE.md` + tests
- `scripts/test-turn-orchestrator-steer.mjs`:
  - steer when busy + engine ok → no new `turnId`, user msg committed to current turn,
    `turn.steered` emitted.
  - **failure-mode:** steer when engine returns `!ok` → falls back to `queued:true`
    (degrades to today's behavior).
  - steer when idle (race) → normal send.
- Register vector: "send-while-busy steer regressed to abort/loss" → this test.

## File change list
| File | Change |
|---|---|
| `src/main/opencode-agent-session.js` | new `steer()` (no-reset prompt, fail-open) |
| `src/main/runtime/opencode-server-manager.js` | reuse `sendPrompt`; optional steer delivery tag |
| `src/main/turn-orchestrator.js` | steer branch in busy path + queue fallback + `turn.steered` |
| `src/main/ipc-assistant.js` | `assistant:steer` handler |
| `src/preload.js` | `steerMessage` bridge |
| `src/renderer/modules/composer.js` | 3rd dialog option + result handling + flag |
| `src/renderer/modules/session-runtime-store.js` | mid-turn `user.committed` without live-turn reset |
| `src/renderer/modules/message.js` | render steer user bubble + badge |
| `src/renderer/modules/turn-view-renderer.js` | inline steer bubble ordering |
| `src/renderer/i18n/locales/{zh-CN,en,ar}.json` | 4 keys ×3 |
| `scripts/test-turn-orchestrator-steer.mjs` | new closed-loop + failure-mode guard |
| `CAPABILITY-GATE.md` | register the steer vector |

## Build-time live verification (the deferred spike)
Before flipping `LILY_ENABLE_STEER` on, confirm with a real engine + key:
1. **promptAsync on a busy shared-server session steers** (message picked up next
   step) rather than rejecting or running concurrently.
2. **Second user message in one turn** flows correctly through reducer + transcript
   ordering + renders as an inline bubble; SSE for the steered work attributes to the
   same turn.
3. Loop-between-steps timing: steer still picked up (expected: yes — read from DB each
   step).
If any fails → keep flag OFF; the queue fallback means zero regression.

## Phasing
- **P1 (backend, dark):** wrapper `steer()` + orchestrator branch + IPC + tests. Flag OFF. ✅ DONE
- **P2 (frontend):** 3rd option + mid-turn bubble + i18n. Flag OFF. ✅ DONE
- **P3 (live verify):** on by default per product call; confirm the 3 items below on
  a real build and keep `LILY_ENABLE_STEER=0` ready as the instant rollback. ⏳ PENDING

## Implementation status (as built)
Flag: **ON by default**; `LILY_ENABLE_STEER=0` is the instant kill-switch back to the
two-option (queue / interrupt) dialog. All paths fail-open to queue.
- `opencode-agent-session.js` — `steer(payload)`: no-reset prompt into the running
  turn; re-arms the no-progress watchdog; returns false → caller queues.
- `turn-orchestrator.js` — `_trySteer` (steer only after the engine accepts, then
  commit + `user.committed{steer,steerSeq}` + `turn.steered`); busy-path branch with
  queue fallback (`steerFellBack`). `turn.steered` registered in `runtime-event-schema.js`.
- `transcript-store.js` — `commitUserMessage` persists `steer`/`steerSeq`.
- `ipc-assistant.js` — `assistant:steer` + `assistant:feature-flags`. `preload.js` —
  `steerMessage`, `getFeatureFlags`.
- Renderer — `composer.js` (3rd dialog option gated on the flag + steered/fell-back
  toasts), `session-runtime-store.js` (steer-aware `committedMessageKey` so a 2nd
  same-turn user bubble doesn't overwrite the 1st; carries steer fields),
  `message.js` + `runtime-chat.css` (「插话」badge, pure theme tokens).
- i18n ×3: `composer.busyChoiceSteer`, `toast.messageSteered`,
  `toast.steerFellBackToQueue`, `message.steerBadge`.
- Guard: `scripts/test-turn-orchestrator-steer.mjs` (success / engine-reject→queue /
  flag-off→queue). Registered in `CAPABILITY-GATE.md`.

### MVP limitations (confirm/upgrade at P3)
1. **Live engine steer is static-verified only** — P3 spike must confirm a busy-session
   `promptAsync` injects (vs rejects/concurrent).
2. **Bubble placement:** the steer bubble renders right after the turn's original user
   bubble (role-ordered), not interleaved at the exact assistant step where the user
   interjected. Acceptable for MVP; refine if needed.
3. **Reload distinctness depends on the store persisting `steer`/`steerSeq`** through
   `pushMessageTo` → `getSessionConversation`; verify the SQLite message-store carries
   these extras, else multiple same-turn user messages collapse on reload.
