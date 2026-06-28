# OpenCode Prompt Acceptance Watchdog

When using `session.promptAsync`, a successful SDK call only proves that Lily's
HTTP request returned; it does not prove the engine actually started a turn for
the Lily session view. If no session-owned `message.*`, permission/question, or
progress event arrives, the UI can stay in "starting" until the long no-progress
watchdog, then show "回答未完整结束 / 本轮没有形成最终回答".

Fix pattern:

- After `sendPrompt()` succeeds, arm a short prompt-acceptance check.
- If an owned event or reducer progress arrives, clear the check.
- If official session status is busy, keep waiting; do not kill quiet legitimate
  work.
- If official status is idle and no owned activity arrived, recover only when
  official history contains the current user prompt and a later assistant answer.
- Otherwise retry the prompt once, then fail fast and clear busy state.

Important: history recovery must be anchored to the current user prompt. A
time-only "latest assistant" fallback can leak the previous answer into the new
turn when two turns happen close together.
