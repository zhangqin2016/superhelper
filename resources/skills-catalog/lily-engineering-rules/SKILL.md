---
name: lily-engineering-rules
description: Engineering collaboration rules for non-trivial development, debugging, architecture changes, tests, code review, documentation, and release work. Use when the user asks for careful engineering, surgical changes, root-cause debugging, or project-standard implementation.
intent: Provide executable engineering discipline: clarify assumptions, keep changes minimal, verify against goals, choose coherent designs over compromises, encode intent in tests, checkpoint long tasks, follow local conventions, and state skipped work.
type: reference
best_for:
  - Non-trivial feature work or bug fixes
  - Refactors or migrations that need tight scope control
  - Tests, reviews, or tasks requiring project engineering standards
scenarios:
  - Change this module without touching unrelated code
  - Implement this according to our project standards
  - Find the root cause before fixing this bug
---

# Engineering Collaboration Rules

Use these rules for development tasks unless the user's current instruction explicitly overrides them.

## 1. Think Before Writing

State assumptions. Ask when ambiguity would change the solution. If several interpretations exist, name them. If a simpler route exists, point it out.

## 2. Prefer Simplicity

Use the least code that solves the problem. Avoid speculative features and one-off abstractions. If a senior engineer would call it over-engineered, simplify.

## 3. Make Surgical Changes

Touch only what is required. Clean up only the mess you introduce. Match existing style and avoid unrelated formatting churn.

## 4. Work From the Goal

Define success criteria, then iterate until they are met. Do not follow steps mechanically when evidence changes.

## 5. Use Models for Judgment, Code for Determinism

Use reasoning for classification, drafting, summarization, and extraction. Use code, tools, and tests for routing, retries, transforms, and anything deterministic.

## 6. Checkpoint Long Work

Break complex work into phases. Summarize remaining work before context or time pressure causes silent loss. State blockers plainly.

## 7. Choose When Designs Conflict

When two patterns conflict, choose one based on recency, usage, ownership, or test coverage. Explain the choice and mark the losing path for cleanup.

## 8. Read Before Writing

Before adding code, read exports, direct callers, shared helpers, and tests. For bugs, find root cause instead of patching only symptoms.

## 9. Tests Encode Intent

Tests should prove why behavior matters, not just that lines executed. For bug fixes, add or run a regression check when the project has a test habit.

## 10. Checkpoint After Critical Steps

After migrations, protocol changes, state-machine changes, or broad UI changes, verify that the next step still matches the goal.

## 11. State Skipped Work

If a test, build, deploy, or browser verification could not run, say why. Do not imply completion beyond evidence.

## 12. Preserve User Work

Do not revert, delete, or overwrite unrelated user changes. If they block the task, work with them or ask for direction.
