# Session Skills Responsive Grid Design

## Goal

Increase the information density of the per-session skill picker without
changing skill availability, selection, persistence, grouping, or the richer
skill-management layout in Settings.

## Current Behavior

The composer popover renders skills as a categorized tree. Each category header
is compact, but every skill consumes a full-width row even though the row only
contains a checkbox, a name, and an occasional global-disabled badge.

The tree structure and selection behavior are already correct. The layout
problem is limited to the children of expanded groups inside the session-skills
popover.

## Design

Keep each category header full width. Render the category's skill children as a
row-major responsive grid:

- Three columns when the available content width can support them.
- Two columns at medium widths.
- One column on narrow windows.
- Never exceed three columns, even when the composer is very wide.

Each skill remains a compact, fixed-minimum-height selectable item containing:

- The existing checkbox mark.
- A single-line skill name with ellipsis when necessary.
- The existing global-disabled state, presented without changing its meaning.
- The full localized description in the existing hover title.

Selection, hover, focus, busy, pulse, and global-disabled states retain their
current visual semantics. Grid cells use stable dimensions so state changes do
not resize neighboring items.

## Scope And Isolation

The grid rules must be scoped beneath `.session-skills-popover-list`. Shared
`.skills-tree-*` rules continue to provide the base tree and row styling.
Settings uses the same tree components but must remain a vertical detailed
list.

No backend, IPC, persistence, skill discovery, sorting, category expansion, or
bulk-selection code changes are required. The DOM order remains category order,
then skill order, so pointer, Tab, and screen-reader traversal remain
left-to-right and top-to-bottom.

## Responsive Behavior

Use a container-aware layout based on the popover list width rather than the
application viewport. This keeps the picker correct when the sidebar or window
changes the composer width.

- Wide list: three equal columns.
- Medium list: two equal columns.
- Narrow list: one column.

Long names truncate within their own cell and cannot overlap the status badge
or adjacent cells. RTL continues to use the existing row direction and spacing
rules.

## Failure And Compatibility

If container-query support is unavailable, the baseline remains the current
single-column list. This is the required fail-open behavior: layout enhancement
failure cannot disable, hide, or reorder skills.

The change is visual only and does not affect the Capability Gate's agent
execution paths.

## Verification

Add a renderer layout regression test that verifies:

- Session-popover group children receive the responsive grid rules.
- The grid is capped at three columns and has two- and one-column fallbacks.
- The selector is scoped to the session popover.
- Settings skill rows retain the existing vertical shared layout.

Run the focused renderer test, the existing skill-tree tests, and the full unit
suite. Inspect the popover at wide, medium, and narrow widths to confirm that
names, badges, focus states, and category controls do not overlap.
