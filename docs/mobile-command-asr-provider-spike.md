# Lily Mobile Command Pro ASR Provider Spike Evidence

## 1. Result And Evidence Boundary

Status: **evidence-needed**. Recorded 2026-07-12.

Only official candidate capability documentation was reviewed. No provider credentials, real iOS/Android device run, shared audio corpus, weak-network run, or battery measurement was available. Official documentation establishes candidate features and constraints only; it is not latency, accuracy, privacy-deployment, cost, or battery performance evidence. MC-ADR-008 remains `proposed`.

## 2. Predeclared Acceptance Thresholds

Every candidate must be tested on the same versioned corpus and devices:

| Metric | Acceptance threshold |
|---|---|
| First partial | p50 < 350 ms and p95 < 600 ms |
| Final after stop, 10-second speech | p50 < 800 ms and p95 < 1,200 ms |
| zh-CN short commands | >= 95% usable-command accuracy and reported CER |
| Mixed zh/en key terms | >= 95% exact preservation of the annotated names/files/apps set |
| Draft safety | 100% of network/provider/permission failures preserve prior draft and last usable partial |
| Partial stability | <= 2 disruptive rewrites per 10-second utterance; revision ordering is monotonic |
| Device cost | average CPU <= 20%, incremental RSS <= 100 MiB, and <= 3% battery per 30 minutes on the declared mid-range device |
| Reliability | >= 99% successful finals across 500 utterances; no crash |
| Privacy/config | processing region, retention, logging, credentials, disable switch, and user copy are verified for the deployed configuration |

The corpus must include the five command phrases previously specified, balanced zh-CN/en-US/mixed speech, quiet/street/headset/distant-mic conditions, short and long dictation, corrections, sensitive intents, offline mode, and controlled latency/loss profiles. Raw audio requires explicit approval and must not be committed by default.

## 3. Candidate Evidence Matrix

`PASS` below means only that an official source documents the named candidate capability. Performance cells remain `UNVERIFIED`.

| Candidate | Official capability evidence | Latency/quality | iOS/Android behavior | Privacy/retention/cost | Decision result |
|---|---|---|---|---|---|
| Browser Speech API | PASS — official browser API documentation describes speech-recognition capability; availability varies by browser | UNVERIFIED — no corpus or device run | UNVERIFIED — no iOS/Android browser run | UNVERIFIED — deployed processing/retention/cost not proven | UNVERIFIED; cannot be primary/fallback |
| Native OS Speech | PASS — official Apple/Android platform documentation describes native speech APIs | UNVERIFIED — no corpus or device run | UNVERIFIED — no native prototype/background run | UNVERIFIED — entitlements, on-device/server path, retention and quota not proven | UNVERIFIED |
| Lily Streaming ASR | PASS — current Lily specifications permit a configured streaming provider path | UNVERIFIED — no endpoint credentials or run | UNVERIFIED | BLOCKED — no deployed provider/config/privacy/cost artifact | BLOCKED |
| Lily non-streaming ASR | PASS — current Lily specifications permit configured upload/final transcription | UNVERIFIED — no endpoint credentials or run | UNVERIFIED | BLOCKED — no deployed provider/config/privacy/cost artifact | BLOCKED |
| Configured model transcription | PASS — candidate providers may document audio transcription capability | UNVERIFIED — no configured-provider corpus run | UNVERIFIED | BLOCKED — no accepted provider, credentials, region, retention, quota or cost evidence | BLOCKED |
| Text input | PASS — existing required fail-open behavior in the voice contract | Not an ASR candidate | Applicable on target UI once implemented | No audio leaves device | Verified required degradation, not an ASR winner |

Official source set reviewed on 2026-07-12: [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API), [Apple Speech framework](https://developer.apple.com/documentation/speech), and [Android SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer). These links support API candidacy only.

## 4. Actual Threshold Results

| Threshold | Result |
|---|---|
| p95 first partial < 600 ms | UNVERIFIED — no timed stream |
| p95 final < 1,200 ms | UNVERIFIED — no timed corpus |
| zh-CN usable accuracy >= 95% | UNVERIFIED — no annotated corpus |
| Mixed-language preservation >= 95% | UNVERIFIED — no annotated corpus |
| Failure preserves draft 100% | UNVERIFIED — no composer/provider integration |
| Partial stability | UNVERIFIED — no revision stream |
| Mid-range device CPU/memory/battery | UNVERIFIED — no device run |
| Privacy, retention, credential and cost acceptance | BLOCKED — no deploy-specific provider configuration or credentials |

## 5. Blocking Artifacts

- Accepted, versioned multilingual/noise corpus and scoring script.
- Representative iOS and Android devices plus declared browser/native-shell versions.
- Test credentials and deploy-specific endpoints for each configured remote candidate.
- Provider region, subprocessors, audio/transcript retention/logging, deletion, quota, and price evidence reviewed by privacy/operations owners.
- Reproducible network shaping and device energy measurement procedure.
- Composer patch prototype proving revisions cannot overwrite user edits and failures preserve drafts.

## 6. Next Reproducible Experiment

1. Freeze and hash the corpus/annotations; assign the same utterance order to every candidate.
2. Record device model, OS, app/browser build, network profile, provider/model/region, credential owner, and timestamp.
3. Capture partial/final monotonic timestamps, transcript revisions, CPU/RSS/energy, errors, and cost units into one normalized JSON schema.
4. Run at least 500 utterances per candidate, including offline and weak-network cases; calculate p50/p95, CER/WER, key-term accuracy, failure preservation, and crash rate with the same scorer.
5. Have privacy and operations owners verify the deployed retention/region/credential/cost facts.
6. Select a primary/fallback only if it passes all mandatory thresholds; otherwise ship text-only voice degradation and keep MC-ADR-008 proposed.
