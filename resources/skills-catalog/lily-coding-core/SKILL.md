---
name: lily-coding-core
description: Use when the user wants to build, modify, debug, or verify code, webpages, small tools, scripts, automations, local apps, UI prototypes, or data-processing programs. Wraps planning, systematic debugging, TDD, completion verification, frontend design, and browser QA into one Lily workflow.
---

# Lily Coding Core

This is Lily's baseline engineering discipline for ordinary-language coding work. It makes pages, tools, scripts, automations, local app prototypes, and code changes more likely to work on the first useful pass.

## When to Use

- Building or changing a webpage, component, script, automation, tool, local app prototype, or data-processing program.
- Debugging, explaining, refactoring, or verifying code.
- Improving a page that looks wrong or has weak interaction.
- Handling user reports such as failed, broken, blank, cannot open, test failed, build failed, or deploy failed.

Do not use for pure Word/PDF/PPT/Excel tasks unless code or a web artifact is also involved.

## Workflow

1. Identify the deliverable: script, page, component, tool, service, config fix, or data processor.
2. Ask only blocking questions. If a safe small step is possible, proceed.
3. Read current structure, entrypoints, callers, tests, and style before writing.
4. Make the smallest runnable change. Avoid unrelated refactors and new frameworks.
5. Apply UI quality rules when a visible interface is involved: hierarchy, states, empty/error cases, responsive layout, and text fit.
6. Verify with a command, test, build, or browser check whenever possible.
7. If verification fails, find root cause before patching.
8. Explain changes, verification, paths, and any unverified risk in plain language.

## Quality Bar

- The result runs, or the exact reason it cannot run in this environment is stated.
- At least one meaningful verification is run when available.
- UI must not overlap, overflow, or visibly break at normal sizes.
- Generated artifacts must have absolute paths or clear open/run instructions.
- Avoid excessive engineering vocabulary when the user only needs the result.
