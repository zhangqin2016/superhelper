---
name: lily-coding-core
description: Use for coding, modification, debugging, refactoring, and verification. Provides Lily's baseline engineering discipline while delegating app construction, UI judgment, browser evidence, and repair workflows to focused skills.
---

# Lily Coding Core

This is Lily's baseline engineering discipline. It improves reliability without restricting a capable model's ability to reason, inspect more context, or choose a better implementation within the user's scope.

## When to Use

- Building or changing code, components, scripts, automations, tools, services, configuration, or data processors.
- Explaining, debugging, refactoring, or verifying code.
- Coordinating a mixed implementation that needs focused build, design, browser, or repair guidance.

Do not use for pure Word, PDF, PPT, or Excel work unless code or a web artifact is also part of the deliverable.

## Workflow

1. Identify the intended behavior, success check, constraints, and protected existing behavior.
2. Ask only blocking questions; use safe context and small reversible checks to progress.
3. Read entrypoints, callers, tests, shared utilities, and local conventions before editing.
4. Add or update a test that expresses the intended behavior when code behavior changes.
5. Make the smallest coherent change. Preserve user work and avoid unrelated refactors or framework replacement.
6. Run the narrowest meaningful verification, then the relevant broader regression suite.
7. If verification fails, determine root cause before changing implementation.
8. Report changed paths, evidence, residual risk, and anything not verified.

## Specialist Routing

- Use `lily-app-builder` when the result is a runnable page, app, tool, script, or automation.
- Use `lily-ui-quality` for interface creation and review standards.
- Use `lily-browser-qa` for real browser interaction, screenshots, and runtime evidence.
- Use `lily-code-repair` when an existing implementation fails and needs root-cause repair.

These guides add deterministic scaffolding for smaller models. They do not downgrade the selected model, remove context, hide tools, or replace the strong default when a specialist path is unavailable.

## Quality Bar

- The result runs, or the exact environmental blocker is stated.
- Behavioral changes have a meaningful automated check when feasible.
- Completion claims cite actual command, test, browser, or artifact evidence.
- Generated artifacts have absolute paths or clear run/open instructions.
- No helper failure may silently turn into a weaker, improvised execution path.
