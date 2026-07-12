# Lily Mobile Command Pro UI Spec

## 1. Purpose

This document defines the mobile UI behavior for Lily Mobile Command Pro. The UI is a chat-first command surface with observability and safety controls, not a feature-panel product.

## 2. Navigation

Primary tabs:

- Command
- Live
- Files
- Approvals
- Devices

Command is the default tab. Live is unavailable until a remote session exists and permission allows observe/control.

## 2.1 Branding

The mobile app is the mobile surface of Lily Workbench, not a separate product brand.

Required:

- App display name uses the desktop product name: `Lily Workbench` / `智能工作台`.
- Mobile subtitle or context label may say `Mobile` / `手机端`, but the primary brand remains Lily Workbench.
- App icon, splash logo, in-app logo, favicon, PWA manifest icons, iOS home-screen icon, Android launcher icon, and notification icon must derive from the desktop icon source assets.
- Desktop canonical icon sources are under `resources/`: `icon-source.png`, `icon.png`, `icon.ico`, `icon.icns`, and `.iconset/`.
- Do not create a separate mascot, logo, color identity, or product name for the mobile app.
- Pairing QR, device list, push notifications, and approval prompts must identify the same Lily Workbench brand.

Allowed labels:

- `Lily Workbench`
- `Lily Workbench Mobile`
- `智能工作台`
- `智能工作台手机端`

Disallowed labels:

- standalone `Lily Mobile Command`
- unrelated app names
- icons not derived from the desktop icon source

## 3. Global States

Connection banner states:

| State | Text Intent | Action |
|---|---|---|
| desktop online | show connected desktop | none |
| desktop offline | explain commands cannot reach desktop | retry |
| reconnecting | show reconnect progress | cancel |
| chat only | remote command available, live unavailable | request live |
| live active | show current source and permission | exit live |
| permission pending | waiting for desktop approval | cancel request |
| degraded | live failed, chat still available | retry live |

The banner must never imply a command was delivered before server/desktop ack.

## 4. Command Tab

### 4.1 Components

- `ConnectionBanner`
- `Transcript`
- `ToolProgressList`
- `ApprovalInlineCard`
- `ArtifactList`
- `UploadQueue`
- `CommandComposer`

### 4.2 Composer

Controls:

- text input
- primary voice input
- camera
- file picker
- send

Rules:

- Send disabled while no desktop route exists.
- If desktop is offline, user can save draft but not send.
- Attachments show upload/staging state before send.
- Voice transcription is visible and editable unless direct voice send is enabled.
- Voice input is the primary mobile input path, not a secondary attachment flow.
- The composer must be usable with one thumb: press/hold or tap-to-speak, release/stop, review transcript, send.
- Text editing and voice continuation must work together; user can speak, edit a word, keep speaking, then send.

### 4.2.1 Voice-First Interaction

The Command composer should follow a low-friction voice interaction similar to the best consumer chat apps:

- Voice is available directly from the default composer, with no modal setup.
- Tap-to-speak and hold-to-speak are both supported.
- Recording state is obvious: waveform or level meter, elapsed time, cancel affordance, stop/send affordance.
- Transcription appears live or near-live in the composer.
- User can interrupt, correct text, continue speaking, and send without changing screens.
- Short utterances should not require an extra confirmation screen.
- Long utterances should be chunked into readable paragraphs while preserving original meaning.
- If transcription is uncertain, underline or lightly mark uncertain spans instead of blocking send.
- Voice failure falls back to text input with the partial transcript preserved.
- Background noise or permission failure must not clear draft text.

Required voice modes:

| Mode | Behavior |
|---|---|
| Tap to speak | Tap mic, speak, tap stop, transcript stays in composer |
| Hold to speak | Hold mic, release to stop, slide/cancel gesture available |
| Continue dictation | After transcript appears, tap mic again to append |
| Direct send | Optional user setting; sends after speech ends only when confidence and intent are clear |

Default behavior:

- Direct send is off.
- Transcript review is on.
- Partial transcript is preserved on network/transcription failure.

Voice UI states:

```text
idle
requesting_microphone
listening
transcribing_live
paused
transcription_failed_recoverable
ready_to_send
sending
```

Voice controls:

