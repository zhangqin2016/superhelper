# Discard-Sink Work Progress Design

## Goal

Remove false `Download: nul` notices from live and reopened conversations without changing model selection, prompts, tools, command execution, or legitimate transfer progress.

## Approved Invariants

- Strong-model execution stays byte-for-byte on the existing path. This change only interprets optional progress metadata.
- A recognized discard sink degrades to the existing tool row. It never blocks, rewrites, or retries the command.
- Real output files and remote-name downloads continue to emit progress.
- The ordinary POSIX filename `null` remains valid. Only operating-system discard sinks are special.
- Existing stored messages are not rewritten. Legacy cleanup is a narrow, reversible render-time compatibility rule.

## Approaches Considered

### Producer-only filtering

Normalize command output targets before progress inference. This prevents new false notices, but already archived `Download: nul` entries remain visible forever.

### Renderer-only filtering

Hide strings such as `Download: nul` in the renderer. This removes the symptom but leaves malformed runtime events, persisted metadata, and other consumers incorrect.

### Selected: semantic producer guard plus sealed-history compatibility

The main process recognizes actual discard sinks before command-level transfer inference. The renderer separately removes only legacy sealed notices whose exact detail identifies a discard sink and whose structured progress payload is already absent. This fixes the source and safely repairs old conversations without a destructive migration.

## Architecture

### Main-process normalization

`inferWorkProgressFromCommand()` keeps its one-argument API and accepts an optional platform override for deterministic tests. It normalizes the extracted output target:

- POSIX `/dev/null` is always a discard sink.
- Windows `NUL` and `NUL:` are discard sinks only on Windows or when a Windows transfer executable such as `curl.exe` identifies the command as Windows-shaped.
- PowerShell `$null` is a discard sink only for Windows-shaped commands.
- Plain `null` is never special.

The normalized target becomes empty before the existing curl guard runs. Therefore a curl probe redirected to a discard sink returns `null` and falls back to the normal tool row. A real `curl -O` remote-name download remains visible even if log output is discarded. Non-curl transfer commands keep their transfer classification but never display the discard sink as an artifact path.

### Legacy sealed-history filter

`timelineForProcessView()` filters a legacy entry only when all of these are true:

- the turn is sealed;
- the entry is a `workProgress` notice;
- the entry level is exactly `progress`;
- no structured `progress` object survived archival;
- the detail is exactly a download to `NUL`, `NUL:`, `/dev/null`, or `$null`.

The generated `Download: ` prefix and POSIX `/dev/null` spelling are case-sensitive. Only Windows `NUL` and PowerShell `$null` are case-insensitive. Valid historical paths, live progress, structured progress, non-progress notice levels, `/DEV/NULL`, `NUL.txt`, malformed spacing, and the literal filename `null` remain visible.

## Data Flow

1. OpenCode emits a bash command.
2. The runtime reducer asks `inferWorkProgressFromCommand()` for optional progress metadata.
3. Discard sinks normalize to no output target.
4. A probe produces no `engine.notice`; the ordinary `tool.started` row remains.
5. Legitimate transfers continue through `formatWorkProgressDetail()` and render as today.
6. On reload, the renderer removes only exact legacy discard-sink notices from sealed timelines.

## Failure Handling

- Unknown target syntax is left untouched and follows the current behavior.
- Platform detection failure uses `process.platform`; Windows-shaped `.exe` commands still recognize `NUL` in cross-platform history and tests.
- The legacy predicate returns false for malformed entries, preserving the baseline transcript.
- No database migration or history rewrite is performed.

## Testing

- Protocol red tests for Windows `NUL`, `NUL:`, POSIX `/dev/null`, and PowerShell `$null`.
- Positive controls for `/tmp/file`, remote-name downloads, and the literal POSIX filename `null`.
- Reducer red test proving a Windows curl probe emits only `tool.started` and no `workProgress` notice.
- Timeline-model red tests proving sealed legacy discard notices disappear while valid history, structured/live entries, non-progress levels, `NUL.txt`, malformed spacing, and case-distinct POSIX paths remain.
- Existing work-progress, reducer, timeline, Electron renderer, and full unit suites remain green.

## Scope Boundary

This change does not restyle notices, make all `workProgress` entries transient, alter command execution, rewrite stored records, or change any model capability. Those would be broader product decisions and could hide legitimate progress.
