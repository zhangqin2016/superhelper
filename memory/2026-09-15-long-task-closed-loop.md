# Long-task closed loop (2026-09-14 audit → 2026-09-15 repairs)

Real-evidence audit of one day of a user's long task (messages.db events +
engine history): 12 turns, 1 completed (unverified), 7 interrupted, 2 stalled
after the 10-minute window, 2 failed; cross-turn continuation never engaged.
Verdict before repairs: admission + verification CLOSED, visibility /
continuation / recovery / terminal truth PARTIAL. Evidence and guards: the
gate rows `task-completion-integrity` and `live-file-authority`.

Root causes found and fixed:
- `live-file-history-guard.js` mutated the engine's LIVE message objects
  (prompt.ts does not clone), so its history placeholder replaced the body of
  not-yet-executed writes and was written to disk 6 times; the model then
  "re-wrote" files from the placeholder. Fix: sanitize on a copy, skip
  non-completed calls, self-explaining marker, refuse marker bodies.
- Zero-byte model responses were only caught by the 10-minute no-progress
  window. Fix: 90s first-response fuse → `MODEL_NO_RESPONSE` (retryable, two
  silent fresh-engine attempts), model marked silent in the picker
  (`model-availability.js`), and a bounded readiness watch
  (`model-recovery-watch.js` + `model-ping.js`) that dispatches the ONE parent
  closure when the provider is back instead of burning it immediately.
- Parent-closure eligibility excluded analysis/extraction/document tasks and
  zero-evidence (model-silent) failures; both admitted now.
- Step-budget exhaustion (160 steps) read as a clean completion; now a named
  stalled stop with a `budget_exhausted` handoff (`turn-step-budget.js`).
- Deleting a conversation left detached jobs running and wakes dropped
  silently; now fenced + stopped (`session-delete-cleanup.js`).
- `outcome_unknown`/`failed`/`unverified` lifecycles had no user-facing resume;
  `tasks:list-unfinished` / `tasks:resume` + task-center section.
- Busy-send dialog recommended nothing; steer (插话) is now the primary
  choice — the user had interrupted a long task 4× in 10 min to add requirements.

Not claimed: real-model acceptance of the new lanes, installed-client checks.
Kill switches: LILY_OPENCODE_FIRST_RESPONSE_TIMEOUT_MS=0, LILY_FIRST_RESPONSE_RETRY=0,
LILY_MODEL_RECOVERY_WATCH=0, LILY_STEP_BUDGET_GUARD=0, LILY_LIVE_FILE_GUARD=0.

## Deep re-audit (same day, after the seven repairs) → P0–P2

Data (all history, 2113 terminal turns): long turns (>10 min) 150, of which 31
stalled; 136 user interrupts, 67 followed by a new message within 30 s (users
interrupt to ADD, not to stop). Parent-closure continuations ever dispatched: 29 —
26 `acceptance_gap` re-dispatches of COMPLETED 10–70 s turns in 3-minute loops,
3 on AUTH_FAILED, 0 on a stalled turn. Checkpoint tables: 0 rows.

- P0 compaction boundary — the engine (upstream binary `opencode-ai@1.18.30`,
  not the vendored source, so no engine patches ship) creates the compaction
  user message WITHOUT `system`; every later step lost Lily's guidance and the
  turn's request/acceptance sat in the summarized head. Plugin
  `compaction-continuity.js` re-attaches guidance + a task anchor (request,
  acceptance, live todos; `compaction-anchor.js`, handoff file v2 via
  `compaction-memory-refresh.js`) once the summary exists — set in place on the
  engine's `info` object on purpose — restores pruned question/todo outputs on
  copies, feeds the anchor to the summarizer. Bare nudges now carry guidance.
- P1 continuation lane — `turn.parent_closure_recovery`/`turn.model_recovery`
  were not in `runtime-contract.json` (bus threw after restart; dropped live).
  Acceptance-gap re-dispatch is opt-in; parent-closure rounds need ≥3 new
  receipts (`minProgress`, lane-scoped — wake lane keeps 1/batch); refusals and
  budget stops write a durable record (`parent-closure-notice.js`) the renderer
  commits; step-budget copy is conditional on the gate.
- P2 work state — `turn-work-state.js` (files/commands/todos/last output)
  captured with the source, persisted in the recovery row, rendered in the
  closure prompt and the manual 继续 follow-up.
