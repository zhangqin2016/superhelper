# Lily Workbench Project Analysis

Date: 2026-06-12  
Scope: `/Users/zhangqin/aicode/ceshitermianl`  
Mode: read-only analysis plus one focused runtime verification

## Executive Summary

Lily Workbench is a multi-surface AI workbench:

- Electron desktop app for project/session management, chat, tool execution, permissions, diffs, skills, updates, and local runtime orchestration.
- Fastify/Postgres service for licensing, device registration, remote config, releases, plugin catalog, diagnostics, telemetry, and model gateway.
- Next.js web app for public pages and admin console.

The product architecture is directionally sound. The high-risk areas are concentrated rather than spread across the whole codebase:

1. High-privilege IPC and filesystem operations in the Electron main process.
2. Agent subprocess permissions and inherited environment.
3. Remote update/config/plugin supply chain trust boundaries.
4. Runtime turn lifecycle complexity across `AgentSession`, `TurnOrchestrator`, and renderer runtime state.
5. Renderer state and long-session UI performance.

The most important near-term work is not broad refactoring. It is tightening security boundaries where renderer input, remote config, and child process execution cross trust boundaries.

## Method

This analysis combined:

- Repository structure inspection with `rg --files`, `find`, and package metadata reads.
- Review of project guidance in `AGENTS.md` and `CLAUDE.md`.
- Review of existing architecture docs:
  - `docs/architecture-hardening-plan.md`
  - `docs/turn-event-architecture.md`
- Focused reads of key implementation files:
  - `src/main.js`
  - `src/preload.js`
  - `src/main/agent-session.js`
  - `src/main/agent-runner.js`
  - `src/main/ipc-filetree.js`
  - `src/main/spawn-env.js`
  - `src/main/permission-spawn-args.js`
  - `server/src/app.js`
  - `server/src/routes/admin.js`
  - `scripts/run-all-tests.mjs`
  - root, server, and web `package.json`
- Parallel specialist reviews for architecture, code quality/security, test/runtime, and frontend/product experience.

Verification actually run:

```bash
npm run test:runtime
```

Result: passed. The command covered runtime event schema, turn orchestration, agent runner, CLI payload processing, runtime adapter fixtures, diagnostics, tool lease behavior, session bootstrap, and spawn environment behavior. Warnings observed during the run were expected synthetic test cases for recovery/error paths.

Not run in this analysis:

- Full `npm run test:unit`
- Server migration/integration against Postgres
- Web build
- Electron app launch
- Release/dist packaging

## Project Shape

### Top-Level Components

| Area | Path | Role |
| --- | --- | --- |
| Electron main | `src/main.js`, `src/main/*` | Owns app boot, IPC, session storage, runner pool, subprocesses, permissions, updates, remote config, local files. |
| Electron renderer | `src/renderer/*` | Native ES module SPA for chat UI, project tree, settings, skills, runtime events, diffs, i18n. |
| Preload bridge | `src/preload.js` | Exposes `window.assistantClient` APIs from renderer to main process. |
| Backend service | `server/src/*` | Fastify app with admin/public APIs, Kysely/Postgres, model gateway, license/config/release/plugin services. |
| Web/admin app | `web/app/*`, `web/components/*` | Next.js public site and admin console. |
| Tests/scripts | `scripts/*`, `server/scripts/*` | Convention-based Node/Electron tests, release scripts, diagnostics, packaging helpers. |
| Docs/memory | `docs/*`, `memory/*` | Architecture plans, feature designs, incident learnings. |

### Runtime Flow

The primary desktop message path is:

```text
renderer composer
  -> window.assistantClient.sendMessage
  -> preload IPC
  -> main assistant IPC handler
  -> TurnOrchestrator.sendUserMessage
  -> SessionRunnerPool
  -> AgentSession
  -> long-lived CLI stdin
```

The response/event path is:

```text
CLI stdout/stderr
  -> AgentSession parser/runtime adapter
  -> TurnOrchestrator
  -> RuntimeEventBus
  -> assistant:runtime-events IPC
  -> SessionRuntimeStore
  -> message / turn-view renderer
```

Durable history is separate:

```text
SessionManager message files
  -> session:get-conversation
  -> renderer committed messages
```

This split is good: live runtime state and durable transcript are different responsibilities. The risk is that both must stay consistent through interrupts, queued turns, session switching, permission waits, tool leases, missing result events, and resume recovery.

## Architecture Assessment

### What Is Strong

