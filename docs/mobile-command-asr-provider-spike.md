# Lily Mobile Command Pro ASR Provider Spike

## 1. Purpose

This spike decides the production speech-to-text path for the mobile Command composer.

Goal: low-friction voice input comparable to leading consumer chat apps, while preserving privacy, editability, and approval safety.

## 2. Candidate Paths

| Candidate | Description |
|---|---|
| Browser Speech API | Use platform/browser speech recognition where available |
| Native OS Speech | Native shell calls iOS/Android speech APIs |
| Lily Streaming ASR | Lily-managed streaming ASR endpoint |
| Lily Non-streaming ASR | Upload short audio and receive final transcript |
| Model transcription | Route audio to configured model provider if available |

No unconfigured third-party fallback is allowed.

## 3. Evaluation Metrics

| Metric | Target |
|---|---:|
| first partial latency | < 600 ms |
| final transcript latency after stop | < 1200 ms for 10s speech |
| short command accuracy zh-CN | >= 95% usable |
| mixed Chinese/English names | preserves key terms |
| failure preserves draft | 100% |
| streaming partial stability | no severe flicker |
| mobile battery/CPU | acceptable on mid-range device |

## 4. Privacy Evaluation

For each candidate document:

- where audio is processed
- whether audio leaves device
- retention duration
- whether transcript is logged
- whether provider can be configured per deployment
- whether user-facing privacy copy is accurate

## 5. Test Script

Use phrases:

```text
帮我把桌面上的合同转成 PDF，检查签名页，然后发我手机
打开上周的报价表，看看公式有没有错
帮我把这个文件发给王总，但先让我确认邮件内容
Delete the test folder on my desktop
把 report-final-v3.docx 改成 PDF
```

Noise conditions:

- quiet room
- street noise
- headset mic
- phone held away from mouth

Languages:

- zh-CN
- en-US
- mixed zh/en

## 6. Spike Deliverables

Create:

```text
artifacts/mobile-command/asr-spike/results.md
artifacts/mobile-command/asr-spike/raw-metrics.json
```

Do not commit raw audio unless explicitly approved.

## 7. Decision Matrix

| Candidate | Latency | Accuracy | Privacy | iOS | Android | Cost | Decision |
|---|---:|---:|---:|---:|---:|---:|---|
| Browser Speech API | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Native OS Speech | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Lily Streaming ASR | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Lily Non-streaming ASR | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Model transcription | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

## 8. Recommended Decision Rule

Prefer:

1. Lily Streaming ASR if latency/accuracy are strong and deployment privacy is acceptable.
2. Native OS Speech as a low-latency option only if privacy copy and platform variance are acceptable.
3. Non-streaming fallback for reliability, not primary UX.

Reject any candidate that:

- clears drafts on failure
- cannot preserve user edits
- logs audio/transcripts unexpectedly
- cannot be disabled by server config
- routes to unconfigured third-party services

## 9. Acceptance

Spike is complete when:

- each candidate has measured latency and accuracy notes
- privacy path is documented
- final primary/fallback order is chosen
- config keys are finalized
- implementation tests are updated
