# AGENTS.md — project map for AI agents

This is the orientation map for any AI agent working in this repo. Read this
first, then the file(s) for the subsystem you're touching. **Working rules
(the 12-rule discipline) live in [CLAUDE.md](CLAUDE.md) — they govern every
task here.** This file is the "where things are + how to run them" map.

## What this is

**Lily Workbench** (`智能工作台`, package name `lily-workbench`) — a desktop
**Electron** app that gives non-developers a Claude Code–style smart workbench:
chat with streaming replies and tool cards, where each conversation drives a
long-lived `claude` CLI subprocess (`stream-json` protocol). It bundles a Python
runtime + LibreOffice so it can read/write/convert Office & PDF documents
locally, ships a curated skills catalog, and has its own server (licensing,
releases, skill registry, document-pack distribution) plus a Next.js web site.

Product stance worth knowing up front: **operations are driven by natural
language to the agent, not by piling on UI** (see `memory/no-ui-natural-language.md`),
and the document stack is **kept light for ordinary laptops** — heavy ML engines
are opt-in downloads, not bundled (see `memory/office-runtime-delegation.md`).

## Orientation (read in this order)

1. This file — the map.
2. `CLAUDE.md` — the 12 working rules (mandatory).
3. `memory/MEMORY.md` — index of hard-won project knowledge; the linked notes
   explain *why* things are the way they are (document stack, deploy flow, etc.).
4. The subsystem file(s) below for your task.

## Top-level map

| Path | What it is | Read it? |
|------|------------|----------|
| `src/main/` | **Electron main process** — the heart. ~97 modules: agent sessions, IPC, document pipeline, packs, runtime resolution, skills, sessions. | ✅ source |
| `src/renderer/` | **UI** (chat bubbles, tool cards, settings). `app.js`, `modules/`, `styles/`, `i18n/`. | ✅ source |
| `src/main.js`, `src/preload.js` | Main entry + preload bridge. | ✅ source |
| `server/` | **Backend** (Fastify): licensing, releases, skill registry, document-pack distribution. `src/routes/{admin,public}`, `src/services`, `migrations/`. | ✅ source |
| `web/` | **Marketing/admin web site** (Next.js). | ✅ source |
| `resources/` | Bundled assets: `runtime/` (Python reqs), `runtime-scripts/` (extract/render Python), `skills-catalog/` (skill content), `skills-registry/` (catalog JSON + i18n), `hooks/`, `agent-defaults/`. | ✅ source |
| `scripts/` | 115+ dev scripts: `test-*.mjs/.cjs` (the test suite), build/release/runtime tooling. | ✅ source |
| `deploy/baota/` | Production deploy (docker-compose + scripts). See `memory/server-deploy-flow.md`. | ✅ source |
| `docs/` | Design docs / plans / PRDs. Background, not always current — trust code + `memory/` over docs on conflicts. | 🔶 reference |
| `memory/` | Curated project knowledge for agents (the "why"). Start at `MEMORY.md`. | ✅ read |
| `fixtures/` | Test fixtures (e.g. `fixtures/office/` sample docs). | ✅ source |
| `bundles/` | **3.9 GB** generated Python+LibreOffice runtime per platform. Built by `scripts/build-runtime-bundle.mjs`. | ⛔ generated — don't read |
| `dist/`, `release/`, `release-keys/`, `generated-assets/`, `node_modules/`, `.lily-work/`, `.cache/` | Build output / deps / keys / scratch. `dist/` alone is ~75 GB. | ⛔ don't read |

## Key subsystems → where they live

- **Agent chat / sessions** (`src/main/`): `agent-session.js`, `control-protocol.js`,
  `user-message.js`, `session-runner-pool.js`, `turn-orchestrator.js`,
  `runtime-event-bus.js`. One long-lived `claude` subprocess per conversation;
  model/search/permission changes hot-update env over stdin. (README.md covers this in depth.)
