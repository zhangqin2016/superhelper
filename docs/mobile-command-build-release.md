# Lily Mobile Command Pro Build And Release

## 1. Purpose

This document defines build, packaging, signing, environment configuration, and release flow for the Lily Workbench mobile surface.

## 2. Artifacts

Release artifacts:

- Mobile Web/PWA bundle.
- iOS native capability shell.
- Android native capability shell.
- Generated brand assets.
- Protocol schema package.

## 3. Package Layout

Preferred:

```text
web/mobile-command/
mobile-native/
docs/schemas/
scripts/generate-mobile-icons.mjs
```

`mobile-native/` loads the built Web app and exposes native bridge capabilities.

## 4. Environment Configuration

Build-time:

```text
MOBILE_COMMAND_PUBLIC_BASE_URL
MOBILE_COMMAND_WS_BASE_URL
MOBILE_COMMAND_PROTOCOL_VERSION
```

Runtime config comes from server:

- feature flags
- ASR provider selection
- TURN credential endpoint
- upload limits
- supported protocol versions

The authoritative deployment/provider gate is [MC-SPEC-023](mobile-command-infrastructure-deployment.md); privacy and telemetry gates are [MC-SPEC-024](mobile-command-privacy-retention-compliance.md) and [MC-SPEC-025](mobile-command-observability-support.md). Their current status is `evidence-needed`.

Do not bake secrets into mobile bundle.

## 5. Web Build

Commands:

```bash
npm run mobile:build
npm run mobile:test
```

Expected output:

```text
web/mobile-command/dist/
```

Build must:

- type-check
- validate schemas
- include PWA manifest
- include generated icons
- produce deterministic asset names where practical

## 6. Native Shell Build

### 6.1 iOS

Bundle id:

```text
com.lilyworkbench.mobile
```

Build:

```bash
npm run mobile:ios:sync
npm run mobile:ios:build
```

Requirements:

- Keychain entitlement
- APNs capability
- background upload capability
- camera permission string
- microphone permission string
- local network permission string if used

### 6.2 Android

Application id:

```text
com.lilyworkbench.mobile
```

Build:

```bash
npm run mobile:android:sync
npm run mobile:android:build
```

Requirements:

- FCM config
- foreground service permission if long uploads need it
- camera/microphone permissions
- file picker support
- Android Keystore

## 7. Signing

Secrets:

- iOS signing cert/profile
- Android keystore
- APNs credentials
- FCM credentials

Rules:

- no signing secrets in repo
- CI injects secrets
- local release signing requires explicit documented setup
- debug builds use separate bundle/application id suffix

## 8. Release Channels

| Channel | Audience | Capabilities |
|---|---|---|
| internal | team | all behind flags |
| beta | whitelist | Chat, upload, App Control |
| controlled | selected users | Desktop Control |
| stable | general | flags per rollout |

Desktop Control must remain remotely kill-switchable.

## 9. Compatibility

Mobile app checks:

- minimum protocol version
- desktop online and supported
- server supports mobile routes
- feature config enabled

If unsupported:

- show upgrade or unavailable state
- do not attempt fallback scripts
- preserve normal desktop Lily behavior

## 10. CI Gates

Required before release:

- mobile unit tests
- schema tests
- permission tests
- file transfer tests
- brand asset test
- PWA build
- iOS build smoke
- Android build smoke

Release is additionally **BLOCKED** until selected TURN/push/storage account and regional configuration evidence, capacity/load and dated cost evidence, privacy/cross-border approval, retention/deletion proof, telemetry redaction/cardinality tests, alert routing drills, diagnostics/support RBAC tests, store signing evidence, compatibility evidence, and rollback/kill-switch tests are accepted. Candidate provider documentation does not satisfy these gates.

## 11. Store Metadata

Name:

- Lily Workbench
- 智能工作台

Description:

- mobile command surface for user's Lily Workbench desktop

Privacy:

- explain remote control
- explain file upload
- explain voice transcription
- explain push notifications

No claim that mobile can operate desktop when desktop Lily is offline.

## 12. Rollback

Rollback levers:

- disable `desktopControlEnabled`
- disable `webrtcEnabled`
- disable `mobileCommandEnabled`
- revoke TURN credentials
- require minimum app version

Additional scoped levers required before rollout: disable new uploads, voice/provider calls, push dispatch, TURN credential issuance, and sensitive capability by region/account/device while preserving Chat Only/current desktop behavior. These levers are planned contracts, **not implemented evidence**.

Rollback must not delete user sessions or local desktop data.

For every lever, the release record must include config authority/audience, change command, propagation measurement, active-session result, stale-client result, audit event, rollback reversal, and a test proving baseline desktop capability remains intact. Missing or failed evidence blocks release.

## 13. Acceptance Criteria

- PWA installs with correct Lily Workbench branding.
- iOS shell can sign payloads using Keychain.
- Android shell can sign payloads using Keystore.
- Background upload works in native shells.
- Kill switches take effect without app update.
- Old desktop/server combinations degrade clearly.
