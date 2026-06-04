# Claude `system/permission_denied` Runtime Event

## Symptom

Production runtime diagnostics reported `protocol_warning` for a Claude CLI system event with subtype `permission_denied`.

## Root Cause

`src/main/claude-event-normalizer.js` intentionally reports unknown `system` subtypes as protocol warnings. `src/main/engine-event-notices.js` did not classify `permission_denied`, so a known permission outcome was treated as an unknown runtime protocol event.

## Fix

Map `system/permission_denied` to an engine notice:

- `code`: `permissionDenied`
- `level`: `warning`
- `panel`: `true`
- `done`: `true`

This keeps the user informed that a step was skipped while preventing diagnostic noise.

## Regression Coverage

Added `fixtures/claude-runtime/permission-denied.jsonl` and expected output requiring:

- `system_notice`
- no `protocol_warning`
- warning count `0`

Also added direct normalizer/classifier assertions in `scripts/test-agent-runner.mjs`.

## Verification

Ran:

```bash
node --check src/main/engine-event-notices.js && node --check scripts/test-agent-runner.mjs
npm run test:unit
```

Result: passed. Fixture replay now includes `permission-denied.jsonl` with `warnings=0`.

## Status

DONE