- **IPC** (`src/main/ipc-*.js`, `ipc-handlers.js`): all renderer↔main channels.
- **Document read/extract** (`src/main/document-translator.js` → `resources/runtime-scripts/extract_document.py`):
  pre-send enrichment. Digital PDF via pdfplumber/pypdfium2, scans via RapidOCR (no torch).
  `vision-translator.js` routes images to the multimodal model. See `memory/office-runtime-delegation.md`.
- **Document render/verify** (`resources/runtime-scripts/render_document.py`): doc → page PNGs (LibreOffice→PDF→pypdfium2).
- **Optional engine packs** (`src/main/document-packs.js` + `document-pack-specs.js`):
  opt-in heavy engines (Docling) downloaded from a server-resolved Qiniu URL.
  Agent-facing install: skill `resources/skills-catalog/lily-document-packs/scripts/manage_pack.py`.
  Build artifacts: `scripts/build-document-pack.mjs` (supports cross-platform). See `memory/server-deploy-flow.md`.
- **Bundled runtime** (`src/main/runtime-python.js`, `runtime-node.js`, `spawn-env.js`):
  resolves the bundled venv/uv/LibreOffice/node for agent subprocesses; built from
  `resources/runtime/requirements-runtime.txt` by `scripts/build-runtime-bundle.mjs`.
- **Skills** (`src/main/skill-*.js`; `resources/skills-catalog/`, `resources/skills-registry/`):
  filesystem-discovered catalog + a registry JSON. First-party skills use the `lily-` prefix;
  do NOT edit the vendored `anthropics-*` skills. Presets in `skill-presets.js`.
- **Server** (`server/src/`): Fastify. `routes/public/` (app-facing), `routes/admin/` (admin CRUD),
  `services/`, `db.js`, `migrations/`. Deploys via `deploy/baota` (build-on-server docker-compose).

## Build / run / test

```bash
npm install
npm run start:dev        # run the app against your local claude + ~/.claude
npm start                # run with the bundled CLI + app config dir
npm run test:unit        # the test suite (also: node scripts/run-all-tests.mjs)
npm run server:dev       # run the backend locally
npm run web:dev          # run the web site locally
npm run build:runtime    # build the bundled Python/LibreOffice runtime (heavy)
npm run dist:mac         # / dist:win / dist:all — package installers
```

**Tests are auto-discovered**: any `scripts/test-*.mjs` (node) or `*.cjs`
(electron renderer) is picked up by `run-all-tests.mjs` — no registration needed.
Write a test as a sibling and it runs. Tests that need the bundled runtime skip
gracefully (and say so) when it's absent.

## Conventions

- The 12 rules in `CLAUDE.md` are not optional. Especially: surgical changes,
  read before write, fail loud, tests encode intent.
- Document work is **delegated to bundled Python**, never hand-rolled in JS.
- Don't add a second toolchain or UI panel when the agent + a script will do.
- After main-process protocol changes, fully restart the app (`npm start`).

## Common tasks → start here

| Task | Start at |
|------|----------|
| Change chat/streaming/tool-card behavior | `src/main/agent-session.js`, `src/renderer/modules/message.js`, `README.md` |
| Add/adjust document reading or OCR | `resources/runtime-scripts/extract_document.py`, `src/main/document-translator.js` |
| Add a Python dep to the runtime | `resources/runtime/requirements-runtime.txt`, then `npm run build:runtime` |
| Add a first-party skill | mirror `resources/skills-catalog/lily-template-fill/`; register in `resources/skills-registry/registry.json` + `skill-localization/zh-CN.json`; maybe `src/main/skill-presets.js` |
| Add/ship an optional engine pack | `src/main/document-pack-specs.js`, `scripts/build-document-pack.mjs`, server `routes/{public,admin}/document-pack*`; see `memory/server-deploy-flow.md` |
| Add a server endpoint | `server/src/routes/`, add a migration in `server/migrations/` if needed |
| Add an IPC channel | `src/main/ipc-handlers.js` (or an `ipc-*.js` module) |
