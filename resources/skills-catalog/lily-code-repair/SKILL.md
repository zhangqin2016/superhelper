---
name: lily-code-repair
description: Use when the user reports that code, a webpage, an app, tests, build, deployment, or automation failed: errors, blank pages, cannot open, does not work, test failures, CI failures, deploy failures, broken scripts, or regressions. Classifies the failure, reproduces it, finds root cause, applies the smallest fix, and reruns verification without blind rewrites or infinite retries.
---

# Lily Code Repair

Use this skill for failures: errors, broken pages, failed tests, failed builds, failed deploys, scripts that do not run, or regressions. The goal is evidence, root cause, minimal fix, and verification.

## When to Use

- The user says it failed, broke, cannot open, is blank, does nothing, crashed, tests failed, build failed, deploy failed, or CI failed.
- The user provides a stack trace, log, screenshot, failing command, or failing page.
- A new artifact fails during startup, test, build, browser QA, or deployment verification.

## When Not to Use

- Starting a new app or tool from scratch; use lily-app-builder.
- Explaining code without a failure symptom.
- Pure document layout issues unless the failure is in code or automation.

## Failure Classes

- Startup failure: dependency, port, env var, command exit, missing runtime.
- Runtime failure: exception, console error, 4xx/5xx, permission, bad path.
- Test failure: assertion, snapshot, timeout, test environment mismatch.
- Build failure: type error, bundler config, module resolution, asset path.
- Page failure: blank page, unclickable control, broken layout, mobile overflow.
- Deploy failure: CI, image, migration, health check, production config.

## Workflow

1. Collect evidence: user error, changed files, command, environment, and relevant logs.
2. Reproduce the original failure when possible; otherwise run the closest local verification and state the limit.
3. Trace to root cause from the first real error or failing assertion.
4. Apply the smallest fix. Do not rewrite unrelated code or reformat unrelated files.
5. Rerun the original failing command, then the smallest affected tests or browser checks.
6. If the same hypothesis fails twice, stop and re-analyze evidence.
7. Report root cause, changed files, verification, and any remaining risk.

## Guardrails

- Do not claim root cause without reproduction or evidence.
- Do not globally reinstall dependencies, delete lockfiles, clear caches, or rewrite config unless evidence requires it.
- Do not revert user work unless explicitly asked.
- Do not hide skipped tests, failed checks, or environment limits.
