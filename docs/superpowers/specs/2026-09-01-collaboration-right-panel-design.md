# Collaboration Right Panel Design

Date: 2026-09-01
Status: Approved design, pending implementation

## Outcome

Move Collaboration Center out of the main workbench surface and into an independent right-side panel. The panel is collapsed on every application start, opens on explicit user action, and never replaces or damages the primary AI conversation workspace.

The design combines two presentation modes:

- Wide windows use a docked, resizable panel that narrows the main conversation.
- Narrow windows use an overlay drawer that preserves the main conversation's width.

The application selects the mode from available width. Users do not manage a separate mode setting.

## Product principles

1. AI work remains primary. Collaboration is nearby, not in the way.
2. Opening Collaboration is one action; returning to work is one action.
3. The panel behaves like a focused desktop IM, not a compressed admin dashboard.
4. Failure is isolated. Collaboration errors must not hide, resize permanently, or disable the workbench.
5. Existing collaboration authorization, encryption, delivery recovery, reply, mention, edit, revoke, attachment, and social-command behavior remains unchanged.

## Shell architecture

The application shell gains a right-panel slot after the center workbench. The collaboration root moves into this slot instead of being mounted as a replacement surface inside the center panel.

The shell owns only presentation state:

- `closed`: no right-panel width is reserved and the collaboration content is inert.
- `docked`: the panel occupies a remembered width from 360 to 560 CSS pixels.
- `overlay`: the panel is positioned over the workbench with a dismissible scrim.

The initial state is always `closed`, including after restart. A remembered docked width may persist, but open/closed state does not persist.

The existing Collaboration controller continues to own navigation, data subscription, drafts, conversation selection, and command behavior. Moving the DOM must not create a second controller, subscription, transport, or collaboration state store.

## Entry and dismissal

The existing Collaboration entry becomes a compact right-panel toggle in the workbench top bar. It includes:

- a collaboration icon;
- an accessible `协作` label or tooltip;
- a bounded unread badge when unread count is positive;
- `aria-expanded` and `aria-controls` state.

Opening focuses the most relevant target in this order: active conversation heading, selected section heading, then the panel heading. Closing restores focus to the toggle.

The panel closes through the toggle, its close button, or `Escape`. In overlay mode, clicking the scrim also closes it. No close action discards collaboration drafts, pending sends, edit drafts, or the current in-panel navigation state.

## Responsive behavior

Docked mode is used only when the window can preserve a usable main conversation after reserving the panel. The breakpoint is derived from layout space rather than platform identity. Below that threshold, the panel becomes an overlay drawer.

Docked mode:

- default width: 420px;
- resize range: 360–560px;
- logical inline-start resize handle for RTL safety;
- width stored locally after a completed drag;
- main workbench remains at least its existing minimum usable width.

Overlay mode:

- width: `min(420px, 100vw)`;
- full-height right drawer with scrim;
- main workbench geometry does not change;
- the drawer traps focus while open and releases it on close.

Mode changes while open retain the selected section, conversation, draft, and scroll state. Reduced-motion users receive no sliding animation.

## Information architecture

The panel is a single-column IM surface. It does not reproduce the current three horizontal columns.

### Home level

The header contains the title, connection state, unread summary, and close button. Below it, compact tabs switch between:

- Messages
- Contacts
- Teams

The body displays one active list or directory at a time. Message rows contain avatar, title, last-message preview, authoritative time, unread count, and delivery/recovery state. Empty states use one concise instruction and no large decorative void.

### Conversation level

Selecting a conversation replaces the home body inside the same panel. The conversation header contains back navigation, identity, scope/status, and contextual actions. The timeline fills the flexible middle region. The composer is pinned to the bottom.

Reply, mention, attachment, edit, revoke, retry, cancel, and skip controls remain local to their message or composer context. Recovery states remain explicit and cannot be hidden by navigation.

Returning to the home level preserves the conversation draft and restores the prior list scroll position.

### Contacts and Teams

