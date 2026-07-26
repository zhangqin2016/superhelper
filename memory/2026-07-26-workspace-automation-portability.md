# Workspace Automation Portability And Drag Import

## Invariants

- `.lilyspace.zip` remains backward compatible. Optional scheduled-task
  templates live at `.lilyspace/automations.json`; its absence means no tasks.
- Only reusable task definition fields travel. IDs, workspace/session scope,
  enabled state, timestamps, next-run values, and run history never travel.
- Export and import task selections are independent and default off.
- Imported tasks receive new IDs, bind to the new project/default session, and
  always start paused with `nextRunAt: null`.
- Package recognition is based on the bounded manifest read in the main
  process, not the filename extension. Renderer code never parses ZIP data.
- A recognized drop always asks whether to import, attach the original file to
  chat, or cancel.
- Unrecognized, malformed, future-schema, oversized, pathless, or
  inspection-failed drops retain the ordinary attachment path. Detection must
  fail open because attachment behavior predates this capability.
- Local app imports install declared skill/runtime dependencies before
  extraction and are recorded in workspace app install state.

## Guards

- `scripts/test-workspace-automation-sharing.mjs`
- `scripts/test-workspace-package-inspector.mjs`
- `scripts/test-workspace-package-drop.mjs`
- `scripts/test-workspace-share.mjs`
