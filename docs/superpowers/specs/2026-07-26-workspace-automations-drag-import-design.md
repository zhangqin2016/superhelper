# Workspace Automations and Drag Import Design

Date: 2026-07-26
Status: Approved for planning

## Goal

Extend Lily workspace sharing so authors can optionally include scheduled-task
templates, and make Lily application packages dropped into the chat window
discoverable without taking away the existing ability to send the same package
as a normal chat attachment.

The design keeps imports explicit. Dropping a recognized Lily package never
installs it automatically, and imported scheduled tasks never start
automatically.

## Product Behavior

### Scheduled tasks in workspace exports

The workspace export preview lists scheduled tasks bound to the exported
workspace. Tasks are individually selectable and are unselected by default.
The export confirmation shows the number of selected tasks.

Only reusable task definitions travel:

- title
- prompt
- normalized schedule
- human-readable schedule text
- permission mode

The pack does not include task IDs, project IDs, session IDs, run history,
status, last-run timestamps, next-run timestamps, queue state, or errors.

### Scheduled tasks on import

The import preview lists task templates carried by the package. Users can
choose which templates to import. Imported tasks:

- receive new IDs;
- bind to the newly imported workspace and its default session;
- are always created paused;
- have no run history;
- calculate `nextRunAt` only when the recipient enables them.

Recurring schedules use the recipient's local time semantics. An expired
one-time schedule remains importable but paused and is labelled as expired.
Importing the workspace succeeds even if a malformed task template is skipped;
the result reports every skipped template.

### Chat-window package drop

The existing global drop target remains the entry point. When files are
dropped, Lily asks the main process to inspect candidates before staging them
as attachments.

If a ZIP contains a supported Lily manifest, Lily presents a decision dialog:

1. **Import application/workspace** enters the normal reviewed import flow.
2. **Send as file** stages the package as an ordinary chat attachment.
3. **Cancel** performs neither action.

The dialog identifies whether the package is a workspace application or a
workspace pack and shows its name, version, publisher/signature state,
declared skills, runtime packs, embedded workspace skills, scheduled-task
count, and risk warnings.

Files that are not valid Lily packages keep today's attachment behavior with
no extra prompt. A corrupt, unsupported, or future-schema ZIP is also treated
as a normal attachment unless the user explicitly chooses the existing import
command, where the precise import error remains visible.

## Package Format

The current workspace manifest schema remains compatible. Scheduled-task
templates are stored in:

```text
.lilyspace/automations.json
```

The file shape is:

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "title": "Daily summary",
      "prompt": "Summarize project changes",
      "schedule": { "type": "daily", "hour": 18, "minute": 0 },
      "scheduleText": "Daily at 18:00",
      "permissionMode": "read_only"
    }
  ]
}
```

The main manifest includes only summary metadata:

```json
{
  "automationCount": 1
}
```

Older clients ignore `.lilyspace/automations.json`. New clients do not require
the file, so existing packages continue to import unchanged. Automation data
is not copied into the legacy root mirror because older importers cannot bind
it safely.

## Architecture

### Scheduled-task portability service

A focused main-process module owns deterministic conversion:

- list exportable tasks for a project;
- convert live tasks into safe templates;
- validate and normalize imported templates;
- restore selected templates as paused tasks in a supplied project/session.

`ScheduledTaskManager` remains the owner of persistence and task creation. It
gains a paused-import path rather than allowing callers to mutate its internal
task array.

### Workspace package inspection

A main-process package inspector accepts a local path or staged path and
returns bounded metadata. It reuses `readPackManifest` and the same validation
helpers used by the importer. The renderer never parses ZIP data.

Inspection:

- reads only ZIP directory metadata and bounded manifest files;
- verifies supported kind and schema;
- validates automation templates without creating them;
- reports package identity and declared capabilities;
- does not extract files, install dependencies, or execute code.

### Unified import entry

The existing dialog import and the new drag import call one path-based import
service. Native file selection only supplies a path; drag-and-drop supplies the
path through Electron `webUtils.getPathForFile`. Pathless browser files are
staged first, then inspected.

The service preserves the existing workspace import hardening:

- ZIP-slip protection;
- package/schema validation;
- file and package size limits;
- secret and capability disclosure;
- workspace-skill validation;
- application signature policy;
- dependency confirmation and installation.

An imported `lily-workspace-app` is recorded as a locally installed
application so open/uninstall state remains coherent. A plain
`lily-workspace-pack` is added as a normal workspace.

### Renderer flow

`file-handler.js` delegates dropped files to a classifier before calling its
existing staging path. Recognized packages are handed to a small package
decision controller. This keeps attachment handling independent from the
application installer.

The global overlay initially retains its generic file-drop wording. After a
recognized package is inspected, the decision dialog carries the application
specific UI; no speculative ZIP parsing occurs during drag hover.

## Multiple-file Drops

Files are classified independently:

- ordinary files are staged as attachments;
- each recognized Lily package is listed in one decision dialog;
- the user chooses import, attach, or ignore for each package;
- multiple application imports execute sequentially so native destination and
  capability confirmations cannot overlap.

Failure to inspect one file does not block the remaining files.

## Security and Failure Behavior

- No dropped package is installed without explicit user confirmation.
- Scheduled tasks are opt-in at export and import, then restored paused.
- Package inspection is read-only and bounded.
- Invalid automation entries are skipped and reported, never executed.
- Import failures leave ordinary attachment staging available.
- If package inspection is unavailable or throws, all dropped files follow the
  current attachment path. This is the capability-gate fallback.
- Existing file-picker import remains available even if drag import is
  disabled or fails.

## Testing

Automated coverage must prove:

1. Workspace task templates round-trip without IDs, history, or active state.
2. Imported tasks bind to the new project/session and remain paused.
3. Expired one-time tasks remain paused and are reported.
4. Malformed automation entries are skipped without aborting workspace import.
5. Old packages without automations still import unchanged.
6. Old clients can ignore new packages because the legacy mirror is unchanged.
7. A valid Lily package is detected by manifest content, not filename alone.
8. Ordinary and corrupt ZIP files remain normal chat attachments.
9. The decision dialog supports import, attach, and cancel.
10. Drag import and file-picker import use the same main-process service.
11. Application imports preserve signature, dependency, ZIP-slip, and size
    checks.
12. Inspection failure falls back to today's attachment behavior.

The feature adds a capability-gate entry for optional workspace automation
sharing and package-drop classification so future changes cannot silently
activate imported tasks or swallow ordinary attachments.
