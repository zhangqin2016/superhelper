# OpenCode Source Version

The local `opencode/` directory is an ignored development reference copy, not
tracked project source. It should match the OpenCode engine and SDK versions that
Lily ships against.

- Upstream: `anomalyco/opencode`
- Source tag: `v1.18.33`
- Source commit: not pinned locally; the shippable engine/SDK versions are the
  npm packages below.
- NPM engine package: `opencode-ai@1.18.33`
- NPM SDK package: `@opencode-ai/sdk@1.18.33`

`opencode/` remains ignored because it is large with dependencies. The shippable
engine is the prebuilt binary fetched by `scripts/fetch-opencode-engine.mjs`.
When changing OpenCode versions, update this file together with
`package.json`, `package-lock.json`, and the default version in
`scripts/fetch-opencode-engine.mjs`.

## Local Development Copy

As of this update, the shippable OpenCode engine and SDK are pinned to
`v1.18.33`. The ignored local `opencode/` source copy is development reference
only; the shippable path does not depend on that copy:

- `npm run engine:opencode:all` fetches the prebuilt Win/Mac engine binaries.
- `scripts/smoke-opencode-session.mjs` verifies Lily's real shared-serve path.

## 1.18.33 upgrade contract

The forward `1.18.30` → `1.18.33` transition is compatible with an existing
resume binding. It was earned by `scripts/test-opencode-upgrade-native.mjs`
with the real retained 1.18.30 binary and the fetched 1.18.33 binary on
darwin-arm64 (2026-09-28): same session and message ids, original context,
streaming, no duplicate turns, Lily prompt, abort and new work, OpenAI
Responses. Validated pairs live in `VALIDATED_ENGINE_UPGRADES`
(`src/main/resume-binding.js`); there are no transitive hops, so a binding made
by 1.18.29 starts a fresh engine session under 1.18.33, and downgrades remain
unvalidated. The native test reads the pair from the binaries themselves, so the
next upgrade runs the same proof and registers its pair only after it passes.

Upstream 1.18.30 → 1.18.33 changed no plugin or SDK types (the published type
definitions differ only in version) and no session, compaction, tool or event
code; the changes are provider SDK updates, MCP/Windows robustness, Gemini
thinking defaults and debug-config redaction.

## 1.18.30 upgrade contract

Only the explicit forward `1.18.29` → `1.18.30` transition is compatible with
an existing resume binding. Conversation, workspace, project, skills and first
user identity still must match; missing native artifacts retain the existing
fresh-session/local-history recovery path. This is not a general semver policy,
and a downgrade against newer native storage has not been validated.

Lily's build/plan prompts and provider routing remain unchanged. The new upstream
Astra baseline does not replace Lily's custom primary-agent identity. The OpenAI
Responses adapter is exercised separately from the OpenAI-compatible chat adapter.

Native cross-version acceptance (use a retained old executable, never a customer
profile) is reproducible with:

```sh
LILY_TEST_OLD_OPENCODE_BIN=/absolute/path/to/opencode-1.18.29 node scripts/test-opencode-upgrade-native.mjs
node scripts/test-opencode-bundled-usage.mjs
```

The first test explicitly skips unless the old binary is supplied. Its native
engine/SDK and real SQLite/HTTP/SSE are exercised against a scripted localhost
provider; it does not measure real-model quality or customer-task success rates.
See `docs/opencode-1.18.30-verification.md` for platform and regression evidence.

The local source dependency install path still needs attention: `bun install`
with Bun `1.3.14` currently stalls at `Resolving dependencies` for a clean
OpenCode workspaces in this environment, even with `--config` pointed
at an empty config, `--minimum-release-age=0`, and the npm registry specified.
That blocks `scripts/opencode-dev.sh` until the Bun resolver issue or local
workspace dependency install is fixed.