- Mic button remains visually primary on mobile.
- Send button appears only when there is text or staged attachment.
- Cancel recording must not delete existing typed text unless the user explicitly clears it.
- When microphone permission is missing, show one action to enable permission and keep text input active.

Voice safety:

- For sensitive actions, voice can draft the command but cannot bypass approval.
- Direct voice send never grants permissions.
- If the user says a high-risk instruction, the normal approval flow still applies.

### 4.3 Transcript

Shows:

- user messages
- assistant streaming text
- tool progress
- approvals
- artifacts
- recoverable errors

Do not show raw protocol errors. Show user-safe message and correlation id in details.

### 4.4 Empty States

No device:

- Prompt to pair a computer.

Device offline:

- Show last seen time.
- Explain Lily must be running on desktop.

No conversation:

- Show composer focused, no marketing hero.

## 5. Live Tab

### 5.1 Components

- `VideoSurface`
- `TouchLayer`
- `ControlToolbar`
- `KeyboardBar`
- `PermissionBanner`
- `StatsOverlay` in debug mode

### 5.2 Modes

| Mode | UI |
|---|---|
| Observe App | video, no touch input, request control |
| Control App | video, touch layer, keyboard |
| Observe Desktop | prominent privacy warning |
| Control Desktop | prominent red control indicator |

### 5.3 Gestures

| Gesture | Behavior |
|---|---|
| tap | left click |
| long press | right click/context |
| drag | pointer drag |
| two-finger scroll | scroll |
| pinch | mobile zoom only |
| keyboard button | opens text/shortcut panel |

Coordinates are normalized 0..1. UI does not compute desktop absolute coordinates.

### 5.4 Safety UI

During Observe/Control:

- show device name
- show permission level
- show remaining TTL
- show exit button always visible
- show source mode: Lily window or Desktop

Desktop Control requires explicit warning before request:

```text
You are asking to view/control the whole desktop. The computer must approve this, and control will expire automatically.
```

## 6. Approvals Tab

Approval card fields:

- risk level
- action summary
- affected resources
- requesting task
- requesting mobile device
- expiration
- allow once
- deny
- allow for TTL only when action type permits it

Risk visual language:

- Low: neutral
- Medium: caution
- High: strong warning
- Critical: deny by default; require explicit typed confirmation if ever enabled

Approvals expire visibly. Expired approval cannot be granted.

## 7. Files Tab

Sections:

- Uploading
- Staged for current task
- Results
- Recent transfers

File row states:

```text
queued
hashing
uploading
verifying
waiting_for_desktop
staging
ready
failed_recoverable
failed_final
expired
```

Actions:

- retry
- cancel
- attach to current command
- download
- ask Lily to process

Do not expose raw local desktop paths.

## 8. Devices Tab

Shows:

- desktop name
- online/offline
- Lily running
- last seen
- active remote session
- bound phones
- revoke device

Revocation confirmation:

- explain active sessions will end
- explain re-pairing is required

## 9. Error Display

Error UI includes:

- short human message
- recoverable action if any
- correlation id behind details

Do not show:

- stack traces
- raw server exception
- sensitive filenames in notifications unless user opted in
- screen/input/clipboard content

## 10. Responsive Layout

Portrait:

- Command optimized.
- Live has compact toolbar.

Landscape:

- Live optimized.
- Toolbar side dock.
- Keyboard panel overlays bottom only when open.

Touch targets:

- minimum 44px iOS / 48dp Android equivalent.
- exit/stop controls must remain reachable.

## 11. Accessibility

- All buttons have accessible labels.
- Remote control status is text + color, not color alone.
- Approval cards are screen-reader ordered by risk and action.
- Keyboard shortcuts panel is navigable without gestures.

## 12. Internationalization

All user-visible strings use i18n keys.

Required locales:

- zh-CN
- en-US

Sensitive action templates must avoid ambiguity and include affected resource placeholders.

## 13. Notifications

Notification categories:

- task completed
- approval required
- file ready
- desktop offline
- remote control revoked

Rules:

- notification opens exact session
- no screen content
- no clipboard content
- no sensitive body by default

## 14. Acceptance Criteria

- User can complete a normal task from Command without opening Live.
- Live failure returns to Command without losing task.
- Desktop Control request is visibly high risk.
- Active control can always be stopped.
- File upload state is visible from selection to staging.
- Approval decisions are unambiguous.
- Offline state never claims delivery.
