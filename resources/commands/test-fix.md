---
description: Run the tests and fix failures until green
argument-hint: "[test command or path]"
---
Run the project's tests ($ARGUMENTS if given, otherwise detect the project's test
command). If any fail, diagnose the root cause, fix it, and re-run until green or
until you hit a genuine blocker. Show the failing output you started from and the
final passing result.
