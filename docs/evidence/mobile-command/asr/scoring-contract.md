# Mobile Command ASR Scoring Contract

Owner: **Mobile Command / ASR DRI**. Freeze this contract, schemas, corpus version, and thresholds before candidate output is inspected.

## Run validity and sample size

Use the identical randomized case order for every candidate/device/network cell. The corpus is balanced across environment × locale × length × intent. A decision run requires at least **500 attempted and 500 scored utterances per candidate**, **20 scored rows in every one of the 48 content cells** (so the effective frozen minimum is 960), **250 scored per OS**, **50 scored per OS × network profile** (`offline`, `connected`), and **50 scored per OS × capture mode** (`foreground`, `background`). Mixed-language key-term annotations are required. Exclusions are limited to predeclared capture corruption or revoked consent and are reported with reasons; provider errors remain failures. Every deficient stratum is listed in `missingInputs`; missing coverage emits `blocked` with no acceptance result.

If any required input in `README.md` is absent, emit only a `blocked` artifact with reasons. Do not impute, substitute candidates, or turn missing measurements into zero.

## Deterministic metrics

- Latency: monotonic elapsed milliseconds from audio-start to first non-empty partial, and audio-stop to accepted final. Report nearest-rank p50/p95 over scored utterances.
- WER = `(substitutions + deletions + insertions) / reference words`; lowercase and Unicode NFC only. CER uses Unicode code points after NFC and removes annotation-only spaces for zh-CN. Report both; do not transliterate or model-correct.
- Usable-command rate = cases whose normalized intent **and every annotated slot** exactly match / scored cases.
- Mixed key-term exact rate is micro-averaged: exactly preserved annotated names/files/apps / all annotated terms on `mixed` rows. Rows with no annotation add neither success nor denominator; absence of required annotations blocks the run.
- Flicker compares revision token arrays only before the previous revision's `activeTrailingStart`; each changed stable token is counted and normalized per 10 seconds. Changes inside the active trailing segment are not flicker. Revision IDs must be strictly increasing.
- Successful-final and draft-preservation rates use **all attempted rows**, including exclusions and provider errors, as denominator. A crash, timeout, missing final, provider error, or excluded row is not a successful final.
- CPU is time-weighted process average; `rssDeltaPeakMiB = process-tree peak RSS - process-tree baseline RSS` per utterance and its reported point is the median across utterances; battery is baseline-adjusted percentage points per 30 minutes; network is total bytes sent/received; cost is the provider invoice-unit calculation from billable audio seconds and the price artifact active on run date.

## Uncertainty and acceptance

Report analytic two-sided 95% Wilson score intervals (`z = 1.959963984540054`) for usable-command, slot exact, mixed key-term micro, successful-final, and draft-preservation proportions. Report 95% stratified bootstrap intervals (10,000 resamples, fixed seed `20260712`, resampling within matrix cells) for p50/p95 latency, WER/CER, flicker, revision-violation rate, CPU, RSS, battery, network, cost, and crash rate. Publish point estimate and both bounds; never interpret overlapping intervals as equivalence. In addition, publish exact integer counts for revision-order violations, crashes, and draft-preservation failures.

A candidate passes only when its point estimate meets every threshold and the conservative 95% bound also meets accuracy/reliability gates (lower bound) and latency/resource/flicker gates (upper bound):

| Gate | Acceptance threshold |
|---|---|
| First partial | p50 < 350 ms; p95 < 600 ms |
| Final after stop (10 s speech) | p50 < 800 ms; p95 < 1,200 ms |
| zh-CN short usable command | >= 0.95; report CER |
| Mixed key-term exact | >= 0.95 |
| Draft preservation | exactly 0 preservation failures across all attempted rows; Wilson interval is diagnostic only |
| Partial stability | <= 2 flicker rewrites / 10 s; exactly 0 revision-order violations |
| Device resources | CPU average <= 20%; baseline-adjusted process-tree `rssDeltaPeakMiB` <= 100 MiB; battery <= 3 percentage points / 30 min |
| Reliability | successful-final rate >= 0.99 across >= 500 utterances; exactly 0 crashes |
| Privacy/config | approved region, retention, logging, credentials, disable switch, and user copy |

No weighted aggregate may hide a mandatory failure. Draft preservation, crash, and revision order are exact zero-tolerance gates: any observed count above zero makes `overallAcceptancePass=false`, regardless of Wilson/bootstrap bounds. For ranking only after all gates pass, normalize each lower-is-better gated metric as `min(1, threshold/value)` and each higher-is-better gated metric as `min(1, value/threshold)`. Cost efficiency is `lowest measured candidate cost / candidate measured cost` for the same scored audio duration. Candidate score is the unweighted geometric mean of latency p95s, usable-command rate, mixed key-term rate, flicker, CPU, RSS, battery, successful-final rate, and cost efficiency. Privacy/config and draft safety remain non-compensable gates. Ties within confidence intervals remain ties and require an operational/privacy choice, not a numerical winner.

Raw event rows, scorer version/commit, provider/model/region, device/OS, app/build, network profile, artifact hashes, and price source must accompany every published score.
