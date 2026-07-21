# 2026-07-21 — Windows compatibility audit & hardening

## Why

After the "activated but unusable" hardening (mac-centric), the user asked for
a Windows-specific audit. Three parallel audits covered: process management,
paths/filesystem, and install/diagnostics/integration. No P0 code bugs in the
packaged engine path, but two systemic P0s (release config + network stack)
and a batch of P1/P2s. Fixed the code ones same-day; release-config ones are
decisions (see Residual).

## Fixed (branch `feat/opencode-engine`)

- **System proxy** (P0): Node's global fetch (undici) ignores WinINET/macOS
  system proxy — on corporate/campus networks every activation/license/config/
  update call failed while the browser worked. New `src/main/proxy-aware-fetch.js`
  routes through Electron `net.fetch` (Chromium stack = system proxy) when the
  app is ready, falling back to global fetch in plain node/tests. Switched:
  service-client (3 sites), update-manager, artifact-download, skill-registry,
  runtime-pack-download, skill-github-installer (2), skill-manager service
  registry. **Deliberately NOT switched**: model-endpoint probes and localhost
  calls — probes must match the engine's direct connection, and localhost must
  never traverse a proxy.
- **Process tree kills**: new `src/main/process-tree-kill.js` (extracted from
  opencode-shared-server + extended). `stopPid()` fixes `job_stop` killing only
  the cmd.exe wrapper on Windows (orphaned python/node servers kept their ports
  while reporting "stopped"). taskkill fire-and-forget children now sink
  `error` events — an unhandled one would crash the main process on before-quit.
- **Diagnostics process scan** (P1 false-alarm): Windows `tasklist` gives only
  image names, so every Electron helper process looked like a rogue duplicate
  install — every healthy Windows machine got a warning + polluted telemetry.
  Now uses PowerShell CIM `Win32_Process` (ExecutablePath+CommandLine); if CIM
  is blocked (WDAC), the check SKIPS — never falls back to tasklist's
  guaranteed-false positives.
- **Legacy-install healer**: a failed uninstall no longer records
  `handledSignature` — next launch re-offers cleanup instead of leaving a
  half-removed install we never mention again.
- **Registry skill id whitelist** (`skill-registry.js`): remote registry ids are
  path-joined; now must match `^[a-z][a-z0-9-]{1,99}$` like local skills —
  blocks path traversal (`../../x`) and Windows-illegal names (CON/NUL, `?`…).
  All 29 bundled ids already conform.
- **Filesystem transient locks**: new `src/main/fs-transient-retry.js` —
  `renameWithRetry`/`replacePackDirectory` extracted from
  runtime-pack-installer, plus `rmDirWithRetry` (uninstall: lingering
  soffice.exe locks) and `renameSyncWithRetry` (never-throws, for
  session-manager's timer-callback save where an escape crashed the main
  process). Runtime-pack uninstall now retries and keeps state on persistent
  failure; a locked backup dir no longer fails a succeeded install; IPC
  uninstall returns structured errors like install.
- **settings.json bridge**: Windows file symlinks need SeCreateSymbolicLinkPrivilege
  (admin/dev-mode) — every session silently lost settings/hooks. Now copies the
  file on win32 (dir links keep using junction, which needs no privilege).

## Ratchet discipline

All ratcheted files were kept AT or UNDER budget via extraction
(process-tree-kill.js, fs-transient-retry.js) and line-compaction — the
project convention is budgets only move DOWN (see git log of
`src/shared/architecture-boundaries.json`).

## Residual known items (decisions, not code)

- **Unsigned Windows installer** (P0 perception): release pipeline builds
  unsigned NSIS (`signAndEditExecutable:false`, `signExts:["!opencode.exe"]`,
  both pinned by test-windows-installer-guard.mjs) — SmartScreen blocks
  installs; unsigned opencode.exe risks AV quarantine. Needs a cert + release
  policy decision.
- **Crash-path orphan serve**: normal quit reaps the serve tree; a main-process
  crash on Windows leaves orphans holding install-dir locks (blocks updater).
  Proper fix = Windows Job Object (native); a pid-file reaper at startup is a
  cheaper mitigation. Not done.
- MAX_PATH: no long-path guard for deep runtime-pack venvs; mitigations noted
  (shallower default root, pre-install length check).
- tar.gz packs with symlinks fail extraction on non-admin Windows — ship
  Windows packs as zip without symlinks (build-side constraint).
- ps1 repair writes BOM'd model-settings.json which the app can't parse;
  `reg query` decoded as UTF-8 (GBK on zh-CN Windows); two generations of
  diagnostic scripts coexist with no in-product entry point.
- test: `scripts/test-windows-hardening.mjs` covers tree-kill, fs-retry,
  registry-id whitelist, proxy-aware fallback.

## Design rules added

- Any check whose evidence is platform-degraded must SKIP, never guess —
  a warning factory hides real problems ("狼来了" diagnostics).
- "Stop process" on Windows means "stop the TREE" (taskkill /T /F) — the
  recorded pid is usually a shell wrapper.
- Network code must state its proxy posture: system proxy (net.fetch) for
  product servers, direct for model endpoints (match the engine), never-proxy
  for localhost.