- The architecture has clear product surfaces: desktop client, service control plane, model gateway, and web admin.
- Existing docs show intentional hardening work has already happened:
  - `docs/architecture-hardening-plan.md` records server route/domain splits and runtime event convergence.
  - `docs/turn-event-architecture.md` defines the current runtime event contract.
- Tests are script-heavy but broad. The root test system discovers many `scripts/test-*` files, reducing the chance of orphaned test files.
- Main process no longer appears to rely on legacy renderer event channels for production runtime state; the event bus/reducer model is documented.
- Server routes have been split into public/admin domain modules, reducing review blast radius compared with one giant routes file.

### Main Architecture Risks

#### 1. `AgentSession` Is Still a High-Risk Gravity Well

`src/main/agent-session.js` owns many responsibilities:

- CLI spawn/lifecycle.
- stdout/stderr parsing.
- runtime adapter ingestion.
- timers and absolute turn caps.
- missing `result` fallback behavior.
- interrupts and restart behavior.
- permission/question/hook broker interaction.
- tool lease tracking.
- deferred result settlement.
- usage recording.

This is understandable for a runtime boundary, but it means small edits can affect many user-visible states. The current rule should be fixture-first changes only. New CLI protocol shapes should become sanitized fixtures before behavior changes.

#### 2. State Authority Is Split Correctly, But Fragile

The intended authority model is:

- `SessionManager`: durable transcript and session metadata.
- `TurnOrchestrator`: live turn state and finalization.
- `RuntimeEventBus`: ordered transport.
- `SessionRuntimeStore`: renderer reducer.

That model is good, but the failure modes are subtle:

- UI can look idle while a runner is still active.
- A stale durable page can overwrite live-but-not-yet-persisted state.
- A terminal event can arrive before late tool output.
- Queue state can be confused with committed transcript.
- Session switching can replay events out of order if sequence/snapshot rules drift.

The existing runtime tests reduce this risk, but this area should remain one of the highest test-priority zones.

#### 3. Trust Boundaries Are Not Equally Hardened

The service-side device/config/gateway work appears more structured than some desktop-side IPC and subprocess boundaries. The main process currently exposes a broad capability surface through preload and registered IPC handlers. Any renderer compromise, future XSS, or accidental preload expansion can become filesystem or command-execution impact unless main-process validation is strict.

## Security and Correctness Findings

### P0: Filetree IPC Can Write/Delete Arbitrary Paths

Path: `src/main/ipc-filetree.js`

Observed behavior:

- `filetree:restore-file` writes `content` directly to `filePath`.
- `filetree:reject-change` writes `content` to `filePath`, or deletes `filePath` when rejecting an added file.
- The handler does not prove that the file is inside the active project.
- The handler does not prove that the file belongs to a recorded diff for the session.
- The handler trusts renderer-provided original content/status.

Impact:

If renderer IPC can be invoked unexpectedly, this becomes arbitrary write/delete under the user's OS permissions. Even if preload currently exposes only some of these paths, registered main-process handlers should defend themselves.

Recommendation:

- Resolve `sessionId -> project.path` in main process.
- Use `fs.realpathSync` for both project root and target path.
- Require containment under project root before any write/delete.
- For reject/restore, load original content/status from main-process diff capture state, not from renderer input.
- Add tests for:
  - path traversal outside project;
  - symlink escape;
  - missing diff record;
  - added file deletion only when diff status is server-side `added`.

### P0: Permission Bypass Flag Is Always Enabled at Spawn Time

Path: `src/main/permission-spawn-args.js`

Observed behavior:

`appendPermissionSpawnArgs` always appends:

```text
--allow-dangerously-skip-permissions
```

The comment explains that this is needed for native CLI bypass hot-switching.

Impact:

This may be required for product behavior, but it makes permission-mode correctness depend heavily on app-side mode selection and IPC safety. If session/global permission can be silently changed to bypass, the CLI is already spawned with bypass capability.

Recommendation:

- Treat bypass as a high-risk mode with explicit confirmation and visible persistent state.
- Audit all permission-mode IPC paths.
- Add tests proving default sessions cannot silently become bypass.
- Consider spawning with bypass flag only for sessions explicitly created or configured as bypass, if hot-switch behavior permits.
- Log/audit transitions into and out of bypass mode.

### P0: Agent Subprocess Inherits Full `process.env`

Path: `src/main/spawn-env.js`

Observed behavior:

`buildAgentSpawnEnv` builds subprocess env using:

```js
const env = {
  ...process.env,
  ...engineEnv,
  ...getSearchSpawnEnv(),
  ...getRuntimeEnvExtras(),
  ...
};
```

Remote runtime env is merged into model/runtime settings before conversion.

