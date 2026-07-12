# Lily Mobile Command Icon Generation Script Spec

## 1. Purpose

This document defines `scripts/generate-mobile-icons.mjs`, which generates all mobile/PWA brand assets from the desktop canonical icon source.

## 2. Inputs

Required:

```text
resources/icon-source.png
```

Optional:

```text
resources/icon.png
```

The script must fail if `resources/icon-source.png` is missing.

## 3. Outputs

Output directory:

```text
web/mobile-command/public/brand/
```

Files:

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
apple-touch-icon-180.png
apple-touch-icon-167.png
apple-touch-icon-152.png
android-adaptive-foreground.png
android-adaptive-background.png
notification-icon-monochrome.png
notification-badge.png
favicon.ico
```

## 4. Processing Rules

- Preserve transparency for standard icons.
- Maskable icons include safe padding.
- Android adaptive foreground is transparent.
- Android adaptive background uses Lily brand background color.
- Notification icon is monochrome and readable at small sizes.
- Outputs are deterministic.
- Script prints generated file list.

## 5. Suggested Implementation

Use Node with an image library already available in the workspace if present. If adding a dependency, prefer a small maintained image processor and document why.

Pseudo-flow:

```text
read source
validate dimensions
generate standard sizes
generate maskable padded icons
generate apple touch icons
generate adaptive foreground/background
generate monochrome notification icon
write manifest asset map JSON
```

Asset map:

```json
{
  "source": "resources/icon-source.png",
  "generatedAt": "ISO timestamp",
  "files": []
}
```

## 6. Failure Conditions

Fail when:

- source missing
- source unreadable
- source too small below 512x512
- output directory cannot be created
- generated file missing

Warn when:

- source has no alpha channel
- notification monochrome contrast is low

## 7. Tests

Required:

- `scripts/test-mobile-brand-assets.mjs`

Assertions:

- all output files exist
- source path in asset map is canonical
- manifest can reference generated icons
- disallowed mobile-only names are absent
- regenerated output is stable enough for CI

## 8. Acceptance

- One command regenerates all mobile icons.
- Mobile app and desktop app visibly share the same icon identity.
- No hand-made alternate mobile logo is needed.
