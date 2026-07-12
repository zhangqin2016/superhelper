# Mobile Command ASR Scoring Contract

Owner: **Mobile Command / ASR DRI**. Freeze this contract, schemas, corpus version, and thresholds before candidate output is inspected.

## Run validity and sample size

Use the identical randomized case order for every candidate/device/network cell. The corpus is balanced across environment × locale × length × intent. A decision run requires at least **500 scored utterances per candidate**, at least **20 per required matrix cell**, and representative iOS and Android runs. Exclusions are limited to predeclared capture corruption or revoked consent and are reported with reasons; provider errors remain failures.

If any required input in `README.md` is absent, emit only a `blocked` artifact with reasons. Do not impute, substitute candidates, or turn missing measurements into zero.

## Deterministic metrics

- Latency: monotonic elapsed milliseconds from audio-start to first non-empty partial, and audio-stop to accepted final. Report nearest-rank p50/p95 over scored utterances.
- WER = `(substitutions + deletions + insertions) / reference words`; lowercase and Unicode NFC only. CER uses Unicode code points after NFC and removes annotation-only spaces for zh-CN. Report both; do not transliterate or model-correct.
- Usable-command rate = cases whose normalized intent **and every annotated slot** exactly match / scored cases.
- Mixed key-term exact rate = annotated names/files/apps preserved exactly / annotated mixed-language key terms.
- Flicker = partial revisions that change already displayed stable tokens outside the active trailing segment, normalized per 10 seconds of speech. Revision IDs must be strictly increasing.
- Successful-final and draft-preservation rates use attempted cases as denominator. A crash, timeout, missing final, or provider error is not excluded.
- CPU is time-weighted process average; RSS is process-tree peak; battery is baseline-adjusted percentage points per 30 minutes; network is total bytes sent/received; cost is the provider invoice-unit calculation from billable audio seconds and the price artifact active on run date.

## Uncertainty and acceptance

Report 95% Wilson score intervals for proportions (usable, key-term, successful-final, draft preservation). Report 95% stratified bootstrap intervals (10,000 resamples, fixed seed `20260712`, resampling within matrix cells) for p50/p95 latency, WER/CER, flicker, CPU, RSS, battery, network, and cost. Publish point estimate and both bounds; never interpret overlapping intervals as equivalence.

A candidate passes only when its point estimate meets every threshold and the conservative 95% bound also meets accuracy/reliability gates (lower bound) and latency/resource/flicker gates (upper bound):

| Gate | Acceptance threshold |
|---|---|
| First partial | p50 < 350 ms; p95 < 600 ms |
| Final after stop (10 s speech) | p50 < 800 ms; p95 < 1,200 ms |
| zh-CN short usable command | >= 0.95; report CER |
| Mixed key-term exact | >= 0.95 |
| Draft preservation | 1.00 on all failure tests |
| Partial stability | <= 2 flicker rewrites / 10 s; 0 revision-order violations |
| Device resources | CPU average <= 20%; incremental RSS <= 100 MiB; battery <= 3 percentage points / 30 min |
| Reliability | successful-final rate >= 0.99 across >= 500 utterances; 0 crashes |
| Privacy/config | approved region, retention, logging, credentials, disable switch, and user copy |

No weighted aggregate may hide a mandatory failure. For ranking only after all gates pass, normalize each lower-is-better gated metric as `min(1, threshold/value)` and each higher-is-better gated metric as `min(1, value/threshold)`. Cost efficiency is `lowest measured candidate cost / candidate measured cost` for the same scored audio duration. Candidate score is the unweighted geometric mean of latency p95s, usable-command rate, mixed key-term rate, flicker, CPU, RSS, battery, successful-final rate, and cost efficiency. Privacy/config and draft safety remain non-compensable gates. Ties within confidence intervals remain ties and require an operational/privacy choice, not a numerical winner.

Raw event rows, scorer version/commit, provider/model/region, device/OS, app/build, network profile, artifact hashes, and price source must accompany every published score.