Impact:

Agent subprocesses and tools can receive host environment variables unrelated to the task. That may include cloud tokens, package registry credentials, shell hooks, CI secrets, local development keys, or behavior-changing variables. Remote config also creates an environment injection surface unless keys are allowlisted.

Recommendation:

- Replace `...process.env` with a minimal allowlist.
- Always include only required basics: `HOME`, `USERPROFILE`/Windows equivalents, controlled `PATH`, locale if needed, temp dirs if needed.
- Explicitly allow model/search/runtime variables.
- Deny dangerous keys such as:
  - `NODE_OPTIONS`
  - `ELECTRON_*`
  - `GIT_SSH_COMMAND`
  - `NPM_CONFIG_*`
  - package manager tokens/config
  - dynamic loader variables where relevant
- Add tests for dangerous env stripping and required env preservation.

### P1: Service Update Feed Trust Is Weaker Than Static Manifest Trust

Path: `src/main/update-manager.js`

Observed behavior:

- Static update checks verify detached manifest signatures.
- Service release checks trust service-returned release/feed metadata and pass feed URL into update flow.

Impact:

If the service response path, TLS endpoint, or release API is compromised, update metadata can be redirected. Platform package signatures may still mitigate final execution, but the app code has inconsistent trust rules.

Recommendation:

- Require signed release metadata for service release responses too.
- Restrict feed/download origins to configured trusted domains.
- Verify package hash before install/download handoff where possible.
- Show explicit warning for manual download URLs outside trusted origin.

### P1: Skill Registry Is Unsigned

Paths:

- `src/main/skill-manager.js`
- `src/main/skill-registry.js`
- `src/main/skill-installer.js`

Observed behavior:

- Registry can come from remote/service config.
- ZIP hash is checked, but the hash and download URL come from the same registry metadata.
- Registry URL validation allows `http:`.

Impact:

If registry metadata is compromised, attacker can replace both artifact URL and expected hash. Skills influence future agent behavior, so this is a supply-chain boundary.

Recommendation:

- Sign the full registry metadata.
- Allow HTTPS only, except explicit local development mode.
- Treat `sha256` as signed metadata.
- Require immutable refs for GitHub sources, preferably commit SHA.
- Add tests for unsigned registry rejection and HTTP rejection.

### P1: Safe Storage Falls Back to Base64

Paths:

- `src/main/remote-config.js`
- `src/main/service-client.js`

Observed behavior:

When Electron `safeStorage` is unavailable, sensitive cached text is base64 encoded rather than encrypted.

Impact:

This is effectively plaintext for device private keys and remote runtime secrets. It may be acceptable for some desktop environments, but it should not be silent.

Recommendation:

- Set sensitive cache files to `0600` where supported.
- Warn or disable secret caching when OS encryption is unavailable.
- Separate non-sensitive cache from private keys/API keys.
- Consider fail-closed for device private key persistence if encryption is unavailable.

### P2: Scheduled Task Permission Semantics Are Confusing

Path: `src/main/scheduled-tasks.js`

Observed behavior:

Task objects save a `permissionMode`, but automatic execution forces `dontAsk` for non-manual runs.

Impact:

The persisted configuration suggests one behavior while execution uses another. Future UI or maintenance work may assume the field is authoritative.

Recommendation:

- Either remove/ignore the field explicitly and document that unattended tasks are always `dontAsk`, or actually execute using task-level permission mode.
- Add tests for manual vs automatic scheduled task permission behavior.

## Frontend and Product Experience

### Electron Renderer

The renderer is a native ES module SPA rather than React/Vue/etc. `src/renderer/app.js` initializes many modules in sequence:

- composer
- message rendering
- session chrome
- project tree
- settings panel
- model settings
- skills UI
- permission settings
- scheduled tasks
- diff panel
- find bar
- updates/license/usage/support

This keeps dependencies light but creates implicit coupling through:

- DOM IDs/classes.
- the custom store in `src/renderer/modules/state.js`;
- dynamic imports;
- `window.assistantClient`;
- runtime event subscriptions.

### Renderer Risks

#### 1. App Root Is a Large Composition Hub

`src/renderer/app.js` is not huge by line count, but it wires nearly every UI subsystem. Ordering matters. New modules can accidentally rely on a side effect from an earlier initializer.

Recommendation:

- Keep adding initializer tests where possible.
- Document initializer ordering and ownership.
- Avoid putting business decisions in `app.js`; keep it as wiring only.

#### 2. Store Has Minimal Consistency Guarantees

`src/renderer/modules/state.js` provides key-level subscription and direct assignment. Some modules mutate nested state in place.

