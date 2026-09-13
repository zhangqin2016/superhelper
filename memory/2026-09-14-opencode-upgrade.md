# OpenCode 1.18.30 controlled upgrade

- Shipping SDK and default prebuilt engine are exactly 1.18.30. Update dependency,
  lockfile, fetch default, alignment test and version document together next time.
- Resume binding accepts ONLY the explicit forward 1.18.29 -> 1.18.30 exception.
  Do not broaden to all patch versions: storage/provider changes require their own
  native acceptance. All existing owner/workspace/skills/first-message checks stay.
- Lily sets a primary agent prompt; upstream Astra baseline is not automatically
  used. Do not delete Lily's general-workbench identity to enable a CLI baseline.
- OpenAI-compatible chat and OpenAI Responses are distinct adapters. The native
  upgrade test verifies both via the production builder without changing routing.
- `scripts/test-opencode-upgrade-native.mjs` needs an explicit retained 1.18.29
  executable in `LILY_TEST_OLD_OPENCODE_BIN`. Default skip is NOT native acceptance.
  Actual Mac ARM acceptance passed with real processes/SQLite/SSE and a localhost
  scripted provider: same IDs/history, streamed fragments, cancellation/new work,
  preserved persona, Responses continuation. This is not customer-model quality.
- `scripts/test-opencode-bundled-usage.mjs` separately verifies parent/child/
  compaction usage and replay dedup on the actual bundled engine.
- See `docs/opencode-1.18.30-verification.md` for final regression results and
  platform/release boundaries. No installer publication is implied by source upgrade.
