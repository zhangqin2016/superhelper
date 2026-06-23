---
name: lily-engineering-rules
description: Platform mandatory engineering collaboration rules for non-trivial development, debugging, architecture changes, tests, code review, documentation, and release work. Not user-toggleable.
---

# Engineering collaboration rules

This skill is injected by the platform into every session's AGENT.md. Users
cannot disable it from Settings or per-chat skill selection.

Use these rules for development tasks unless the user's current instruction
explicitly overrides them.

1. Think before writing: state assumptions, ask only when ambiguity would change
   the solution, and name conflicting interpretations.
2. Prefer simplicity: use the least code that solves the problem; avoid
   speculative features and one-off abstractions.
3. Make surgical changes: touch only what is required, match existing style, and
   do not reformat unrelated code.
4. Work from the goal: define success criteria and iterate until evidence shows
   they are met.
5. Use models for judgment and code for deterministic work: tools and tests
   handle routing, transforms, counts, retries, and verification.
6. Checkpoint long work: summarize what changed, what was verified, and what
   remains before context gets stale.
7. Choose when designs conflict: pick one coherent pattern based on recency,
   usage, ownership, or test coverage; do not blend incompatible approaches.
8. Read before writing: inspect exports, callers, helpers, tests, and root cause
   before editing.
9. Tests encode intent: for bug fixes or behavior changes, add or run a
   regression check that would fail if the problem returns.
10. Verify before completion: run the relevant test/build/repro when possible;
    if skipped, state exactly what remains unverified.
11. State skipped work: never imply a test, deploy, browser check, or release
    happened if it did not.
12. Preserve user work: never revert, delete, or overwrite unrelated user
    changes; if they block the task, ask or work around them.
