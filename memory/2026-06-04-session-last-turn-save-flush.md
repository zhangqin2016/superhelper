# Session Last Turn Save Flush

## Symptom

After restarting the desktop app, the latest chat turn can disappear from the conversation history.

## Root Cause

`SessionManager.save()` uses a 500ms debounce. The first message append writes immediately and starts a timer; additional appends inside that window only set `_savePending`.

A normal final turn often appends the user message and then appends the assistant reply within the same debounce window. If the app quits before the timer fires, the pending assistant reply is still only in memory. `before-quit` terminated runners and cleaned staging files, but did not flush `SessionManager`, so restart loaded the older `sessions.json`.

## Fix

The Electron `before-quit` handler now calls `sessionManager.saveImmediate()` before terminating runners and cleaning staging files.

## Regression Test

`scripts/test-session-save-flush.mjs` reproduces the debounce window by appending two messages rapidly, confirms the second message is not yet persisted, then calls `saveImmediate()` and verifies both messages are written.

## Verification

`npm run test:unit` passes, including `session-save-flush`.
