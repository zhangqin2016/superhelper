# Release And Deploy SOP

This document is the standard operating procedure for Lily Workbench releases
and production server deploys.

It describes the workflow that exists today. Do not invent an image-pull deploy
path unless the repo grows that pipeline first.

## Release Lines

There are three separate release lines:

| Line | What Ships | Primary Entry Point | Production Target |
| --- | --- | --- | --- |
| Desktop app release | macOS/Windows installers, static update manifest, auto-update feed, optional server release rows | `npm run release:one` | Qiniu CDN + API `releases` table |
| Server/web deploy | Fastify API, Next.js web/admin, Baota compose descriptors | `deploy/baota/push-images-via-qiniu.sh` | `lily.lanrensoft.cn` server |
| Runtime pack release | Optional heavy Python runtime pack, e.g. `pro-pdf` | `npm run build:runtime-pack -- --pack <id>` + `release-admin.mjs upload` + admin API register | Qiniu CDN + API `runtime_packs` table |

These lines can be deployed independently:

- Desktop release does not deploy server code.
- Server deploy does not build desktop installers.
- Runtime pack publish does not require a desktop release when the pack id is
  already supported by the app.

## Global Rules

1. Start from a clean working tree, except for intentional release metadata
   changes.
2. Do not skip verification gates. If a gate is skipped, say so in release notes
   and treat the release as risky.
3. Prefer dry-run first for publishing commands.
4. Never commit generated secrets, `.env`, release keys, `dist/`, `release/`,
   runtime bundles, or Python bytecode.
5. Keep server `.env` on the server. Deploy archives must preserve it and must
   not upload it to Qiniu.
6. Use one release line per operation. If server code and desktop app both
   changed, deploy and verify the server first, then publish the desktop app.

## Preflight

Run before any release or deploy:

```bash
git status --short --branch
git diff --check
npm run test:unit
```

For server or web changes, also run:

```bash
npm run deploy:baota:check
npm run server:smoke
npm --prefix web run build
```

For migration, config, release, gateway, or admin changes, run integration
against a real Postgres:

```bash
DATABASE_URL=postgres://integration:integration@localhost:5432/integration \
ADMIN_TOKEN=integration-token \
ALLOW_UNSIGNED_LICENSES=true \
npm run server:migrate

DATABASE_URL=postgres://integration:integration@localhost:5432/integration \
ADMIN_TOKEN=integration-token \
ALLOW_UNSIGNED_LICENSES=true \
npm run server:integration
```

If Postgres is not available locally, do not call the integration path "passed".
Call it "not run" and rely on CI or run it on a machine with Postgres.

## Desktop App Release

### Purpose

Publish installable app artifacts and update metadata.

`release:one` performs:

1. version bump in `package.json` and `package-lock.json`;
2. installer build;
3. signed static `latest.json`;
4. upload installers and manifest to Qiniu when `--upload` is set;
5. auto-update YAML feed upload;
6. optional publish to the API server `releases` table.

### Prerequisites

- `release-keys/license-private-key.pem` exists locally.
- `resources/license-public-key.pem` is the public key corresponding to the
  release private key.
- `qshell` is logged in on the release machine.
- For API release rows, either:
  - `RELEASE_ADMIN_TOKEN`, or
  - `RELEASE_ADMIN_EMAIL` and `RELEASE_ADMIN_PASSWORD`.

### Dry Run

Use dry-run before an upload release:

```bash
npm run release:one -- \
  --bump patch \
  --target mac \
  --notes "Release notes" \
  --dry-run
```

For an existing version:

```bash
npm run release:one -- \
  --version 0.2.0 \
  --target mac \
  --notes "Release notes" \
  --dry-run
```

### Publish

```bash
RELEASE_ADMIN_TOKEN=... \
npm run release:one -- \
  --bump patch \
  --target mac \
  --upload \
  --notes "Release notes"
```

Targets:

- `--target mac`: builds/publishes `darwin-arm64` and `darwin-x64`.
- `--target win`: builds/publishes `win32-x64`.
- `--target all`: requires both mac and Windows artifacts.

Use `--skip-server-publish` only when you intentionally want static CDN update
metadata but no API `releases` rows.

### Windows Store EXE Pre-Submission Gate

Before entering a Windows x64 NSIS EXE in Partner Center, follow
[windows-store-release-readiness.md](windows-store-release-readiness.md). Run the
lifecycle and signature gate against the same signed, versioned installer in an
offline Windows Sandbox and on a real, clean Windows standard-user VM, then retain
the generated reports. A macOS package-content check does not exercise Windows
install, launch, or uninstall behavior and cannot replace this gate.

### Desktop Release Verification

After publish:

