# OpenCode Source Version

The local `opencode/` directory is an ignored development reference copy, not
tracked project source. It should match the OpenCode engine and SDK versions that
Lily ships against.

- Upstream: `anomalyco/opencode`
- Source tag: `v1.18.11`
- Source commit: not pinned locally; the shippable engine/SDK versions are the
  npm packages below.
- NPM engine package: `opencode-ai@1.18.11`
- NPM SDK package: `@opencode-ai/sdk@1.18.11`

`opencode/` remains ignored because it is large with dependencies. The shippable
engine is the prebuilt binary fetched by `scripts/fetch-opencode-engine.mjs`.
When changing OpenCode versions, update this file together with
`package.json`, `package-lock.json`, and the default version in
`scripts/fetch-opencode-engine.mjs`.

## Local Development Copy

As of this update, the shippable OpenCode engine and SDK are pinned to
`v1.18.11`. The ignored local `opencode/` source copy is development reference
only; the shippable path does not depend on that copy:

- `npm run engine:opencode:all` fetches the prebuilt Win/Mac engine binaries.
- `scripts/smoke-opencode-session.mjs` verifies Lily's real shared-serve path.

The local source dependency install path still needs attention: `bun install`
with Bun `1.3.14` currently stalls at `Resolving dependencies` for a clean
OpenCode workspaces in this environment, even with `--config` pointed
at an empty config, `--minimum-release-age=0`, and the npm registry specified.
That blocks `scripts/opencode-dev.sh` until the Bun resolver issue or local
workspace dependency install is fixed.