Kill switches: LILY_COMPACTION_CONTINUITY=0, LILY_CLOSURE_NOTICE=0,
LILY_ACCEPTANCE_GAP_CONTINUATION=1 (re-enable), LILY_CONTINUATION_MIN_PROGRESS.
Not done: engine-side summary quality floor and prune protection (binary), the
task-center unfinished list (user judged it meaningless; decision pending).

## Demo bug sweep (2026-09-15, five field reports)

1. Word drag-drop unstable — staging is async but `sendPrompt` snapshotted
   `pendingFiles` synchronously, so drop-then-Enter sent with no attachment and
   no warning. New `renderer/modules/attachment-staging.js` brackets every
   entry point (both drops, paste, paperclip) and the composer awaits it,
   bounded at 30 s. Extraction failures now report the extractor's own reason
   (`classifyExtractionResult` in document-translator.js) instead of "Command
   failed"; a path-less drag over 20 MB gets `fileErrors.DRAG_FILE_TOO_LARGE`.
2. Pasted path became an image — the composer's TEXT paste matched the plain
   clipboard text against the disk, staged the file and returned, discarding the
   characters. `extractClipboardFilePaths(clip, { includePlainText })` + the
   composer opts out and always inserts the text. Real file copies still attach
   through the OS file/filename/url formats.
3. "No access" while output/ had the result — a folder question routed to
   `content_extraction` (文件夹 matched the bare 文件 mention), whose required
   `source_content` can ONLY come from attachment/vision/document extraction, so
   `answer-evidence-finalizer` replaced the real analysis with a canned
   read-failure line and buffered the whole stream. Fixed at both layers:
   文件(?!夹|目录), and `hasExtractableContentSource` → with no source the turn
   requires `file_read` and is not a source-content contract. An actual unread
   attachment is still refused.
4/5. Right rail — MIN_RIBS 4→3; `clearStackMinimaps` now clears
   `lastRuntimeVisualSig` (a session switch left the rail deleted until the next
   message); the live render signature includes `committedMessages.length` (a
   steered question did not rebuild it); ribs are keyed by render key so two
   questions in one turn resolve to two bubbles; `conversationMessageKey` keeps
   the steer discriminator; a debounced window resize rebuilds the offsets.

Tests: test-content-source-gate, test-attachment-staging-race,
test-paste-keeps-text (gate attachment-content-grounding),
test-conversation-minimap-continuity (gate conversation-scroll-control).
Not verified: installed-client acceptance of any of the five.

### Second pass over the same five reports (gaps found by re-auditing)

- Routing that overrides the user text (authoring / web-system learning) applied
  to the RAW text, discarding everything send-preflight had extracted from the
  attachment. Preflight now returns `extractedContext` and the orchestrator
  re-applies it (`turn-preflight-context.js`).
