---
name: server-deploy-flow
description: Lily Workbench deployment topology, Qiniu artifact flow, and runtime-pack release path
metadata:
  type: reference
---

## Current deployment topology (2026-07-04)

Lily uses **one universal client package**. Region differences are runtime policy from `GET /api/client/bootstrap`, not separate domestic/overseas builds.

- Control-plane/default API domain: `lilych.lilywb.cn`.
- Domestic policy: `region=china`, `apiBaseUrl=https://lilych.lilywb.cn`, login/purchase enabled, model mode gateway.
- UAE policy: `region=uae`, `apiBaseUrl=https://lilyxinjiapo.lilywb.cn`, login/purchase disabled, authorization-code activation enabled, model mode gateway.
- Official website entry: `www.lilywb.cn`; root `lilywb.cn` proxies to the same 101 service. The old transition domain should not be shown or used by clients.
- Domestic service host: `101.200.232.184`, Alibaba ECS (host iZ2ze4mpyqm4o3vcckrr75Z), baota + docker-compose, deploy dir `/www/wwwroot/lily-workbench`, PostgreSQL local to this host.
- Deprecated old domestic host: `182.92.107.175`; do not use for new service traffic.
- Overseas edge proxy host: `47.237.10.119` (Singapore, hostname `iZt4nj7tjqmlqll7mag7qwZ`). It does not run app state; it terminates HTTPS for `lilyxinjiapo.lilywb.cn` and proxies `/api/`, `/llm/`, `/health`, and web traffic directly to the domestic service ports on `101.200.232.184` (`13000` API, `13001` web). It must send `X-Lily-Region: uae` and `X-Forwarded-Host: lilyxinjiapo.lilywb.cn` so the domestic server returns/enforces overseas policy. The old UAE edge `47.91.106.148` is no longer the overseas entrypoint.

**Secret handling:** root passwords and Qiniu credentials were provided operationally, but must not be committed to the repo or memory files. Store them only in the operator's secret store, shell environment, CI secrets, or server `.env` as appropriate.

**Artifact distribution rule:** package all deployable artifacts first, then upload to Qiniu, then let each target server download and deploy with Docker. This applies to server images, client builds/installers, skills, apps, runtime packs, and related release artifacts. Current Qiniu bucket is `lanrensoft`, bound domain `qny.lanrensoft.cn`.

**Preferred deploy flow is image artifact via Qiniu.** `deploy/baota/push-images-via-qiniu.sh` (run with `SSH_HOST=182.92.107.175`) builds linux/amd64 Docker image tarballs for `lily-workbench-api:<tag>` and `lily-workbench-web:<tag>` via buildx, gzips them, uploads them plus `deploy/baota` to Qiniu via local **qshell** (account `lanrensoft-user`, bucket `lanrensoft`, domain https://qny.lanrensoft.cn), SSHes to the server, downloads them, `docker load`s both images, writes `DEPLOY_MODE=images` + `IMAGE_TAG=<tag>` into the preserved server `.env`, then runs `deploy.sh`. With `DEPLOY_MODE=images`, `deploy.sh` selects `docker-compose.images-app-only.yml` and runs compose without `--build`. `.env` is preserved across deploys. Server `.env` should use `DB_MODE=external`, `GATEWAY_MODE=external`, ports 13000/13001, and `DEPLOY_MODE=images`. Migrations still run on API container start (`npm run migrate && npm run start`). `deploy.sh` ends with an `/api/admin/health` check (exit 0 only if healthy). Legacy source-build flow still exists as `deploy/baota/push-via-qiniu.sh` and `DEPLOY_MODE` unset, but should not be the default for production pushes.

**SSH access for deploys:** dedicated passwordless key `~/.ssh/lily_deploy` (ed25519), authorized on the server, pinned via `~/.ssh/config` Host 182.92.107.175 → IdentityFile lily_deploy. The personal `~/.ssh/id_rsa` is passphrase-encrypted and useless non-interactively (don't rely on it / the ssh-agent in the Bash tool is separate from the interactive `!` shell's agent).

**Runtime-pack release path (see [[office-runtime-delegation]]):** `npm run build:runtime-pack -- --pack <id>` → tar.gz in `dist/runtime-packs/` → `node scripts/release-admin.mjs upload --bucket lanrensoft --key app/runtime-packs/<file> --file <file>` (qshell) → register via admin API: `POST https://lilych.lilywb.cn/api/admin/runtime-packs {packId, platform, version, url, sha256, sizeBytes}` (admin login: POST /api/admin/login). App resolves via public `GET /api/runtime-packs/artifact?pack=&platform=`. **pro-pdf darwin-arm64 2.102.1 was previously verified under the pre-rename document-pack path; after this runtime-pack rename, re-register it under `runtime_packs` before releasing/deploying the new server.** **Agent-facing install is DONE** (no UI): skill `lily-runtime-packs` + stdlib `manage_runtime_pack.py` (list/status/install/uninstall), curl-based download (urllib stalls on large CDN files), resolves via the public endpoint, extracts to `userData/runtime-packs/<id>`. spawn-env injects `LILY_USER_DATA_DIR`; runtime-python honors `LILY_RUNTIME_ROOT`. Still needed: win32/linux artifacts (build on each OS). NOTE: from this dev machine the CN CDN download is flaky/throttled (urllib timed out, curl+retry recovers resolve) — real users in China hitting the CDN are fine; don't mistake env flakiness for a code bug.
