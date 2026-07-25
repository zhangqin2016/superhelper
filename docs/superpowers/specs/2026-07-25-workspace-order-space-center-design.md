# Workspace Ordering and Space Center Design

Date: 2026-07-25
Status: Approved

## Summary

Lily Workbench will replace pinned workspaces with one persistent manual order.
Users can reorder every workspace directly in the sidebar. A compact grid button
beside the existing search field will open a centered Space Center for fast
switching between workspaces and their recent sessions.

The sidebar remains the place where users organize workspaces. Space Center is a
fast switcher, not a second workspace-management surface.

## Goals

- Keep workspace locations predictable when a user has many workspaces.
- Make reordering fast with a mouse, trackpad, touch-style long press, or keyboard.
- Prevent drag gestures from interfering with workspace expand/collapse.
- Make any workspace or recent session reachable without scanning the full sidebar.
- Reuse the existing local project, session, and runtime state.
- Preserve users' effective pinned-first order when upgrading.

## Non-Goals

- Custom workspace groups or folders.
- Manual ordering of sessions inside a workspace.
- Full-message-content search.
- Cloud synchronization of workspace order.
- Workspace rename, delete, reorder, or other management inside Space Center.
- A new page, database, or backend service.

## Product Decisions

1. Pinning is removed. Every workspace belongs to one manual order.
2. The persisted `projects` array is the source of truth for that order.
3. A newly registered workspace is inserted at the top. Reopening a workspace
   path that is already registered switches to it without changing its position.
4. Sidebar and Space Center use the same workspace order.
5. Space Center shows workspaces in manual order. Each card shows that
   workspace's most recently updated session, but recent activity does not
   reorder workspace cards.
6. Space Center uses a workspace-first hierarchy. Sessions never appear as
   peer tiles mixed into the workspace grid.

## Sidebar Ordering

### Entry and Discovery

- Hovering or focusing a workspace header reveals a six-dot drag handle.
- Dragging the handle starts immediately.
- Pressing and holding elsewhere on the workspace header for 250 ms also starts
  dragging, provided pointer movement remains within 4 px during the hold.
- A quick click keeps the current expand/collapse behavior.
- The existing new-session and more-actions buttons never start a drag.

### Active Drag

- The dragged workspace is represented by its header, with a slight lift,
  border, and shadow.
- Expanded sessions temporarily collapse visually during the drag. Their
  expanded/collapsed state is restored after drop or cancel.
- A 2 px insertion line shows the exact destination.
- Moving near the top or bottom of the project list auto-scrolls it.
- `Escape` cancels and restores the original order.
- Releasing outside a valid destination cancels.
- Text selection and conflicting header actions are suppressed only while a
  drag is active.

### Commit and Undo

- The renderer updates the list optimistically when the workspace is dropped.
- It sends the complete ordered array of workspace IDs to the main process.
- The main process validates and persists the order, then returns canonical
  project state.
- A successful reorder shows `已调整工作空间顺序 · 撤销` for five seconds.
- Undo sends the previous complete ID order through the same validated path.
- If persistence fails, the renderer restores the previous order and shows an
  error toast. It must not leave a successful-looking order that will disappear
  after restart.

### Search and Keyboard Behavior

- While the existing sidebar search query is non-empty, drag handles are hidden
  and all reorder commands are disabled. Sorting a filtered subset is ambiguous.
- A focused workspace header supports `Alt+ArrowUp` and `Alt+ArrowDown`.
- The workspace context menu provides `移到顶部`, `上移`, and `下移` where each
  action is applicable.
- Keyboard moves announce the workspace name and new position through an
  `aria-live` status.

## Space Center

### Entry

- Add a square grid-icon button immediately to the right of `globalSearch`.
- The button is the same 34 px height as the current search field and includes
  tooltip, accessible label, `aria-haspopup`, and `aria-expanded`.
- `Command+K` on macOS and `Control+K` on Windows/Linux open Space Center.
- Opening Space Center focuses its search field.
- `Escape` or clicking the backdrop closes it and restores focus to the opener.

### Layout

- Use a centered overlay on the main work area rather than a popover constrained
  to the sidebar.
- Target width is 720 px, constrained to the viewport with a 16 px minimum edge
  gap. Height is content-driven with an internal maximum and scroll.
- The default workspace area uses three columns and three visible rows.
- More than nine workspaces remain available by scrolling within the grid.
- At narrow widths the grid reduces to two or one columns rather than clipping
  labels.
- On open, the current workspace is selected and scrolled into view.

### Workspace Cards

Each workspace card shows:

- Workspace name.
- Most recently updated session title, or `暂无会话`.
- Relative last-activity time.
- Existing running, completed-unviewed, or failed attention state when present.

Hovering or keyboard-selecting a card updates the recent-session panel without
switching the active workspace. Clicking a card, or pressing `Enter` while it is
selected, switches to that workspace's most recently updated session and closes
the overlay.

If a workspace has no session, the same action switches to the workspace and
shows its existing empty state. It does not create a session implicitly.

### Recent Sessions

- The panel below the grid shows the selected workspace's three most recently
  updated sessions.
- Each row shows title, relative time, and the existing runtime/attention state.
- Clicking or pressing `Enter` on a session switches directly to that session.
- Switching away from a running session does not interrupt it.
- Existing per-session composer draft preservation remains unchanged.

### Search

- Typing searches workspace names, workspace paths, and session titles in the
  already-loaded local state.