```bash
curl -fsSL https://qny.lanrensoft.cn/app/updates/latest.json
curl -fsSL https://qny.lanrensoft.cn/app/auto-updates/darwin-arm64/stable/latest-mac.yml
curl -fsSL https://qny.lanrensoft.cn/app/auto-updates/darwin-x64/stable/latest-mac.yml
```

If server release rows were published:

```bash
curl -fsSL "https://lily.lanrensoft.cn/api/releases/latest?platform=darwin-arm64&version=0.0.0"
curl -fsSL "https://lily.lanrensoft.cn/api/releases/latest?platform=darwin-x64&version=0.0.0"
```

For Windows releases, also verify:

```bash
curl -fsSL https://qny.lanrensoft.cn/app/auto-updates/win32-x64/stable/latest.yml
curl -fsSL "https://lily.lanrensoft.cn/api/releases/latest?platform=win32-x64&version=0.0.0"
```

### Desktop Release Rollback

There is no automatic rollback command today.

Rollback options:

1. Disable the bad version in the admin `/admin/releases` page or API.
2. Publish a newer fixed version.
3. For static-only manifest issues, re-publish `latest.json` pointing at the
   last known-good artifacts.

Do not delete CDN artifacts during incident response. Disabling metadata is
safer and reversible.

## Server/Web Deploy

### Current Production Reality

Production server:

- domain: `lily.lanrensoft.cn`
- server: Alibaba ECS `182.92.107.175`
- deploy dir: `/www/wwwroot/lily-workbench`
- stack: Baota + Docker Compose

The preferred production deploy is image-artifact-through-Qiniu:

```text
local buildx builds linux/amd64 api/web image tarballs
  -> upload image tarballs + deploy/baota tarball to Qiniu
  -> SSH server
  -> server downloads tarballs
  -> docker load api/web images
  -> deploy/baota/deploy.sh
  -> docker compose -f docker-compose.images-app-only.yml up -d
  -> /api/admin/health check
```

The older `push-via-qiniu.sh` source-build path still exists for fallback, but
production pushes should use the image path so the server only downloads and
loads prebuilt images.

### Prerequisites

- `qshell` logged in locally.
- SSH access to the server. Current deploy key convention:
  `~/.ssh/lily_deploy` pinned in `~/.ssh/config`.
- Server `/www/wwwroot/lily-workbench/deploy/baota/.env` already configured.
- For production today, `.env` normally uses:

```env
DB_MODE=external
GATEWAY_MODE=external
API_PORT=13000
WEB_PORT=13001
PUBLIC_API_BASE_URL=https://lily.lanrensoft.cn
DEPLOY_MODE=images
IMAGE_TAG=<current-release-or-commit-tag>
```

### Pre-Deploy Gate

```bash
git status --short --branch
git diff --check
npm run test:unit
npm run deploy:baota:check
npm --prefix web run build
```

If API or migration changed, also run the Postgres migration/integration gate
from the Preflight section.

### Deploy

```bash
SSH_HOST=182.92.107.175 \
SSH_USER=root \
SSH_PORT=22 \
REMOTE_DIR=/www/wwwroot/lily-workbench \
deploy/baota/push-images-via-qiniu.sh
```

The script:

- builds `lily-workbench-api:<tag>` and `lily-workbench-web:<tag>` for linux/amd64;
- uploads both image tarballs and `deploy/baota` to Qiniu;
- downloads and `docker load`s the images on the server;
- preserves remote `deploy/baota/.env`;
- writes `DEPLOY_MODE=images` and `IMAGE_TAG=<tag>`;
- runs `deploy/baota/deploy.sh` remotely;
- exits non-zero if the admin health check fails.

### Server Deploy Verification

After deploy:

```bash
curl -fsSL https://lily.lanrensoft.cn/health
curl -fsSL https://lily.lanrensoft.cn/api/health
```

On the server:

```bash
ssh 182.92.107.175
cd /www/wwwroot/lily-workbench/deploy/baota
docker compose --env-file .env -f docker-compose.images-app-only.yml ps
docker compose --env-file .env -f docker-compose.images-app-only.yml logs --tail=100 api
docker compose --env-file .env -f docker-compose.images-app-only.yml logs --tail=100 web
```

Important gotcha: if SSH or server networking drops while images are loading or
compose is restarting, deployment may abort before containers are recreated.
Verify container uptime changed and images are `lily-workbench-api:<tag>` /
`lily-workbench-web:<tag>`.

### Server Rollback

The current image deploy has no one-command rollback.

Manual rollback:

1. Restore a previous source archive or checkout previous known-good commit on
   the server.
2. Preserve `deploy/baota/.env`.
3. Run:

```bash
cd /www/wwwroot/lily-workbench/deploy/baota
./deploy.sh
```

