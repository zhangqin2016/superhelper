# Ask path + image question flow (2026-09-02)

Colleague complaints about Q&A being slow/wrong. Traced both flows and measured
them against `messages.db` (197 tool-less Q&A turns, 33 bridged image turns).

## Measured baseline

| stage | p50 | p90 | max |
|---|---|---|---|
| text Q&A: `user.committed → turn.started` | 108 ms | 2001 ms | 68.8 s |
| text Q&A: `turn.started → first token` | 2978 ms | 7578 ms | 27.7 s |

Bridged image turns: preflight alone averaged **24.1 s**, committed→first token
**30.5 s** (min 13.6 s, max 71.0 s).

## Fixed

1. **Payload-free prompt layers.** `layerContent` always prepended the layer
   intro, so `layerBlock`'s empty guard never fired: every turn shipped 2–3
   context layers containing only their own preamble, and
   `extracted_attachments` told the model "here is platform-extracted attachment
   content, treat it as evidence" on turns with NO attachment. A 6-char question
   went from a **759-char envelope to 187**. `user_original_request` is exempt on
   purpose — it anchors `userOriginalLayerIndex` merges and is what
   `extractUserOriginalRequest` reads back.
2. **Bridged descriptions marked second-hand.** The answering model never sees
   the image on the bridge path, so the extracted layer now says so. Without it
   the description read as first-hand observation and follow-ups about
   undescribed detail were confidently invented.
3. **The bridge notice tells the truth** — names that the active model cannot
   read images, the cost, and that a vision model reads the original directly.
4. **Scheduled-task intent tightened.** Bare `提醒我`/`schedule`/`daily`/
   `weekly`/`到点`/`定时` matched, so "schedule 这个词怎么用" paid a blocking
   `parseDraftSmart()` model call before any answer. Weak keywords now require a
   clock time / explicit interval / weekday.
5. **Per-image bridge calls run concurrently** (cap 3, `VISION_CONCURRENCY`,
   max 6), keyed by index so evidence order matches the serial version, with
   per-image failure isolation. Extracted to `vision-bridge-runner.js`.

## Correction worth keeping — #5 did NOT fix the measured pain

Every bridged turn with recorded progress totals was **single-image** (12/12).
The 30 s average is ONE Qwen vision call, not serialization. Concurrency removes
a real N× cliff for multi-image and isolates failures, but buys nothing for the
observed cases. Do not re-file it as a latency fix.

**The only lever that helps single-image latency is not using the bridge** —
i.e. a vision-capable main model. `allowImageFileParts` = the active model's
`capabilities.vision`, defaulting to false when presets can't resolve. The next
real win is defaulting to / suggesting a vision model when the user attaches an
image, not micro-optimising the bridge.

## Also confirmed while tracing (don't re-derive)

- The turn record keeps the ORIGINAL image: `userCommitted` uses `displayFiles`,
  fixed before preflight, so stripping images from `files` only hides them from
  the model for that turn — not from the record or the UI.
- Images MUST stay stripped for non-vision models: an image part throws
  `AI_UnsupportedFunctionalityError` before the gateway (see
  `attachment-filepart-capability-gate`).
- `requireValidLicenseFresh()` sits at the top of `assistant:input`, before the
  message is echoed — a candidate for the admission tail (p90 2 s, max 69 s),
  not yet investigated.

Guards: `[gate: ask-path-hygiene]`, `[gate: image-question-path]`.
