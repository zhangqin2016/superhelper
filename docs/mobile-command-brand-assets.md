# Lily Mobile Command Pro Brand Assets

## 1. Purpose

The mobile app is Lily Workbench on mobile. It must use the same product name, logo source, and visual identity as the desktop app.

## 2. Brand Rules

Allowed names:

- `Lily Workbench`
- `Lily Workbench Mobile`
- `智能工作台`
- `智能工作台手机端`

Disallowed:

- standalone `Lily Mobile Command`
- unrelated mobile-only app names
- separate mascot/logo
- icon style not derived from desktop source

## 3. Source Assets

Canonical desktop sources:

```text
resources/icon-source.png
resources/icon.png
resources/icon.ico
resources/icon.icns
resources/.iconset/
```

Mobile assets must derive from `resources/icon-source.png` unless design explicitly updates the canonical desktop source.

## 4. Generated Assets

Output location:

```text
web/mobile-command/public/brand/
```

Required PWA icons:

```text
icon-72.png
icon-96.png
icon-128.png
icon-144.png
icon-152.png
icon-192.png
icon-384.png
icon-512.png
maskable-icon-192.png
maskable-icon-512.png
```

iOS:

```text
apple-touch-icon-180.png
apple-touch-icon-167.png
apple-touch-icon-152.png
```

Android adaptive icon:

```text
android-adaptive-foreground.png
android-adaptive-background.png
```

Notifications:

```text
notification-icon-monochrome.png
notification-badge.png
```

## 5. Manifest

PWA manifest:

```json
{
  "name": "Lily Workbench",
  "short_name": "Lily",
  "description": "Lily Workbench mobile command surface",
  "display": "standalone",
  "orientation": "any",
  "icons": []
}
```

Chinese locale can display `智能工作台`.

## 6. Splash

Splash screen:

- use same logo mark
- no separate slogan
- background follows Lily desktop brand tokens
- safe-area aware
- dark mode variant required

## 7. Generation Script

Create:

```text
scripts/generate-mobile-icons.mjs
```

Inputs:

```text
resources/icon-source.png
```

Outputs:

```text
web/mobile-command/public/brand/*
```

Script requirements:

- fail if source missing
- preserve transparency for normal icons
- create maskable padding for PWA
- create monochrome notification icon
- print output file list
- deterministic output

## 8. Visual QA

Check:

- iOS home screen
- Android launcher
- PWA install prompt
- browser favicon
- notification icon
- splash screen light/dark
- pairing page brand
- approval prompt brand

No mobile-specific alternate logo allowed.

## 9. Tests

Required:

- `test-mobile-brand-assets.mjs`

Assertions:

- manifest name matches desktop brand
- required icon files exist
- icons generated from canonical source path
- disallowed standalone names absent from mobile UI config

## 10. Acceptance Criteria

- User sees the same Lily Workbench identity on desktop and mobile.
- App stores/home screen/notifications use matching icon family.
- Mobile app does not look like a separate product.
