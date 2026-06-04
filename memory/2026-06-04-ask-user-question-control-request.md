# AskUserQuestion Control Request Blank Prompt

## Symptom

Online builds could show an empty assistant interaction after Claude CLI asked
follow-up questions. Users then typed normal messages such as `?` or "怎么不回答了",
but those messages were treated as new chat input instead of answers to the
pending CLI question.

## Root Cause

The app is a Claude CLI proxy, but the AskUserQuestion bridge only handled the
ideal payload shape: `input.questions[]`. Claude CLI can emit a control request
with a looser shape such as `input.question`, `input.prompt`, `input.message`, or
string questions. When normalization produced an empty question list, the
renderer displayed an empty question prompt and the composer had no rule to
submit plain text as the pending control response.

## Fix

- Normalize AskUserQuestion payloads in `src/main/agent-session.js` so the
  pending request always has at least one answerable question.
- Add renderer-side fallback normalization in `src/renderer/modules/message.js`
  so malformed or old payloads do not render as blank cards.
- Intercept composer sends while a user-question control request is pending and
  submit the typed text through `assistant:question-response` instead of queuing
  a new chat message.
- Add regression coverage in `scripts/test-agent-tool-lease.mjs` for fallback
  question payloads and control response shape.

## Verification

- `node scripts/test-agent-tool-lease.mjs`
- `node scripts/test-agent-runner.mjs`
- `npm run test:unit`
- `npm --prefix web run build`

## Status

DONE
