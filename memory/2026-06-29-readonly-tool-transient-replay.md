# Read-Only Tool Transient Replay

## Debug Report

- Symptom: after a user asks about files or a directory, the session can show
  `Connection to the model service was interrupted...` and the current turn does
  not recover, while other sessions keep working.
- Root cause: OpenCode transient recovery treated any tool activity as unsafe to
  replay. That is correct for side-effecting tools, but too conservative for
  read-only inspection tools. A turn that only did `read`/`glob`/`grep`/`list`
  work could lose the final model call after the file inspection step and fail
  visibly instead of replaying the prompt once.
- Fix: split tool activity into replay-safe and replay-unsafe categories inside
  `opencode-agent-session`. Read-only tools (`read`, `glob`, `grep`, `list`,
  `ls`, `find`, `search`) allow one transient replay when there is no assistant
  output and no pending permission/question. `bash`, `write`, `task`, subagent,
  and unknown tools still block replay to avoid duplicate side effects.
- Evidence: `scripts/test-opencode-agent-session.mjs` now covers both sides:
  unsafe tool activity does not replay, while a transient hiccup after a
  completed `read` tool replays once and completes without surfacing a model
  interruption.

Related: this is separate from clipboard/document preflight. Clipboard fixes
ensure the file enters the turn and document extraction fails loud; this recovery
fix handles connection loss after the runtime has already started inspecting
files.
