# Internal Turn Permission Hang (2026-07-22)

Field case: a document-delivery re-check turn ended with "本轮没有形成完整最终回答"
even though the PDF had been generated and delivered. Forensics on the local DBs
(`messages.db` turn_inputs/runtime_events + `opencode-shared/opencode.db` parts):

- The stalled turn was an INTERNAL `[系统文档交付续检]` continuation, terminal
  type `turn.stalled`.
- Its last tool call — `rm -rf <workspace>/.lily-work/rendered-pages` cleanup —
  sat in status=error "Tool execution aborted" for **exactly 1200s**.
- runtime_events: `permission.requested` at 16:58:14, resolved `cancelled:true`
  at 17:18:14 — the four earlier permission requests in the same session were
  auto-allowed within seconds.

Mechanism: `rm -rf` matched the destructive-bash list → verdict "ask" → a
permission card was raised for a turn nobody was watching (internal turns are
unattended) → the active-tool lease (`ACTIVE_TOOL_LEASE_MS` in
opencode-agent-session.js, 20min) expired → watchdog force-ended the turn →
user saw a stall summary after the deliverable was already fine. The user saw
nothing but "思考中" for 20 minutes.

## Fixes (three, all shipped together)

**A. Unattended turns never wait on a card.** `turn-orchestrator` marks rescue /
delivery-recovery turns `nonInteractive` in the engine payload;
`opencode-agent-session` threads it into `decidePermission`; the policy wrapper
in `opencode-permission-policy.js` maps `ask → deny` when `nonInteractive`.
Deny is fail-safe: an internal turn never NEEDS a destructive op to finish its
report — the engine gets an immediate "denied" and adapts (skips the cleanup).

**B. Stall copy tells the truth.** `buildIncompleteTurnSummary`
(turn-error-classify.js) now leads with "本轮中止时仍在等待你确认授权或回复…"
when `state.pendingPermissions/pendingQuestions` is non-empty, instead of only
blaming unfinished tools. The state object already carried those maps; the
summary just never looked.

**C. Catastrophic matching is precise.** The real reason a card appeared at all:
`CATASTROPHIC_BASH` glob `"rm -rf /*"` compiles to prefix `^rm -rf /.*`, which
matches ANY absolute-path `rm -rf` — so even full-autonomy sessions got
permission cards for ordinary cleanups like `rm -rf /Users/x/build`. Replaced
host-side with `ROOT_HOME_WIPE_RE` (exact root/home targets only: `/`, `~`,
`$HOME`, `${HOME}`, optional trailing `*` / `--no-preserve-root`, both flag
orders, matched per `&&`/`||`/`;` segment). Serve-side still over-asks (harmless:
the host auto-answers), and the host remains the precise backstop. Full mode now
auto-allows `rm -rf /abs/path` while `rm -rf /` still surfaces a card — even in
full, and denies outright on unattended turns.

Tests: `scripts/test-permission-policy-noninteractive.mjs` (new, 15 assertions:
ask baseline / nonInteractive→deny / full untouched / catastrophic precision) and
new pending-permission assertions in `scripts/test-turn-error-classify.mjs`.

## Open question (NOT resolved, do not assume)

Why the field session ran in "ask" mode at all when the user believed 全自主 was
on is unverified — sessions-index.json entries are sparse (no permissionModeId)
and settings.json had no hit. With fix C the distinction matters less (absolute
rm -rf auto-allows in full), but if a user reports cards under 全自主 for
non-catastrophic destructive ops, check the session-level permissionModeId write
path in session-manager (permission-settings.js:49-52 comments mention a stale
session-override bug class).
