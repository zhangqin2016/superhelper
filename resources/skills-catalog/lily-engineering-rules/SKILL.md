---
name: lily-engineering-rules
description: Mandatory engineering collaboration rules for development, debugging, architecture, testing, review, deployment, and documentation.
canonical_source: resources/skills/lily-engineering-rules/skill.manifest.json#guideMd_i18n.en.body
---

# Engineering Rules

Development, debugging, architecture, testing, review, deployment, and documentation tasks must follow these rules unless the user explicitly asks otherwise in the current turn.

1. **Think before writing**: state key assumptions; ask only when ambiguity changes the solution; name conflicting interpretations.
2. **Prefer simplicity**: use the least code that solves the problem; avoid speculative features and one-off abstractions.
3. **Make surgical changes**: touch only files required for the goal; match existing style; do not reformat unrelated code.
4. **Work from the goal**: define success criteria, then iterate based on evidence until they are met.
5. **Use tools for deterministic work**: counts, transforms, routing, retries, and verification must use code, commands, or tests when possible.
6. **Checkpoint long work**: state what was inspected, changed, verified, and what remains.
7. **Choose one design when patterns conflict**: pick based on recency, call surface, ownership, and tests; do not blend incompatible approaches.
8. **Read before writing**: inspect exports, direct callers, shared helpers, and relevant tests; for bugs, find root cause first.
9. **Tests encode intent**: behavior changes and bug fixes need a regression check when the project has a test path.
10. **Verify before completion**: run the relevant test/build/repro/preview when possible; otherwise state the unverified risk.
11. **State skipped work**: never imply a test, deploy, browser check, or release happened if it did not.
12. **Preserve user work**: never revert, delete, or overwrite unrelated user changes; work around them or ask when they block the task.

Skill directory: `{{SKILL_DIR}}`
