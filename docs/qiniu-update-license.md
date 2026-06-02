# Qiniu Static Updates And Offline Licenses

This app supports a no-server release flow:

1. Qiniu stores signed update metadata and installers.
2. Activation codes are offline signed licenses.
3. The client contains only the public key.

## Key Setup

Generate an Ed25519 keypair:

```bash
npm run license:keygen -- release-keys
```

Copy `release-keys/license-public-key.pem` into:

```text
resources/license-public-key.pem
```

Keep `release-keys/license-private-key.pem` private. Do not ship or commit it.

## Generate Activation Codes

Recommended helper:

```bash
npm run release:admin -- license \
  --key release-keys/license-private-key.pem \
  --license-id LIC-2026-0001 \
  --customer "ACME" \
  --expires-at 2026-12-31T23:59:59Z \
  --plan pro \
  --seats 20 \
  --features workspace,mcp,plugins
```

The lower-level command is also available:

```bash
npm run license:generate -- \
  --key release-keys/license-private-key.pem \
  --license-id LIC-2026-0001 \
  --customer "ACME" \
  --expires-at 2026-12-31T23:59:59Z \
  --plan pro \
  --seats 20 \
  --features workspace,mcp,plugins
```

The command prints a token:

```text
base64url(payload).base64url(signature)
```

Users paste this token in Settings -> About -> License.

## Qiniu Update Layout

Recommended object keys:

```text
app/updates/latest.json
app/updates/mac/0.2.0/Lily Workbench-0.2.0-arm64.dmg
app/updates/mac/0.2.0/Lily Workbench-0.2.0-x64.dmg
app/updates/win/0.2.0/Lily Workbench-0.2.0-x64.exe
```

`latest.unsigned.json`:

```json
{
  "version": "0.2.0",
  "force": false,
  "notes": "Stability fixes and update support.",
  "platforms": {
    "darwin-arm64": {
      "url": "https://cdn.example.com/app/updates/mac/0.2.0/app-arm64.dmg",
      "sha256": "..."
    },
    "darwin-x64": {
      "url": "https://cdn.example.com/app/updates/mac/0.2.0/app-x64.dmg",
      "sha256": "..."
    },
    "win32-x64": {
      "url": "https://cdn.example.com/app/updates/win/0.2.0/setup-x64.exe",
      "sha256": "..."
    }
  }
}
```

Sign it:

```bash
npm run updates:sign-manifest -- \
  --key release-keys/license-private-key.pem \
  --in latest.unsigned.json \
  --out latest.json
```

Upload `latest.json` and installers to Qiniu.

## One Command Release Helper

Install and log in to Qiniu Qshell on the release machine first:

```bash
qshell account <AccessKey> <SecretKey> release
```

You can build the installer separately:

```bash
npm run dist:mac
```

Or let the release helper run the build first with `--build mac`.

Publish installers and the signed update manifest:

```bash
npm run release:admin -- publish \
  --key release-keys/license-private-key.pem \
  --bucket your-qiniu-bucket \
  --domain https://cdn.example.com \
  --version 0.2.0 \
  --prefix app/updates \
  --build mac \
  --artifact darwin-arm64="dist/Lily Workbench-0.2.0-arm64.dmg" \
  --artifact darwin-x64="dist/Lily Workbench-0.2.0-x64.dmg" \
  --notes "稳定性修复和更新能力" \
  --upload
```

For a dry run that prints the Qshell upload commands without uploading:

```bash
npm run release:admin -- publish \
  --key release-keys/license-private-key.pem \
  --bucket your-qiniu-bucket \
  --domain https://cdn.example.com \
  --version 0.2.0 \
  --artifact darwin-arm64="dist/Lily Workbench-0.2.0-arm64.dmg" \
  --dry-run
```

The helper writes:

```text
release/<version>/latest.unsigned.json
release/<version>/latest.json
```

It uploads each installer to:

```text
<prefix>/<platform>/<version>/<filename>
```

and uploads the signed manifest to:

```text
<prefix>/latest.json
```

## One Click Version Bump + Build + Upload

For normal releases, use the one-click command. It bumps `package.json`,
builds installers, finds the matching files under `dist/`, signs
`latest.json`, and uploads everything to Qiniu.

Patch release:

```bash
npm run release:one -- \
  --bump patch \
  --upload \
  --notes "修复会话状态和更新体验"
```

Specific version:

```bash
npm run release:one -- \
  --version 0.2.0 \
  --upload \
  --notes "新增插件市场和工作区体验"
```

Shortcut for both Windows and Mac:

```bash
npm run release:all -- \
  --bump patch \
  --notes "修复问题"
```

Targets:

```text
mac  -> npm run dist:mac, uploads darwin-arm64 and darwin-x64 DMGs if present
win  -> npm run dist:win, uploads win32-x64 EXE
all  -> npm run dist:all, uploads all matching installers
```

Defaults:

```text
bucket: lanrensoft
domain: https://qny.lanrensoft.cn
prefix: app/updates
key: release-keys/license-private-key.pem
```

Dry run without building or uploading:

```bash
npm run release:one -- \
  --version 0.1.0 \
  --skip-build \
  --dry-run
```

## Client Flow

In Settings -> About -> Updates:

1. Paste the Qiniu `latest.json` public URL.
2. Click Save URL.
3. Click Check updates.
4. If a signed newer version exists for the current platform, click Open download.

The first implementation intentionally opens the Qiniu package URL instead of
downloading silently. That keeps large installer failures visible and avoids
partial update state.
