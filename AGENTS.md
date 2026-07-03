# AGENTS.md — project map for AI agents

This is the orientation map for any AI agent working in this repo. Read this
first, then the file(s) for the subsystem you're touching. **Working rules live
in this file and `CAPABILITY-GATE.md` — they govern every task here.** This file
is the "where things are + how to run them" map.

## What this is

**Lily Workbench** (`智能工作台`, package name `lily-workbench`) — a desktop
**Electron** app that gives non-developers an agentic smart workbench:
chat with streaming replies and tool cards, where each conversation drives a
long-lived local agent engine subprocess. It bundles a Python
runtime + LibreOffice so it can read/write/convert Office & PDF documents
locally, ships a curated skills catalog, and has its own server (licensing,
releases, skill registry, runtime-pack distribution) plus a Next.js web site.

Product stance worth knowing up front: **operations are driven by natural
language to the agent, not by piling on UI** (see `memory/no-ui-natural-language.md`),
and the document stack is **kept light for ordinary laptops** — heavy ML engines
are opt-in downloads, not bundled (see `memory/office-runtime-delegation.md`).

## Orientation (read in this order)

1. This file — the map.
2. `CAPABILITY-GATE.md` — the hard gate that prevents capability regressions.
3. `memory/MEMORY.md` — index of hard-won project knowledge; the linked notes
   explain *why* things are the way they are (document stack, deploy flow, etc.).
4. The subsystem file(s) below for your task.

## Working rules

These rules apply to every task in this project unless explicitly overridden.
Bias toward caution over speed on non-trivial work.

1. Think before coding: state assumptions, ask when uncertain, name ambiguity, and stop when confused.
2. Simplicity first: make the minimum change that solves the problem; no speculative abstractions.
3. Surgical changes: touch only what is necessary and match existing style.
4. Goal-driven execution: define success criteria and iterate until verified.
5. Use models for judgment, not deterministic routing/retries/transforms that code can do.
6. Respect token budgets; summarize and restart instead of silently overrunning.
7. Surface conflicts; choose the newer or more tested pattern instead of blending incompatible ones.
8. Read before writing: inspect exports, callers, and shared utilities before edits.
9. Tests verify intent, not just surface behavior.
10. Checkpoint after significant steps: what changed, what was verified, what remains.
11. Conform to local conventions; surface harmful conventions instead of silently forking them.
12. Fail loud: do not claim completion, passing tests, or certainty if anything was skipped.
13. Never let the product get dumber: capability changes must fail open to today's strong default and pass `CAPABILITY-GATE.md`.

## Top-level map

| Path | What it is | Read it? |
|------|------------|----------|
| `src/main/` | **Electron main process** — the heart. ~97 modules: agent sessions, IPC, document pipeline, packs, runtime resolution, skills, sessions. | ✅ source |
| `src/renderer/` | **UI** (chat bubbles, tool cards, settings). `app.js`, `modules/`, `styles/`, `i18n/`. | ✅ source |
| `src/main.js`, `src/preload.js` | Main entry + preload bridge. | ✅ source |
| `server/` | **Backend** (Fastify): licensing, releases, skill registry, runtime-pack distribution. `src/routes/{admin,public}`, `src/services`, `migrations/`. | ✅ source |
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
  `runtime-event-bus.js`. One long-lived local agent engine per conversation;
  model/search/permission changes hot-update env over stdin. (README.md covers this in depth.)
- **IPC** (`src/main/ipc-*.js`, `ipc-handlers.js`): all renderer↔main channels.
- **Document read/extract** (`src/main/document-translator.js` → `resources/runtime-scripts/extract_document.py`):
  pre-send enrichment. Digital PDF via pdfplumber/pypdfium2, scans via RapidOCR (no torch).
  `vision-translator.js` routes images to the multimodal model. See `memory/office-runtime-delegation.md`.
- **Document render/verify** (`resources/runtime-scripts/render_document.py`): doc → page PNGs (LibreOffice→PDF→pypdfium2).
- **Runtime packs** (`src/main/runtime-packs.js` + `runtime-pack-specs.js`):
  opt-in local engines/runtimes (first: Docling `pro-pdf`) downloaded from a
  server-resolved Qiniu URL. Agent-facing install: skill
  `resources/skills-catalog/lily-runtime-packs/scripts/manage_runtime_pack.py`.
  Build artifacts: `scripts/build-runtime-pack.mjs` (supports cross-platform).
  See `memory/server-deploy-flow.md`.
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
npm run start:dev        # run the app in development mode
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

- The working rules above are not optional. Especially: surgical changes,
  read before write, fail loud, tests encode intent, and never make the product dumber.
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
| Add/ship a runtime pack | `src/main/runtime-pack-specs.js`, `scripts/build-runtime-pack.mjs`, server `routes/{public,admin}/runtime-pack*`; see `memory/server-deploy-flow.md` |
| Add a server endpoint | `server/src/routes/`, add a migration in `server/migrations/` if needed |
| Add an IPC channel | `src/main/ipc-handlers.js` (or an `ipc-*.js` module) |
