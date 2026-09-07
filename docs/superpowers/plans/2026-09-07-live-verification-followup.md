# Live verification follow-up

Goal: close the two findings approved for repair by the user: an actual exit-report test invocation loses its evidence, and summary UI leaks internal status codes.

Architecture: retain the bounded receipt classifier. Recognize only a literal known verifier followed immediately by the exact POSIX `echo "EXIT_CODE=$?"` suffix. Require a completed, successful outer process, a non-truncated output with its final exit-code line, and inner exit 0. Never evaluate shell text, infer success from PASS prose, accept a literal printed zero or replay an operation. Other compound programs remain unverified. Display localized task and verification labels with safe fallbacks in all three existing locales. Encourage independent final validation calls through existing guidance; do not broaden permissions.

Rejected alternatives: accepting all shell exit-0 commands hides failures; automatically rerunning extracted commands duplicates side effects. A generic shell interpreter is outside this surgical repair.

- [x] Reproduce both failures with `test-task-verification-shell.mjs` (real local shell processes) and `test-task-summary-localization.mjs` (actual locale dictionaries).
- [x] Implement strict wrapper receipt and localized status mapping.
- [x] Verify failure, spoofed/missing/truncated output, pending execution and unknown status fallbacks.
- [x] Run completion/policy/summary/i18n/architecture gates, then verify real-client rendering where the running runtime can be safely refreshed.

Implementation record: the native wrapper receipt uses the inner status, not outer echo success. Real shell tests exercise passing/failing subprocesses and feed their results through the actual OpenCode reducer. Comments swallowing the suffix, fake literal zeros, previous fake markers, missing/truncated output and unfinished tools are excluded. Status and verification maps have null prototypes, so even `constructor` or `__proto__` receive localized safe fallback text. Production base and per-turn guidance now request independent final checks; static guide version advanced to 25.

Real-client UI verification: the idle test window was reloaded and its existing task summary expanded. It displayed `已交付 · 证据 9 · 风险 0 · 待验证`, replacing the raw English enums while preserving its recorded assessment. The old stored record was not retroactively promoted. No app-wide quit/restart was forced; new main-process receipt behavior and persona require a fresh runtime. This turn verifies that behavior with real local shell results through the production reducer, not with a restarted full-client model run.

Independent read-only review found no important issues in the scoped shell/locale fix. Final gate results are recorded in the conversation; no deployment or push was performed.

Scope: preserve prior changes; no commit, push, production deployment, speculative retries or default verified status.
