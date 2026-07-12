# Lily Mobile Command Pro ASR Decision Gate

## Decision

Status: **evidence-needed**. No ASR primary or fallback provider is selected, and MC-ADR-008 remains `proposed`.

Authoritative API references confirm that browser/native speech interfaces exist. They do not establish vendor or Lily production performance, privacy, cost, credential, background, or failure behavior. No real device, shared corpus, provider credential, or deployed endpoint was tested, and no result is labeled accepted.

## Actual Result Against Acceptance

| Requirement | Actual result |
|---|---|
| p95 first partial < 600 ms | unverified |
| p95 final after stop < 1,200 ms | unverified |
| zh-CN usable-command accuracy >= 95% | unverified |
| mixed zh/en key-term preservation >= 95% | unverified |
| failure preserves draft/partial 100% | unverified |
| acceptable mid-range-device CPU / baseline-adjusted process-tree RSS delta / battery | unverified |
| accepted region/retention/credential/quota/cost path | blocked |

The full numeric gate and candidate evidence are in [the ASR spike](mobile-command-asr-provider-spike.md). The next run must use the fixed [evidence workspace](evidence/mobile-command/asr/README.md), [corpus manifest schema](evidence/mobile-command/asr/corpus-manifest.schema.json), [event-row schema](evidence/mobile-command/asr/event-row.schema.json), [raw metrics schema](evidence/mobile-command/asr/raw-metrics.schema.json), and [scoring contract](evidence/mobile-command/asr/scoring-contract.md). RSS is exclusively baseline-adjusted process-tree `rssDeltaPeakMiB = peak - baseline`, gated at <= 100 MiB.

## Constraints That Apply Before Selection

- Transcript patches require segment ID, monotonic revision, final flag, language/confidence metadata, and an explicit merge boundary that cannot overwrite user edits.
- Direct send remains off by default and cannot bypass sensitive-intent approval.
- Audio/transcript consent and processing location must be visible before capture/upload.
- Provider credentials belong to server/native secure configuration, never web content or logs; quotas and per-minute cost require a kill switch and bounded refusal.
- Audio retention defaults to none after transcription; any upload fallback needs accepted region, encryption, maximum TTL, deletion, and logging policy.
- Language detection must preserve zh-CN/en-US mixed terms and must not invent or polish commands.
- Offline/unavailable/low-confidence/over-quota behavior preserves typed text and last usable partial, then returns to text input.
- No automatic switch to an unconfigured third party is allowed.

## Blocking Artifacts And Next Experiment

Blocking artifacts are the approved versioned corpus/annotations, consent and scorer implementation, representative iOS/Android devices and app builds, provider/model/region and test credentials/endpoints, deploy-specific privacy/retention/cost evidence, background/network profiles, energy measurements, and composer patch/failure tests. Missing inputs produce a `blocked` artifact; they are never scored as zero or silently substituted.

Run [ASR spike §6](mobile-command-asr-provider-spike.md#6-next-reproducible-experiment) without changing thresholds after results are visible. A primary/fallback order may be chosen only after every mandatory threshold and privacy/operations review passes. Until then, the only safe degradation is editable text input with existing draft preserved.