If a migration has already run, rollback may require a forward fix instead of a
schema rollback. Do not manually edit production DB unless you have an explicit
migration plan.

## Runtime Pack Release

### Purpose

Publish optional runtime packs without bundling every engine into every app
install. `pro-pdf` is the first example, but the release line is intentionally
generic because the platform is expected to support many runtimes over time.

Runtime packs are how Lily Workbench grows capability without making the base
desktop app heavy. A pack can provide document engines, language/tool runtimes,
conversion backends, analysis engines, or other local execution capabilities.

### Pack Model

Every runtime pack must be treated as an independently published artifact:

- `packId`: stable product identifier, for example `pro-pdf`;
- `platform`: target platform, for example `darwin-arm64` or `win32-x64`;
- `version`: pack version, independent from the desktop app version;
- `sha256`: required artifact integrity check;
- `sizeBytes`: expected download size;
- `enabled`: server-side switch for rollout and rollback.

The app should resolve runtime packs through the server registry, not by baking
download URLs into client releases. A desktop release is only required when the
app needs new runtime-pack integration code, UI copy, or skill support.

When adding a new runtime family, standardize these before first publish:

1. pack id and supported platforms;
2. artifact contents and install location;
3. health/probe command used after install;
4. skill or agent command that exposes the runtime to users;
5. server registry row and rollback owner.

### Build

Native platform build:

```bash
npm run build:runtime-pack -- --pack pro-pdf
```

Cross-build example:

```bash
npm run build:runtime-pack -- --pack pro-pdf --platform win32-x64
```

Cross-builds download target-platform wheels with `uv --python-platform` and
skip runtime probe verification because target wheels cannot run on the host.
Treat cross-build output as unverified until tested on the target OS.

The script writes a `.tar.gz` under `dist/runtime-packs/` and prints:

- `packId`
- `platform`
- `version`
- `sha256`
- `sizeBytes`
- local artifact path

### Upload Artifact

```bash
node scripts/release-admin.mjs upload \
  --bucket lanrensoft \
  --key app/runtime-packs/<file-name>.tar.gz \
  --file dist/runtime-packs/<file-name>.tar.gz
```

### Register Artifact

Register via admin API or admin UI.

API shape:

```http
POST https://lily.lanrensoft.cn/api/admin/runtime-packs
```

Body:

```json
{
  "packId": "pro-pdf",
  "platform": "darwin-arm64",
  "version": "2.102.1",
  "url": "https://qny.lanrensoft.cn/app/runtime-packs/pro-pdf-darwin-arm64-2.102.1.tar.gz",
  "sha256": "...",
  "sizeBytes": 244000000,
  "enabled": true
}
```

### Runtime Pack Verification

Public resolver:

```bash
curl -fsSL "https://lily.lanrensoft.cn/api/runtime-packs/artifact?pack=pro-pdf&platform=darwin-arm64"
```

Agent-facing install path:

```bash
python resources/skills-catalog/lily-runtime-packs/scripts/manage_runtime_pack.py list
python resources/skills-catalog/lily-runtime-packs/scripts/manage_runtime_pack.py status pro-pdf
```

Inside the app, ask the agent to install or check the runtime pack in natural
language. The skill uses `manage_runtime_pack.py` and installs under
`userData/runtime-packs/<id>`.

### Runtime Pack Rollback

Disable the bad row in `/admin/runtime-packs`. Do not delete the Qiniu object
first; disabling metadata is reversible and prevents new installs.

Existing local installs may remain on user machines. Publish a fixed newer pack
version when the installed pack itself is bad.

## What Is Not Standardized Yet

These are not current production workflows:

- Docker image build/upload/load deploy for the server.
- One-command server rollback.
- One-command runtime-pack register after upload.
- Automated post-release desktop update check from a real installed app.
- Signed runtime-pack metadata beyond HTTPS + sha256 from the server.

If these become requirements, implement them as new scripts and update this SOP
in the same change.

## Recommended Command Summary

Desktop release:

```bash
npm run test:unit
npm run release:one -- --bump patch --target mac --dry-run --notes "..."
RELEASE_ADMIN_TOKEN=... npm run release:one -- --bump patch --target mac --upload --notes "..."
```

Server deploy:

```bash
npm run test:unit
npm run deploy:baota:check
npm --prefix web run build
SSH_HOST=182.92.107.175 deploy/baota/push-images-via-qiniu.sh
```

Runtime pack:

```bash
npm run build:runtime-pack -- --pack pro-pdf
node scripts/release-admin.mjs upload --bucket lanrensoft --key app/runtime-packs/<file> --file dist/runtime-packs/<file>
curl -fsSL "https://lily.lanrensoft.cn/api/runtime-packs/artifact?pack=pro-pdf&platform=darwin-arm64"
```
