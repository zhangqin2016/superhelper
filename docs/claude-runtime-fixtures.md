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
- interactive `request_user_dialog` / `elicitation` control requests,
- non-blocking control requests such as MCP, OAuth refresh, color/theme, and
  message rating handshakes,
- SDK permission requests,
- documented hook callback families including tool, session, compact,
  permission, task, elicitation, config, worktree, cwd/file, and display hooks,
- echoed control responses,
- assistant `supersedes` metadata,
- permission denied system events,
- task progress/completion telemetry,
- result error subtypes such as `error_max_budget_usd`,
- unknown runtime/system protocol warnings.

## Adding Real Fixtures

Use the probe script to inspect the installed Claude CLI:

```bash
CLAUDE_PROBE_OUT_DIR=/tmp/lily-claude-events \
CLAUDE_PROBE_TIMEOUT_MS=60000 \
CLAUDE_PROBE_MAX_BUDGET_USD=0.04 \
node scripts/probe-claude-events.mjs
```

When `CLAUDE_PROBE_OUT_DIR` is set, the probe writes:

- `<case>.jsonl`: sanitized raw material to turn into fixtures.
- `event-catalog.json`: merged event shape inventory across all cases.
- `summary.json`: per-case exit status, normalized action counts, and warnings.

The probe currently covers:

- plain assistant text,
- stream-json stdin input,
- file reads and bash/tool use,
- stdio permission prompt mode when the installed CLI emits control requests,
- multi-step local file generation,
- user interruption with `SIGINT`.

The event inventory is intentionally treated as discovery output, not a golden
test. Claude CLI versions can add new telemetry events at any time. If a probe
run discovers a useful new event shape, convert the smallest sanitized JSONL into
a permanent fixture under `fixtures/claude-runtime/` and add assertions for the
app-level behavior.

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
