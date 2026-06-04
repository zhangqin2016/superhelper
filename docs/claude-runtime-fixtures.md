# Claude Runtime Fixtures

Claude CLI is a runtime protocol, not a fixed text stream. The app keeps a
fixture suite under `fixtures/claude-runtime/` so protocol compatibility can be
checked before release.

## Format

Each scenario has two files:

- `<name>.jsonl`: one raw Claude CLI JSON event per line.
- `<name>.expected.json`: assertions for normalized app-level actions.

The replay test runs every raw event through the Claude parser and checks the
normalized compatibility action kinds, warning count, and scenario-specific
fields. The Runtime adapter contract is checked separately by
`scripts/test-runtime-adapter.mjs`, which verifies that the same raw events also
produce stable app-level Runtime Events.

## Run

```bash
npm run test:runtime-fixtures
node scripts/test-runtime-adapter.mjs
```

`npm run test:unit` also runs both suites.

## Current Coverage

- basic assistant text,
- high-frequency `system/thinking_tokens` telemetry,
- streaming tool use,
- tool input delta and tool result,
- AskUserQuestion loose payloads,
- SDK permission requests,
- hook callback control requests,
- echoed control responses,
- permission denied system events,
- task progress/completion telemetry,
- result error subtypes such as `error_max_budget_usd`,
- unknown runtime/system protocol warnings.

## Adding Real Fixtures

Use the probe script to inspect the installed Claude CLI:

```bash
node scripts/probe-claude-events.mjs
```

For a real issue, save a sanitized JSONL trace as a new fixture. Remove private
paths, user text, tokens, hostnames, and file contents. Keep event structure,
types, subtypes, request ids, tool names, and harmless short placeholders.

Then add `<name>.expected.json` with:

```json
{
  "description": "What this runtime scenario proves.",
  "mustIncludeKinds": ["assistant_text"],
  "mustNotIncludeKinds": ["protocol_warning"],
  "warningCount": 0
}
```

Unknown events are allowed only in fixtures that are specifically testing
unknown-event behavior.
