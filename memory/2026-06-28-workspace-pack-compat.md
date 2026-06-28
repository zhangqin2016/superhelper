# Workspace Pack Compatibility

## Root Cause

On 2026-06-28, a shared clinical workspace app exported by a newer build failed
to import on another client with `NOT_A_WORKSPACE_PACK`.

The exported zip was a valid new-format pack:

- workspace files lived at the zip root
- metadata lived at `.lilyspace/lily-workspace.json`

Older Lily clients only recognized the legacy layout:

- root `lily-workspace.json`
- workspace files under `files/`

So an old importer saw no manifest and no `files/` payload, then rejected the
package before import.

## Decision

Small non-conflicting exports must be dual-layout:

- new layout remains human-friendly for current clients
- legacy root manifest and `files/` mirror keep older clients able to import
- the root compatibility manifest uses `kind: "lily-workspace-pack"` even when
  the hidden manifest is `lily-workspace-app`, because earliest importers only
  accepted ordinary workspace packs
- current importers must prefer `.lilyspace/lily-workspace.json` and ignore the
  legacy mirror so duplicate `files/` / `skills/` folders are not restored

If the mirror would collide with real workspace paths, or the workspace is too
large to duplicate safely, export falls back to the unambiguous legacy layout.
Import compatibility is more important than a cleaner zip root.

## Guard

`scripts/test-workspace-share.mjs` verifies:

- new packs expose root workspace files
- old importers can still see `lily-workspace.json` and `files/`
- new importers ignore compatibility mirror entries
- real `files/` directories survive by falling back to legacy layout when needed
