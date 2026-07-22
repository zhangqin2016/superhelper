# PERMISSION_DENIED Auto-Repair Chain (2026-07-22)

Customer field case (screenshot): EVERY message failed with "Request failed:
A system-level permission restriction interrupted the engine. Lily retries
automatically with a fresh engine session." — and the promised retry never
happened. Three independent defects compounded; all three are fixed.

## 1. The copy promised a retry that the policy never ran

`agent-runner.js` classified PERMISSION_DENIED with a message saying "Lily
retries automatically", but `opencode-session-failure-policy.js`'s
`isSafeReplayableModelFailure` list did not include it — so the transient
replay path never fired.

Fix: `isLocalPermissionFailure(classified)` (code === "PERMISSION_DENIED") is
now part of `isSafeReplayableModelFailure`, and the engine-rebuild decision
moved into the policy module as `shouldRebuildEngineForRetry({...})` (covers
stale managed config / oversized context / attachment fallback / legacy
resume / permission) and `isVisibleFailureRecoverable(classified, raw,
spawnOptions)`. One bounded silent replay against a FRESH engine session
(recycling rebuilds sandbox/handle state); a persistent restriction (macOS
TCC, Windows Controlled Folder Access) fails loud after that single retry.
Keeping the decision in the policy module also kept
`opencode-agent-session.js` under its 1997-line ratchet.

## 2. Second classification pass lost the error code

`_failTurn` → `notifyRunnerError` → `turn-orchestrator._handleError` received
the already-sanitized MESSAGE (not the raw error) and re-classified it. Nine
patterns didn't match their own message text, so the code was lost (fell to
generic ENGINE_ERROR) and the message gained a second "Request failed: "
prefix — the doubled prefix in the screenshot.

Fix in `agent-runner.js`:
- every pattern's `test` now also matches its own message (self-matching);
- `classifyAssistantError` strips a leading `request failed:` before matching;
- `sanitizeError` returns an already-wrapped message unchanged (fixed point —
  no double prefix).

Idempotency is now pinned in `scripts/test-turn-error-classify.mjs`:
`sanitize(sanitize(x)) === sanitize(x)` and re-classifying a sanitized
message keeps the same code, for a representative sample of every class.

**Rule for future patterns: a classification pattern MUST match its own
message — classification results flow back through the classifier.**

## 3. Diagnostics were blind to the actual root cause

The customer's most likely real cause is macOS TCC not granting
Documents/Desktop access (or Windows Controlled Folder Access) — the engine
gets EPERM on every file op while every shallow check stays green ("diagnostics
normal but nothing works").

Fix: `workspaceAccessCheck` in `support-diagnostics-deep-checks.js` — real
read + real write + real delete probe against the workspace AND userData.
Only EPERM/EACCES/EROFS convict (anything else fails open); the error detail
carries platform-specific guidance (macOS 隐私与安全性 → 文件和文件夹 /
完全磁盘访问权限; Windows 安全中心 → 勒索软件防护). Wired into
`support-diagnostics.js` and `ipc-handlers.js` (`support:run-diagnostics`
now passes the active workspace path).

Tests: `scripts/test-support-diagnostics.mjs` (probe ok / skip on missing /
error+guidance on chmod 0555, POSIX only) and
`scripts/test-opencode-session-policies.mjs` (policy list membership).