Risk:

- Session switching and runtime replay can diverge.
- UI refresh may rely on object identity accidentally.
- Mutations can bypass expected notification patterns.

Recommendation:

- Add helper functions for critical state transitions.
- Establish immutable update convention for `projects`, sessions, and runtime-facing state.
- Add targeted tests for session switching, runtime snapshot replay, and history sync.

#### 3. Long-Session DOM Retention Can Hurt Performance

`message.js` keeps per-session panels and hides inactive sessions. That is useful for quick switching, but long sessions and many projects can retain substantial DOM.

Recommendation:

- Define a cache eviction policy for inactive session panels.
- Keep live active turns, but allow old inactive session DOM to be rebuilt from durable history.
- Consider windowing/virtualization for large committed message lists.

#### 4. i18n Is Useful but Incomplete

Renderer has `zh-CN`, `en`, and `ar` support with RTL handling. Web has a separate i18n approach. There are still hardcoded user-visible strings in renderer modules, web actions, and forms.

Recommendation:

- Add a script to scan for hardcoded UI text in renderer/web.
- Move action error messages and form labels into dictionaries.
- Include `aria-label` text in i18n coverage.

#### 5. Accessibility Is Not Systematic Yet

Some dialogs use roles/ARIA, but focus management and keyboard access are inconsistent. The project tree and context menus appear mouse-first.

Recommendation:

- Define a focus-visible token/style.
- Add keyboard behavior for project tree, session items, context menus, and modal close/restore focus.
- Avoid `outline-none` unless replaced with a visible focus style.

### Web Admin

The web app uses Next.js App Router, Tailwind, server components, and server actions. It is structurally conventional and easier to reason about than the renderer, but it has less test coverage.

Risks:

- `next build` is the main validation; it is not enough for login/action flows.
- Admin action error text is partly hardcoded.
- Web design tokens and renderer design tokens are separate, so product consistency will drift.

Recommendation:

- Add at least a small admin action/unit test layer or Playwright smoke for login and one CRUD path.
- Align design tokens between `src/renderer/styles/base.css` and `web/tailwind.config.js`.

## Backend Service

### What Looks Good

- Fastify app setup is compact.
- Route domains have been split.
- Kysely/Postgres gives typed-ish query construction without a heavy ORM.
- Admin auth uses timing-safe comparison helpers.
- CI runs Postgres-backed migration and integration tests.
- Model gateway was already split into auth/providers/adapters per architecture docs.

### Backend Risks

#### 1. Admin Cookie Equals Session Secret

In `server/src/routes/admin.js`, successful login sets `lily_admin_session` to `config.sessionSecret`, and auth checks equality against that same secret.

Risk:

This is simple, but it means one global session value for all admins. Rotation invalidates everyone, and leakage of the cookie value is equivalent to leakage of the session secret.

Recommendation:

- Prefer signed session cookies with random per-login session IDs, or at least HMAC-signed payloads with expiry.
- Store active sessions server-side if revocation matters.

#### 2. In-Memory Rate Limit Is Basic

`server/src/app.js` uses a process-local map keyed by IP/header. This is enough for simple self-hosting but weak behind proxies or multiple replicas.

Recommendation:

- Document this as a basic guard, not production-grade abuse protection.
- If deployed behind a proxy, configure trusted proxy behavior explicitly.
- For multi-instance deployment, use shared rate limiting storage.

#### 3. Integration Tests Can Skip

`server:integration` can exit successfully when database setup is unavailable. That is useful locally but dangerous if misunderstood.

Recommendation:

- CI already provides Postgres, so this is acceptable there.
- Locally, document that `skipped` is not equivalent to passing integration coverage.

## Test and Verification Model

### Available Commands

Root:

```bash
npm run start:dev
npm start
npm run test:unit
npm run test:runtime
npm run test:renderer
npm run test:service
npm run test:release
npm run test:skills
npm run test:bench
```

Server:

```bash
npm run server:dev
npm run server:smoke
npm run server:migrate
npm run server:integration
```

Web:

```bash
npm run web:dev
npm run web:build
```

Build/release:

```bash
npm run pack
npm run dist:mac
npm run dist:win
npm run dist:all
npm run build:runtime
npm run verify:runtime
```

### CI Baseline

`.github/workflows/ci.yml` uses:

```bash
npm ci
npm --prefix server ci
npm --prefix web ci
npm run test:unit
npm run server:smoke
npm run server:migrate
npm run server:integration
npm --prefix web run build
```

Node version: 22.  
Postgres service: 16-alpine.