Contacts and Teams reuse the same single-column navigation model. Management details replace the body instead of opening another horizontal column. Destructive or membership-changing operations keep the existing explicit confirmation and server authorization boundaries.

## Visual system

The panel uses the existing application tokens and typography rather than introducing a separate theme.

- Surface hierarchy: shell background, elevated panel, subtle row hover, selected row tint.
- Borders: one outer divider in docked mode; soft shadow and scrim in overlay mode.
- Spacing: 8px base rhythm with compact 40–48px controls and 56–68px conversation rows.
- Radius: consistent with existing workbench controls; message bubbles remain visually subordinate to AI chat.
- Motion: 160–220ms for open, close, and in-panel level transitions.
- Density: information-rich but calm; no oversized headings or empty three-column canvases.

The layout must remain usable in Chinese and English, RTL locales, 80–200% zoom, high-contrast themes, reduced motion, and keyboard-only navigation.

## State and failure behavior

The Collaboration service may subscribe while the panel is closed only if required for the unread badge. Closing the panel must not stop durable recovery or mutate collaboration data.

If Collaboration is unavailable:

- the workbench remains byte-for-byte in its ordinary visible layout;
- opening the panel shows a bounded unavailable/retry state;
- the panel can always be closed;
- focus restoration still works;
- no stale asynchronous completion may reopen the panel or steal focus.

Account replacement, logout, membership revocation, and service replacement fence late UI callbacks using the existing navigation generation model.

## Accessibility

- The panel is a named complementary region in docked mode and a named dialog in overlay mode.
- Toggle, tabs, back, close, and resize controls have stable accessible names.
- Tabs use the tab/list relationship or an equivalent tested roving-focus pattern.
- Conversation updates retain the existing polite live-region behavior without announcing the whole panel.
- Focus never enters hidden panel controls.
- Escape closes only the topmost collaboration confirmation or panel layer.

## Implementation boundaries

Expected implementation areas:

- `src/renderer/index.html`: right-panel slot, toggle, panel header, and single-column hierarchy.
- `src/renderer/styles/layout.css`, `right-panel.css`, and `collaboration.css`: docked/overlay geometry, responsive mode, density, animation, and accessibility states.
- `src/renderer/modules/collaboration-center.js` and a small shell controller if needed: open/close, focus, resize, and in-panel level navigation.
- Renderer localization files: any new toggle, close, back, connection, and empty-state strings.
- Renderer/Electron tests: layout, lifecycle, keyboard, responsive, and unchanged-workbench fallback.

No server, database, encryption, message ordering, receipt, or transport protocol changes are required.

## Verification and acceptance

Automated acceptance must prove:

1. Collaboration is closed on every fresh application start.
2. Closed state reserves zero right-panel width and leaves the ordinary workbench visible.
3. The toggle opens and closes the panel and keeps `aria-expanded` accurate.
4. Wide layout docks at 420px by default and clamps resizing to 360–560px.
5. Narrow layout overlays without changing the workbench's measured width.
6. Open mode can change between docked and overlay without losing selected section, conversation, draft, or scroll position.
7. Escape, close button, and overlay scrim restore focus correctly.
8. Messages, Contacts, Teams, and conversation detail render one body level at a time; the old three-column canvas is absent.
9. Closing/reopening preserves drafts and recovery views but a process restart begins closed.
10. Collaboration unavailable, logout, account replacement, revocation, and late callbacks cannot hide the workbench or reopen the panel.
11. Keyboard navigation, RTL logical layout, zoom, reduced motion, and locale guards pass.
12. Existing collaboration capability tests and the full capability gate remain green.

Manual Electron acceptance uses wide and narrow window sizes and captures screenshots for the closed workbench, docked message list, docked conversation, overlay list, and overlay conversation.

## Out of scope

- New collaboration protocols or server endpoints.
- Multi-window collaboration.
- Persisting the open state across application restarts.
- Enabling production attachment/workspace object storage.
- Reworking the primary AI conversation layout beyond the minimum shell slot needed for the right panel.
