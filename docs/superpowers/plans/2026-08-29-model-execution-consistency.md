# Model Execution Consistency Implementation Plan

**Goal:** Repair the seven reproduced Auto/manual model defects without changing
the model picker or silently expanding the user's allowed model set.

**Architecture:** Resolve one host-owned execution snapshot per admitted turn.
Its public model profile carries identity, capabilities and budgets; its private
runtime environment stays in the main process. The selected environment drives
runner configuration, so primary, subagent, title and compaction calls agree.
Compatible sessions share an engine; incompatible execution profiles coexist
without restarting other sessions. Engine config files are immutable per profile.

**Tech Stack:** Existing Electron/Node modules, OpenCode adapter, Node test runner.

## Acceptance And Sequence

- [x] Add failing behavioral tests for wrong compaction budget, queued recovery,
  helper-model drift, missing requirements, image quality downgrade, per-model
  capabilities and usage attribution. Run `node scripts/test-model-execution.mjs`.
- [x] Normalize one public model profile and resolve its private environment from
  the same catalog read. Preserve source-turn model/provider identity on retries;
  reject a changed identity rather than silently switching suppliers.
- [x] Derive tool and context requirements before Auto selection. Keep the quality
  floor before vision preference. Known unsupported tools are ineligible; large
  retained history may compact, rather than forcing an unrelated model or failing
  a previously usable conversation.
- [x] Pass the execution environment into both runner creation paths. Use the
  selected model for pre-turn and background budgets, prompt handling and helper
  model pins. Keep credentials out of IPC, traces and archived receipts.
- [x] Share engines by complete configuration identity, not by mutable global
  selection. Retire unused incompatible profiles; reset all engines on shutdown.
  Verify concurrent A/B sessions and immutable config files with shared-server tests.
- [x] Split usage by session and model, bind sends to their admitted model, retain
  model-keyed usage and retry failed reports without mixing or double-counting local
  totals. Test overlapping flushes, model switches and failed uploads.
- [x] Run focused tests, then `npm run test:unit`; review capability gates and
  update the existing Auto design checkpoint with verified results and release limits.

## Verification

- Initial targeted regressions reproduced the seven failures before fixes.
- Full suite: `npm run test:unit`, **650/650 scripts passed in 308 seconds**.
  Loopback/Electron tests were rerun outside the restrictive sandbox after its
  initial EPERM/SIGABRT failures; no tests were disabled to obtain this result.
- Local upstream OpenCode provider Schema accepted the generated model limits
  and modality/tool configuration (no paid API request).
- Additional bulk-staging regression passed after extending the execution test.
- Final focused reruns passed: model selection, execution/runner, usage,
  shared-server profiles, context guard and turn orchestrator. Capability registry
  and architecture checks passed after documentation updates; `git diff --check`
  reported no whitespace errors.

## Scope

This repairs execution correctness. It does not claim semantic task-difficulty
classification, calibrated production quality/cost scores or paid-provider live
acceptance. No release, commit or deployment is part of this request.
