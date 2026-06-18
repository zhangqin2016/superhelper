---
name: lily-app-builder
description: Use when the user describes a webpage, small tool, script, automation, or local app in plain language and expects a runnable result. Turns natural-language intent into the smallest working deliverable, starts it when possible, verifies it with browser or command output, and returns exact local paths.
---

# Lily App Builder

Use this skill to turn a plain-language request into a runnable artifact. The user should not need to understand project structure, framework choices, or build tooling before getting something useful.

## When to Use

- The user asks for a webpage, small tool, script, automation, prototype, local app, data processor, or generated HTML report.
- The user describes the business outcome but not the technical stack.
- The user wants something they can open, run, or reuse.
- The request is phrased like "build it", "make a runnable file", "open it for me", or "turn this material into an interactive page".

## When Not to Use

- The user only wants explanation, pseudocode, or planning.
- The deliverable is purely Word, PDF, PPT, or Excel unless a webpage/script/automation is part of the output.
- Existing code is broken; use lily-code-repair first.
- The request is a large long-term product or backend platform that cannot honestly be completed in one pass.

## Workflow

1. Identify the smallest useful deliverable: single HTML file, existing frontend change, Node/Python script, shell automation, lightweight local app, or project modification.
2. Choose the simplest technology that fits the existing workspace. For new tools, prefer low-dependency outputs the user can reopen later.
3. Put files in a clear workspace location. Do not scatter temporary deliverables.
4. Read the existing structure before editing. Make only the files required for the core use case.
5. Run the artifact: execute scripts with a tiny sample; start a dev server for app pages; open single HTML files when possible.
6. Verify visible artifacts with browser QA and UI quality checks. Verify non-UI scripts with command output or sample input.
7. Fix one round of obvious startup, console, layout, or command failures by reading the actual error.
8. Deliver absolute paths, run/open instructions, and verification evidence.

## Quality Bar

- No runnable entrypoint means the task is not complete.
- Browser artifacts must be opened or the reason they could not be opened must be stated.
- UI text must not overlap, overflow, or break on obvious desktop/mobile sizes.
- Do not return only snippets unless the user explicitly asked for snippets.
- Keep technical explanation limited to what the user needs to run and maintain the result.

## Related Skills

- lily-coding-core for engineering discipline.
- lily-browser-qa for browser-visible outputs.
- lily-ui-quality for interface polish and responsive behavior.
- lily-code-repair when verification fails.
