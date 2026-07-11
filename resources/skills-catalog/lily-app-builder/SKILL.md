---
name: lily-app-builder
description: Use when the user describes a webpage, landing page, small tool, script, automation, or local app in plain language and expects a runnable result. Turns intent into the smallest working deliverable, preserves the existing stack, starts it safely, verifies it, and returns exact local paths.
---

# Lily App Builder

Turn a plain-language request into a runnable artifact. The user should not need to choose a framework or understand the project structure before getting a useful result.

## When to Use

- Build or redesign a webpage, landing page, dashboard, admin screen, small tool, script, automation, prototype, local app, or generated HTML report.
- The user describes the outcome but not the technical stack.
- The user wants something they can open, run, or reuse.

## When Not to Use

- The user only wants explanation, pseudocode, or planning.
- The deliverable is purely Word, PDF, PPT, or Excel unless a webpage, script, or automation is also required.
- Existing code is broken; start with `lily-code-repair`.
- Do not replace a working project stack merely because another framework is more familiar.

## Workflow

1. Define the smallest useful deliverable and its success check.
2. Read the existing entrypoints, callers, styles, tests, and build commands. Preserve the current stack and user changes.
3. For a new artifact, choose the lowest-dependency option that satisfies the request. For an existing project, follow its conventions.
4. Put files in one clear workspace location and make only the changes needed for the core user path.
5. Run scripts with a representative small input. For a long-lived dev server, use the `lily_process_jobs` MCP: start with `job_start`, inspect readiness and the actual port with `job_status` and `job_logs`, and keep the job id.
6. If `lily_process_jobs` is unavailable, fail open to the normal foreground shell workflow. Never hide the server with `nohup`, `&`, `disown`, or an untracked detached process.
7. For visible interfaces, apply `lily-ui-quality`, then use `lily-browser-qa` to open the actual URL, exercise the primary path, and check desktop and mobile viewports.
8. When verification fails, read the actual error and use `lily-code-repair`. Continue while outputs or evidence show progress; stop only on confirmed non-progress, a real blocker, or user direction.
9. Stop a temporary process job after verification unless the user needs it left running. If it remains active, report the job id, URL, port, and stop command.
10. Deliver absolute paths, run/open instructions, and the evidence actually observed.

## Quality Bar

- No runnable entrypoint means the task is incomplete.
- Browser artifacts must be opened, or the exact runtime blocker must be stated.
- UI text must not overlap, overflow, or break at the tested desktop/mobile sizes.
- Do not return only snippets unless the user explicitly asked for snippets.
- Do not claim progress, readiness, or completion without command, job, browser, or file evidence.
- Keep technical explanation limited to what the user needs to run and maintain the result.

## Related Skills

- `lily-coding-core` for engineering discipline.
- `lily-ui-quality` for interface creation and review standards.
- `lily-browser-qa` for browser-visible evidence.
- `lily-code-repair` for root-cause repair when verification fails.
