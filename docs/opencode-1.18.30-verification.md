# OpenCode 1.18.30 upgrade verification — 2026-09-14

## Scope

Upgrade the source workspace from OpenCode/SDK 1.18.29 to 1.18.30. No installer
publication, production deployment, credential changes or customer-profile repair.
The existing unrelated database/auth/renderer changes remain in the shared tree.
The existing app version 0.1.175 is not a version bump made by this upgrade.

## Changes

- SDK declaration, lock root, resolved SDK package, engine fetch default and
  source-version document agree on exactly 1.18.30. npm changed one installed package.
- Resume binding adds only the explicit forward pair 1.18.29 -> 1.18.30. It does
  not infer compatibility from semver or relax ownership, workspace, skill or
  first-message checks. Stored binding metadata is not rewritten by validation.
- Unknown upgrades/downgrades preserve the previous fresh-engine/local-history
  fallback. Exact-match and legacy-unbound behavior remains unchanged.
- Lily's custom prompts, provider selection, plugin implementations and loop/
  recovery budgets are unchanged. No claim that Astra's upstream prompt replaces
  Lily's custom primary-agent identity.
- Registered the upgrade guards. In the shared workspace, also repaired a pre-existing gate linkage gap:
  `upstream-model-auth-failure` existed in the human document and its test passed,
  but the JSON registry entry was absent. That unrelated auth-gate repair remains
  unstaged with its auth implementation and is not included in the upgrade commit.

## Verified artifacts

`node scripts/verify-engine-bundle.mjs --platform <key>` passed for all four:

| Platform | Version | Evidence |
| --- | --- | --- |
| darwin-arm64 | 1.18.30 | executable `--version`, manifest/SDK, size/mode, local JIT-entitled codesign verification |
| darwin-x64 | 1.18.30 | manifest/SDK, size/mode, local codesign verification; not native Intel execution |
| win32-x64 | 1.18.30 | manifest/SDK and binary size; not native Windows execution |
| linux-x64 | 1.18.30 | manifest/SDK, size/mode; not native Linux execution |

Artifacts are generated under the existing ignored `bundles/<key>/opencode/`
locations. The previous Mac ARM engine was copied to a temporary location before
replacement solely for cross-version acceptance.

## Native acceptance (Mac ARM)

Explicitly executed `test-opencode-upgrade-native.mjs` with a retained executable
whose `--version` is 1.18.29. The test uses production config builder, shared
server manager and SDK adapter, real executable processes, HTTP/SSE and native
SQLite storage. The provider is a deterministic localhost fixture; profiles,
workspace, config and database are disposable and unrelated to customer data.

Passed assertions:

1. Old engine creates a user/assistant exchange; old process exits before upgrade.
2. New engine reopens the same database and resumes the exact same session ID.
3. All original message IDs remain identical; earlier user and assistant content
   reach the next provider request, not just the renderer history.
4. One new prompt adds exactly one user message and one assistant answer.
5. Stream fragments are observable before completion. The fixture waits for actual
   fragment delivery, avoiding false failures from legitimately coalesced instant
   responses. No production event behavior was changed to satisfy the test.
6. Lily's custom persona remains present.
7. Aborting a deliberately held stream settles the session; new work can run.
8. Restart on the learned Responses route uses `@ai-sdk/openai`, retains the same
   session and original context, sends one request and persists the response.

The expected engine `Aborted` diagnostic is produced only by the explicit
cancellation case. It is not an unexpected provider failure.

Separately passed `test-opencode-bundled-usage.mjs` on 1.18.30: four real native
session calls covering parent, child and compaction; replayed usage events are
deduplicated. The title helper has no native usage event and is not fabricated.

## Regression evidence

The results in this section describe the original shared-workspace acceptance,
including unrelated in-progress repairs. They are not evidence for the isolated
upgrade commit; see the submission verification section below.

- Red -> green: new version-alignment expectation rejected old SDK pin; upgraded
  pins pass. New resume tests rejected the approved pair before implementation.
