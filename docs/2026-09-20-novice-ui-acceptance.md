# Windows novice UI acceptance

Source Electron client, isolated stress profile, native UI; not a packaged
release or clean activated account test. Session:
`e47725e2-6490-4793-ac4c-9592a7e99d18` (ordinary-user unordered-operation test).
No security settings or permissions were changed by UI automation.

## Confirmed findings

1. P1: Missing attachment silently substitutes workspace files. In a NEW chat,
   click the homepage attached-table example, with NO attachment, then send.
   The agent recursively enumerated the workspace and read the earlier synthetic
   store workbook and Word report instead of asking for the absent attachment.
   It generated a DOCX/Markdown and attempted a runtime-pack install. UI reported
   25 completed steps and 78s. Source identity must be established before this
   work; a workspace file is not automatically the user's attachment.
2. P1: Mid-turn cancellation of output intent contradicts the final verdict.
   While running, send: "I have not uploaded the attachment; do not use old
   spreadsheets; do not generate files yet; wait for upload" via the offered
   interrupt/steer option. The UI acknowledged the addition. The agent later
   removed its generated files, but the final visible response was the host's
   missing-office-output message, not an acknowledgement that it was waiting.
   The string is in document-delivery-gate.js; exact intent propagation failure
   still needs tracing. Cleanup also deserves review: stopping generation is
   not an explicit request to delete already-generated files.
3. P2: Homepage example fills text but does not enable Send. Clicking the
   attached-table starter leaves a disabled Send button; double-click does not
   submit. Typing a punctuation character immediately enables it. The click
   handler in workbench-empty.js sets value/focus but emits no input event;
   composer.js refreshes Send on input. This is not model latency.

## Passed observations

- Manual typing enabled Send and the request started.
- Running-task send offered steer, queue and stop/send choices.
- Steer text appeared in the conversation and was acknowledged by the UI.
- Task returned to idle; this test did not reproduce a frozen window.
- Skills panel opened, and Escape closed it normally.

## Test setup hazard

Restarting with only LILY_USER_DATA_DIR/HOME/DOCUMENTS_DIR overrides still scanned
real APPDATA legacy roots, merging 226 rows into the test profile. Logs say the
source was retained after an EPERM copy failure, not archived. The test process
was stopped and relaunched with APPDATA and LOCALAPPDATA confined to the test
root. Only the stress workspace and synthetic files were used for the UI task;
imported conversations were not submitted to the agent. This is an isolation
finding, not evidence that normal customers always encounter migration failure.

## Scope

The initial pass above made no code changes. Follow-up work is recorded below.
No claim about all skills, real customer long tasks, fresh activation, media,
automatic updates or packaged-release acceptance. Existing workspace changes
were preserved. The test conversation is left idle for inspection.

## Repair and retest iterations

- Homepage starter now emits the same bubbling input event as ordinary typing.
  Native UI confirmed that clicking the starter alone enables Send and submits;
  no punctuation workaround is required. All three handlers have unit coverage.
- Accepted user steers have a turn-owned revision ledger used by final evidence
  assessment, objective coverage, parent-continuation capture and archive metadata.
  Rejected, finalizing and orphaned steers retain queue/ownership behavior.
  Added attachment manifests to initial and steered engine messages.
- Merely adding provenance guidance DID NOT fix source substitution in live
  tests. The actual engine input contained it. An inferred artifact contract
  (including output/checklist requirements) and overbroad full-autonomy guidance
  conflicted with source resolution. These failed iterations are retained in
  `novice-ui3` through `novice-ui5` logs in the isolated profile.
- Unbound new source tasks now receive source-resolution guidance before inferred
  output planning, without restricting models or tools. Creation, inherited
  source evidence, attached input, continuing tasks and external-fact policy keep
  their prior paths. Full autonomy no longer authorizes guessing input identity.
- Native session `ef9d0a4c-3203-471d-9448-d8d4cc58f9ec`, titled
  source-resolution acceptance in Chinese, asked for the missing attachment or
  an explicit filename. No tool cards/file processing occurred in that turn.
  Runtime was about 15s; final answer survived, window returned idle.
- Waiting-response applicability uses the actual turn model identity, not the
  obsolete global active preset. Structured reply parsing excludes reasoning
  text; malformed/unavailable verdicts retain existing literal validation.
  Native session `69d12277-3de3-4e91-a9b7-cfa3083e9da2` retained the requested
  wait/no-write/no-delete response after completion (about 8s). Log
  `novice-ui6-stdout.log` confirms `status=awaiting_input`.
- Counterexample: after explicitly naming the workspace XLSX and asking for
  three in-chat points with no output file, the engine read it, but the old
  document-output verdict still replaced its answer. Added semantic answer-only
  applicability: rerun source/numeric/fact evidence checks without demanding an
  office output. Native retest in `novice-ui8` preserved all three points;
  net sales 520000 and profit 201000 matched the synthetic workbook.
- Accepted mid-turn steer in that same session stopped Word delivery and
  preserved the waiting response at completion (64s, 10 steps). The model
  disclosed a helper script created before the pause instead of deleting it.
  Independent checks found no `output/插话验收报告.docx`; workbook SHA256 stayed
  `B0F711E06644C3D778222EDF3FD79AB74A5A16CDEEB6F629472B2EC08B4D3173`.
  This is cooperative steering at an engine boundary, not immediate cancellation
  of a tool already running.
- A negative test exposed inconsistent task types between the reclassified
  contract and evidence turn policy. Both now use the same answer-only scope;
  no-read/no-tool answers remain unverified. Existing numeric and external-fact
  checks are retained. Restarted the native client for another read-only pass:
  `novice-ui9` completed one read tool, retained all three data points and
  returned idle. Net sales/profit remained 520000/201000, no report appeared,
  source SHA256 remained unchanged. The log records `status=answer_only`.

Focused suites: source-resolution-guidance, turn-user-context,
document-delivery-response, turn-orchestrator-steer, task-contract,
task-original-acceptance, task-acceptance-recovery, document-delivery-gate,
evidence-entailment-judge, agent-autonomy-guidance and workbench-empty passed.
Acceptance recovery emits optional learned-skill warnings without a profile in
its test harness. These passes are not all-skill or packaged-release acceptance.
Follow-up in `2026-09-20-ten-round-native-qa.md` adds durable accepted-user-message
reads to retry, verified through reopened-store integration and the actual
isolated profile. No admission-schema migration is required. Native retry-button
acceptance and test-profile migration isolation remain separate gaps. The same
follow-up records an auxiliary-judge timeout regression and repaired fallback;
the initial successful waiting tests alone did not cover that failure path.
No commit, installer build or publication was performed.