### Coverage Gaps

- Web has no explicit test script; build is the main check.
- Server tests are script-based rather than a conventional test runner.
- Electron renderer has import/module tests, but interactive accessibility and flow tests are limited.
- Security boundary tests should be expanded around IPC, spawn env, permissions, update metadata, and skill registry.

## Repository Hygiene

The `.gitignore` already covers:

- `node_modules/`
- `dist/`
- `**/.next/`
- `.env`
- `**/.env`
- release artifacts and local secret settings.

Local scans found `.next` and `.env` under `web/`, but current ignore rules indicate they are local generated/sensitive files, not intended repository content.

Current `git status` at analysis time showed many modified files and untracked files unrelated to this document. This analysis did not modify or revert them.

## Recommended Roadmap

### Phase 1: Security Boundary Fixes

Goal: prevent renderer or remote config from becoming filesystem/command execution escalation.

Work:

1. Harden `ipc-filetree` write/delete operations with project containment and server-side diff authority.
2. Add tests for path traversal, symlink escape, and invalid diff rejection.
3. Replace agent subprocess env inheritance with an allowlist.
4. Deny dangerous remote env keys.
5. Add permission-mode tests around bypass transitions.

Suggested verification:

```bash
npm run test:service
npm run test:runtime
npm run test:renderer
```

### Phase 2: Supply Chain and Update Trust

Goal: make all executable/configurable remote inputs signed or constrained.

Work:

1. Sign service release metadata.
2. Restrict update feed and download origins.
3. Sign skill registry metadata.
4. Require HTTPS registry URLs outside dev mode.
5. Pin GitHub skill sources to immutable refs.

Suggested verification:

```bash
npm run test:release
npm run test:skills
npm run test:service
```

### Phase 3: Runtime Stability

Goal: reduce regressions in long-running turns, queued turns, permissions, interrupts, and session switching.

Work:

1. Keep `AgentSession` fixture-first.
2. Add production-derived sanitized fixtures for new CLI protocol shapes.
3. Add regression tests for any new recovery path before implementation.
4. Avoid broad `AgentSession` refactors unless they move one isolated responsibility behind tests.

Suggested verification:

```bash
npm run test:runtime
npm run test:renderer
```

### Phase 4: Frontend State and Experience

Goal: make session/runtime UI behavior more predictable and scalable.

Work:

1. Add renderer state transition helpers for projects/sessions/runtime sync.
2. Define session panel cache eviction.
3. Add i18n hardcoded text scanner.
4. Add keyboard/focus baseline for project tree, session items, context menus, dialogs.
5. Align design tokens between renderer and web.

Suggested verification:

```bash
npm run test:renderer
npm --prefix web run build
```

### Phase 5: Backend/Admin Hardening

Goal: strengthen production admin/session behavior and observability.

Work:

1. Replace global admin session-secret cookie with per-login signed sessions.
2. Clarify proxy/rate-limit deployment behavior.
3. Add an admin smoke flow for login plus one mutation.
4. Ensure local integration skip is visibly reported as skip, not pass.

Suggested verification:

```bash
npm run server:smoke
npm run server:migrate
npm run server:integration
npm --prefix web run build
```

## Immediate Priority List

1. Fix `src/main/ipc-filetree.js` path/diff authority.
2. Fix `src/main/spawn-env.js` environment allowlist.
3. Review bypass permission mode from IPC to CLI spawn.
4. Sign skill registry and service update metadata.
5. Add tests around scheduled task permission semantics.
6. Add renderer state tests for session switching/runtime replay.
7. Add long-session DOM cache policy.
8. Add admin login/action smoke coverage.

## Open Questions

1. Is CLI bypass hot-switching a hard product requirement, or can bypass sessions be respawned with explicit flags only when selected?
2. Should remote config ever be allowed to set arbitrary runtime env keys, or should it be limited to known model/search/runtime settings?
3. Are skills considered trusted first-party packages, or should third-party marketplace support be treated as untrusted supply chain from day one?
4. Does the product need multi-admin session revocation, or is single-admin self-hosted operation the main deployment assumption?
5. What is the expected maximum number of sessions/messages held in renderer memory during normal use?

## Conclusion

The project is past the prototype stage. It already has meaningful architecture documentation, runtime event discipline, and broad script-based regression coverage. The next quality step should be security-boundary hardening, not cosmetic cleanup.

The highest return work is to make main-process IPC, subprocess environment construction, permission bypass, update metadata, and skill registry verification strict by default. Once those boundaries are safer, runtime stability and frontend state improvements can proceed with lower risk.