- Every document failure surfaced as the same bare "已跳过文档解析" chip, which
  is what made Word attachments feel random. `document-failure-copy.js` states
  the cause (legacy .doc, runtime not ready, timeout, the extractor's reason).
  Legacy .doc→.docx conversion via the bundled LibreOffice pack is NOT built.
- An auto-rejected permission (plan mode, unattended internal turns) was silent;
  the engine turned it into a generic "Unable to read <path>" and the model told
  the user it had no access. `permission-denial-copy.js` now announces it.
- `findEquivalentMessageIndex` merged two user messages by text within 10 min
  (any distance when a timestamp was unparsable), so "继续" asked twice became
  one rib. Now blocked when both sides carry different turn ids; the fallback
  still reconciles the same message arriving from two sources.
- The rail's overflow column had `scrollbar-width: none`, hiding that older
  questions existed above the fold. Now a thin scrollbar.

### Third pass: adversarial review of the day's own fixes (9 real defects)

Found by re-auditing the new code plus a production-DB scan, all fixed:
1. `stepBudget` was never exported from `opencode-config-builder`, so the
   step-budget guard silently used the literal 160: a lowered
   LILY_OPENCODE_MAX_STEPS was never detected, a raised one stalled healthy
   turns at 160. Now exported AND read from `process.env` first (resolveLilyEnv
   needs the Electron app context, so it threw in every non-app path).
2. The new durable "未自动接续" record fired on model-silent failures, stacking a
   SECOND card that contradicted the failure copy ("Lily will continue once the
   model recovers" vs "out of scope for continuation"). Seen 3× in production.
   `noteDenied` now only fires on a plain stalled turn that explained nothing.
3. `sendPrompt` had no re-entrancy guard; the new staging await made a double
   Enter deterministic. Guard scoped to the draft window (released the moment
   `drafts.clear` takes it) so another conversation is never blocked.
4. `is-staging` was a dead class: the button stayed armed. Now actually disabled
   (stop stays clickable) with a style.
5. `closurePrepared?.ok` → `.prepared`: prepare returns ok:true/prepared:false on
   two fail-open paths, so the stall text promised a continuation that never came.
6. Platform records carry synthetic turn ids (`turn_closure_notice_*`,
   `turn_agent_binding_*`, `turn_task_pause_*`); the follow-up work-state lookup
   used `.at(-1).turnId` and resolved the CARD, losing the work state in exactly
   the flow the card advertises. `lastRealTurnId` in turn-preflight-context.js.
7. `resizeTargets` was a Set of fresh {panel, opts} objects → one entry per
   render, and one rebuild per entry on resize. Now a Map keyed by panel, and
   `teardownMinimap` deregisters.
8. Agent-binding notice validated `kind` against the whole copy table, so
   "brings"/"role"/... passed and then threw. Explicit allowlist.
9. A role write that fails AFTER the agent was released now returns
   `agentDeactivated` with the error instead of hiding the loss.
Also: parent-closure-notice localized (was zh-only while its siblings were not);
auto-deny answers the engine BEFORE notifying (fail-open ordering).
Still open (unproven): possible double-count of `usage.updated` steps
(step-finish + session.next.step.ended) — verify against a live engine.

### 黑屏 (black window) — 2026-09-15

The dark rectangle in the report is a window's `backgroundColor`, not a crash
render: both `src/main.js` and `src/main/collaboration-window.js` pinned
`#0f1119` (a dark-only leftover) while the app defaults to LIGHT
(`:root[data-theme="light"] --bg-body: #f8f9fb`), and neither used
`show: false` + `ready-to-show`. Any pre-paint moment — creation, reload, slow
boot, failed load — therefore showed a large dark rectangle.
Fix: `src/main/window-appearance.js` resolves the colour from the mirrored
theme (`app-preferences.json` `themeMode`, written by the renderer through
`app:set-theme-mode`) else `nativeTheme`; `showWhenPainted` reveals on
ready-to-show / did-finish-load / did-fail-load / a bounded timer and logs a
failed main-frame load instead of leaving a silent rectangle. Gate:
`test-window-appearance.mjs` under `im-detached-window`.
NOT yet established: which window the user actually saw and which link opened
it. If it recurs, the did-fail-load log line now names the URL and error code.

### Clicking a link in chat went nowhere — 2026-09-15

Root cause was the RENDERED address, not the window. GFM autolink literals trim
only ASCII trailing punctuation, so "服务跑在 http://127.0.0.1:5173，88 个工具"
linked `http://127.0.0.1:5173，88`. That string fails `new URL()` even
percent-encoded (the comma lands in the port), so `window-links.openExternalUrl`
rejected every form and, because `will-navigate` had already called
preventDefault, the click did nothing at all.
Two fixes: `markdown-link-trim.js` cuts a BARE autolink at the first
ideographic/full-width punctuation character (explicit [label](url), local-file
links, ASCII punctuation and genuine CJK paths untouched), and
`openableCandidates` in window-links.js tries the address as written, then
percent-encoded, then the longest parseable prefix, and finally hands the raw
string to the OS — a wrong address now reaches the browser and is allowed to
404 instead of being swallowed. Gate: `test-markdown-link-trim.mjs` under
`conversation-render-order`.

Follow-up (same report): "错误的地址也不能让 Lily 白屏". Two more changes —
`window-links.openableCandidates` tries the address as written, percent-encoded,
then the longest parseable prefix, and finally hands the raw string to the OS, so
a wrong address reaches the browser and is allowed to 404 instead of the click
being swallowed; and `window-blank-guard.js` replaces a blank window with a
self-contained escaped localized page naming the cause (load failed / renderer
gone / nothing painted within the watchdog), wired through `showWhenPainted`,
with the fallback itself guarded against looping.