- Red -> green: malformed array values could masquerade as versions after string
  coercion; the new pair exception now checks original values.
- Passed: resume binding, ensureSessionRunner resume/reset, continuity guard,
  resume artifacts, OpenCode config and model configuration tests.
- Passed: architecture boundaries (1,032 source files, 52 ratchets).
- Passed: gate linkage after repair (87 gates / 87 anchors).
- Initial full suite: 939/940 in 421 seconds. Sole failure was the pre-existing
  missing auth gate registry entry; it has been repaired and directly retested.
- Complete capability gate: PASS (324 test commands, including documented opt-in skips).
- Final full suite: PASS, **941/941 test commands in 424 seconds**, exit 0.
  Environment-dependent opt-in tests retain their explicit skips. The native
  cross-version test was additionally executed with the old binary supplied,
  rather than counting its default skip as acceptance.
- Specification review approved scope and the native Responses extension.
- Independent code-quality review approved; no critical or important findings.

## Submission verification — isolated upgrade tree

Before submission, fast-forwarded to remote `316c0bfc` (Windows 0.1.175
release records), preserving the unrelated dirty workspace. Exported only the
15 staged upgrade files plus that committed baseline to a temporary directory.
The exported staged tree was `1423cb67d33fbbd06ed7d97551e3ce5684c3bc73`;
only this report and the plan outcome were updated after testing.

- Used Node 22.19.0 and existing installed dependencies/generated resources.
  The export does not include uncommitted database, auth or renderer repairs.
- Final full suite: **931/931 commands passed in 414 seconds**, exit 0.
- Capability gate: **310 tests**, exit 0; architecture: **1,018 source files,
  52 ratchets**, exit 0. Counts differ from the shared workspace because its
  unrelated new tests/modules are intentionally excluded.
- Re-ran actual Mac ARM cross-version/Responses/abort acceptance and native
  parent/child/compaction usage test against the export; both passed.
- Re-ran all four engine bundle checks; versions and artifacts agree on 1.18.30.
- Independent staged-diff review found no blocking code or plan-completion issues.
- Scope/whitespace and added-line credential checks passed.

Validation setup issues were not hidden: initial attempts used the temporary
directory's old default Node or lacked development dependencies. After setup,
the first complete run was 928/931: missing Playwright/stock-app resources and
one UI timing failure. Resource links were restored; the UI case passed twice
individually, then passed in the final 931/931 full run. No product code or test
assertions were relaxed. Opt-in skips still apply; native acceptance was
explicitly executed separately.

Temporary submission logs: `/tmp/lily-upgrade-isolated-unit-final.log` and
`/tmp/lily-upgrade-isolated-gate.log`. These are verification evidence, not
release artifacts. No installer publication is included in this commit/push.

## Boundaries

- A default suite run explicitly skips cross-version native acceptance without
  `LILY_TEST_OLD_OPENCODE_BIN`; that skip must never be described as a native pass.
- Foreign-platform artifacts are downloaded and structurally verified, not executed
  on physical Windows/Linux/Intel Mac systems.
- No signed Lily installer, installed-client UI, production gateway or arbitrary
  long-running customer task acceptance was performed by this upgrade.
- No general downgrade guarantee, corruption cure or model-quality improvement is
  inferred from this patch release. Existing recovery/loop guards remain required.
- Existing custom `OPENCODE_BIN` overrides are not replaced by changing bundles;
  a previously running app must fully restart to use the new SDK/engine.

## Reproduction

```sh
node scripts/test-opencode-version-alignment.mjs
node scripts/verify-engine-bundle.mjs --platform darwin-arm64
LILY_TEST_OLD_OPENCODE_BIN=/absolute/path/to/opencode-1.18.29 node scripts/test-opencode-upgrade-native.mjs
node scripts/test-opencode-bundled-usage.mjs
npm run test:unit
npm run test:capability-gate
npm run test:architecture
git diff --check
```

This execution's raw logs are in `/tmp/lily-opencode-upgrade-raWNT0/` and are
temporary, not release artifacts. The test source above is the reproducible record.