- With a non-empty query, the grid changes to grouped `工作空间` and `会话`
  results.
- Results retain workspace context so identical session titles are
  distinguishable.
- Arrow keys move the active result while focus remains in the search field.
- `Enter` opens the active result.
- Empty results show a concise no-results state without management actions.

### Empty and Stale States

- With no workspaces, Space Center shows `添加工作空间` as its single primary
  action.
- If a workspace or session disappears before selection is committed, keep the
  overlay open, refresh local state, and show that the item is no longer
  available.
- If session switching fails, keep the current workspace/session unchanged,
  leave the overlay open, and show the returned error.

## Persistence and Migration

### Data Model

The order of `ProjectManager.projects` and the serialized `projects` array is
authoritative. No numeric rank field is added.

Add a top-level `workspaceOrderVersion: 1` marker to `projects.json`.

### One-Time Migration

When loading a configuration without `workspaceOrderVersion: 1`:

1. Stable-partition projects into previously pinned projects followed by
   previously unpinned projects.
2. Preserve relative order inside both partitions.
3. Remove the obsolete `pinned` property from every project.
4. Set `workspaceOrderVersion` to `1`.
5. Save once.

This preserves the order users effectively saw before the upgrade. New
installations start directly at version 1.

### Reorder Validation

`ProjectManager.reorder(projectIds)` accepts only an array that:

- Has exactly the same length as the current project array.
- Contains every current project ID exactly once.
- Contains no unknown ID.

Invalid input returns a structured error and performs no write. For a valid
input, the manager retains the previous array reference, applies the candidate
order, and persists it. A thrown save error restores the previous in-memory
array before propagating the failure.

## Code Boundaries

- `src/main/project-manager.js`
  - Own migration, canonical ordering, insertion-at-top, and reorder validation.
- `src/main/ipc-projects.js`
  - Replace `project:pin` with `project:reorder`.
- `src/preload.js`
  - Replace `pinProject` with the narrow `reorderProjects(projectIds)` bridge.
- `src/renderer/modules/workspace-order.js`
  - Own pointer/keyboard reorder state, auto-scroll, optimistic update, rollback,
    and undo.
- `src/renderer/modules/workspace-switcher.js`
  - Own Space Center rendering, focus, search, grid navigation, and switching.
- `src/renderer/modules/project-tree.js`
  - Render drag affordances and delegate ordering behavior; remove pin actions.
- `src/renderer/app.js`
  - Initialize the switcher and share the existing search-query state needed to
    disable reorder while filtering.
- `src/renderer/index.html`, renderer styles, and i18n files
  - Add the button/overlay structure, responsive styling, and localized text.

No server or database changes are required.

## Failure Handling

- Invalid reorder payload: reject without mutation or disk write.
- Configuration save failure: restore main-process and renderer order; show an
  explicit error.
- Switch failure: preserve current active state and keep Space Center open.
- Duplicate switch activation: disable further activation until the current
  switch promise settles.
- Drag cancellation, application blur, or pointer cancellation: restore the
  pre-drag order and expanded states.
- Runtime status changes while Space Center is open: update the visible status
  without resetting search text or keyboard selection.

## Accessibility and Motion

- Drag handle and grid button have localized accessible names.
- Workspace headers participating in keyboard reorder are focusable.
- Grid navigation follows visual row/column order.
- Focus is trapped inside the modal while open and restored on close.
- Reorder and switch results are announced with `aria-live`.
- Motion is limited to short lift, insertion, and overlay transitions and is
  disabled under `prefers-reduced-motion`.
- Text truncates with a tooltip containing the complete workspace or session
  name.

## Verification

### Main-Process Tests

- Migrates mixed pinned/unpinned data with stable relative ordering.
- Migration is idempotent after `workspaceOrderVersion: 1`.
- Removes obsolete pinned state from persisted summaries.
- Inserts a new workspace at the top.
- Reopening an existing path preserves its position.
- Persists a valid complete reorder across reload.
- Rejects missing, duplicate, extra, and unknown IDs without writing.
- Restores in-memory order when save throws.

### Renderer Tests

- Quick click expands/collapses without starting a drag.
- Long press and handle drag both reorder.
- Pointer cancellation and `Escape` restore the original order.
- Search disables all reorder paths.
- Failed persistence rolls back; undo restores the previous order.
- Keyboard reorder emits the correct complete ID order and announcement.
- Space Center opens/closes with correct focus restoration.
- Current workspace is selected and visible on open.
- Workspace preview and exact session switching call the correct existing paths.
- Search groups workspace and session results and supports keyboard activation.
- Runtime status updates do not reset the current switcher state.

### Visual and Manual Checks

- Light and dark themes.
- Standard and large text modes.
- Wide and narrow application windows.
- Long workspace/session names.
- More than nine workspaces.
- Empty workspace list and workspace with no sessions.
- Drag auto-scroll with a long sidebar.

## Acceptance Criteria

- Users can manually place every workspace and the order survives restart.
- Existing users retain their effective pinned-first order after upgrade.
- No pin affordance or pin behavior remains in the workspace UI or public bridge.
- Reordering never accidentally expands, collapses, opens, or renames a workspace.
- Space Center opens from the search-row button and keyboard shortcut.
- Any loaded workspace or session can be found and opened from Space Center.
- The first nine visible workspace cards follow manual order.
- A failed reorder or switch leaves the previous valid state intact and explains
  the failure.
- The feature passes focused automated tests and the existing capability gate.
