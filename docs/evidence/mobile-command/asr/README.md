# Mobile Command ASR Evidence Workspace

Owner: **Mobile Command / ASR DRI** (execution), with **Privacy** and **Operations** sign-off for remote candidates.

This directory is the fixed, non-product evidence root for MC-ADR-008. It defines the next reproducible experiment; it contains no audio and no fabricated measurements. An experiment is invalid unless its manifest validates against `corpus-manifest.schema.json` and every candidate's raw metrics validate against `raw-metrics.schema.json`.

## Fixed layout

```text
docs/evidence/mobile-command/asr/
  README.md
  corpus-manifest.schema.json
  event-row.schema.json
  raw-metrics.schema.json
  scoring-contract.md
  runs/<run-id>/                         # generated evidence; do not create before a real run
    corpus-manifest.json
    <candidate-id>__<device-id>__metadata.json
    <candidate-id>__<device-id>__raw-metrics.json
    <candidate-id>__<device-id>__events.ndjson
    SHA256SUMS
```

`run-id` is UTC `YYYYMMDDTHHMMSSZ_<12-char-corpus-hash>`. Artifact names use lowercase ASCII `[a-z0-9-]`; paths and SHA-256 hashes are recorded in the metrics file. Event rows validate against [`event-row.schema.json`](event-row.schema.json), and scored output validates against [`raw-metrics.schema.json`](raw-metrics.schema.json). Raw audio is external, consent-controlled input and must not be committed here. Transcripts must be redacted or synthetic-consented before commit.

Scorer owner: **Mobile Command / ASR DRI**. Freeze the scorer version and git commit in metadata, then run from the repository root:

```bash
node scripts/score-mobile-asr-evidence.mjs \
  --events docs/evidence/mobile-command/asr/runs/<run-id>/<candidate-id>__<device-id>__events.ndjson \
  --metadata docs/evidence/mobile-command/asr/runs/<run-id>/<candidate-id>__<device-id>__metadata.json \
  --output docs/evidence/mobile-command/asr/runs/<run-id>/<candidate-id>__<device-id>__raw-metrics.json
find docs/evidence/mobile-command/asr/runs/<run-id> -type f ! -name SHA256SUMS -exec shasum -a 256 {} + | sort > docs/evidence/mobile-command/asr/runs/<run-id>/SHA256SUMS
```

Metadata fixes `scorer.version`, `scorer.commit`, bootstrap seed/iterations, corpus hash, candidate/model/region, privacy facts, and input artifact hashes. The scorer performs no network calls.

## Corpus case IDs

Every corpus version must include all of these immutable dimensions. Case IDs use `<environment>.<locale>.<length>.<intent>.<sequence>`:

- environment: `quiet`, `street`, `headset`, `far-field`
- locale: `zh-CN`, `en-US`, `mixed`
- length: `short`, `long`
- intent: `ordinary`, `sensitive`
- sequence: zero-padded integer, for example `street.mixed.short.sensitive.001`

The Cartesian product is required, with equal case counts per cell. The five previously specified command phrases are referenced by stable annotation IDs; their text/audio is not duplicated into this repository without consent.

## Privacy and consent

- `consent.recording`, `consent.processing`, and `consent.researchUse` must be explicit; absence or `false` blocks execution for that case.
- The manifest records pseudonymous subject IDs, data class, capture/processing region, retention deadline, and deletion owner. It must not contain names, emails, phone numbers, credentials, or raw audio.
- Provider upload is allowed only when provider/model/region, retention/logging, subprocessors, credential owner, and cost terms are approved and recorded.
- Failed or revoked consent quarantines the case; it is not silently replaced after candidate results are visible.

## Blocked inputs

Do not start or score a run when any of these is missing: approved corpus and annotation hashes; required matrix cells or minimum sample size; consent; representative device/app versions; provider/model/endpoint region; test credentials for remote candidates; privacy/retention/cost approval; network profile; energy measurement method; or the composer draft-preservation prototype. Record the run as `blocked`, not zero, pass, or fail.

See [the scoring contract](scoring-contract.md), [the provider spike](../../../mobile-command-asr-provider-spike.md), and [the decision gate](../../../mobile-command-asr-decision.md).
