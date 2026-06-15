# Claude CLI 2.1.177 Capability Audit

Date: 2026-06-15

## Scope

Audit Lily Workbench compatibility after upgrading the bundled Claude Code CLI
from `2.1.165` to `2.1.177`.

Current bundled binaries:

- `bundles/darwin-arm64/engine-upstream` -> `2.1.177 (Claude Code)`
- `bundles/darwin-x64/engine-upstream` -> `2.1.177 (Claude Code)`
- `bundles/win32-x64/engine-upstream.exe` -> official `win32-x64` package binary

## Sources Checked

- npm metadata for `@anthropic-ai/claude-code@2.1.177`
- npm metadata for platform packages:
  - `@anthropic-ai/claude-code-darwin-arm64@2.1.177`
  - `@anthropic-ai/claude-code-darwin-x64@2.1.177`
  - `@anthropic-ai/claude-code-win32-x64@2.1.177`
- GitHub release tag `v2.1.177`
- upstream `CHANGELOG.md` sections `2.1.176` through `2.1.166`
- local help output from `2.1.165` and `2.1.177`
- live `stream-json` probes against the bundled `2.1.177` CLI

## Changelog Findings

`v2.1.177` has an empty GitHub release body. The upstream changelog currently
starts at `2.1.176`; changes between `2.1.165` and `2.1.177` that matter to
Lily are:

- Fable model family is now a first-class CLI model alias/documented model path.
- `--safe-mode` / `CLAUDE_CODE_SAFE_MODE` disables customizations for
  troubleshooting.
- `disableBundledSkills` / `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` exists upstream.
- `fallbackModel` / `--fallback-model` behavior was added/improved upstream.
- Tool permission matching improved for hook `if` conditions and wildcard
  tool/file rules.
- Background agents, nested sub-agents, remote control, and daemon behavior got
  many fixes, especially on Windows.
- `claude agents --json` gained stronger state coverage in upstream CLI.

## Help Diff Findings

Compared `claude --help` from `2.1.165` and `2.1.177`.

Changed:

- `--model` help now lists `fable`, `opus`, and `sonnet` aliases and uses
  `claude-fable-5` as the example full model name.
- New global flag:
  `--safe-mode` disables customizations such as `CLAUDE.md`, skills, plugins,
  hooks, MCP servers, custom commands/agents, output styles, workflows, themes,
  and keybindings. Managed policy settings still apply.

Unchanged:

- top-level command list,
- `claude mcp --help`,
- `claude plugin --help`.

`claude config --help` still resolves to the top-level help output in both
versions, so there is no observed config subcommand capability delta.

## Runtime Probe Findings

Command:

```bash
CLAUDE_BIN="$PWD/bundles/darwin-arm64/engine-upstream" \
CLAUDE_PROBE_OUT_DIR=/tmp/claude-2177-probe-events \
CLAUDE_PROBE_TIMEOUT_MS=90000 \
CLAUDE_PROBE_MAX_BUDGET_USD=0.03 \
CLAUDE_PROBE_GAME_BUDGET_USD=0.05 \
node scripts/probe-claude-events.mjs
```

Results:

- `print-text`: success, no protocol warnings.
- `stream-json-input`: success, no protocol warnings.
- `python-game`: exercised streaming tool use and returned
  `error_max_budget_usd` due the intentionally low budget; no protocol warnings.

Observed raw event types:

- already-covered core events:
  - `system:init`
  - `system:status`
  - `assistant`
  - `user`
  - `stream_event:message_start`
  - `stream_event:content_block_start`
  - `stream_event:content_block_delta`
  - `stream_event:content_block_stop`
  - `stream_event:message_delta`
  - `stream_event:message_stop`
  - `result:success`
  - `result:error_max_budget_usd`
- `rate_limit_event`

`rate_limit_event` was already supported by the normalizer, but not covered by a
dedicated fixture. Added fixture coverage.

## Code Changes From Audit

- `scripts/probe-claude-events.mjs`
  - added optional `CLAUDE_PROBE_OUT_DIR` support to save raw JSONL traces per
    probe case.
- `scripts/test-claude-runtime-fixtures.mjs`
  - added `noticeCodes` assertions so fixtures can prove specific notice mapping.
- `fixtures/claude-runtime/rate-limit-event.jsonl`
  - added sanitized real-shape `rate_limit_event`.
- `fixtures/claude-runtime/rate-limit-event.expected.json`
  - asserts `rate_limit_event` maps to `engine_notice` with `rateLimit`, without
    protocol warnings.

## UI / Product Decision

No immediate renderer change is required for `2.1.177`.

Reasons:

- Existing Lily runtime path already supports the observed `stream-json` events.
- Fable can be configured through existing custom model fields because Lily does
  not hard-code a closed model list in the desktop model settings.
- `--safe-mode` is useful for diagnostics, but enabling it as a normal user
  setting would disable Lily's own guide/skills/hooks path and make the product
  look broken. If exposed, it should be a clearly labeled troubleshooting action,
  not a general model/runtime setting.
- Upstream background agent and Remote Control features are terminal-native CLI
  features. Lily currently runs one long-lived CLI process per app session and
  does not expose the native terminal UI, so these are not automatically product
  features.

Potential future UI work:

- Add a hidden/admin "Start next turn in CLI safe mode" diagnostic action.
- Add model preset rows for Fable only after the service/provider side exposes a
  supported model ID and pricing policy.
- Add a runtime diagnostics panel that surfaces CLI version and selected model
  family for support.

## Verification

Required checks after the audit:

```bash
npm run test:runtime-fixtures
npm run test:runtime
npm run test:unit
```

Windows still needs real-machine validation before shipping the updated CLI:

```powershell
.\engine-upstream.exe --version
```

Expected:

```text
2.1.177 (Claude Code)
```
