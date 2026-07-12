# Lily Mobile Command Pro Voice Input Contract

## 1. Purpose

Voice is the primary mobile command input. It should feel as fast as speaking to a polished consumer assistant: tap or hold, speak, see text appear, correct if needed, continue speaking, send.

Voice input drafts commands. It never bypasses approval, permission, or audit.

## 2. UX Invariants

- Mic is visible in the default composer.
- Voice is not an attachment flow.
- Transcript is editable before send by default.
- User can append more speech to existing text.
- Failure preserves existing draft and partial transcript.
- Sensitive spoken commands still trigger normal approvals.
- Direct send is opt-in and conservative.

## 3. Modes

| Mode | Behavior |
|---|---|
| Tap to speak | tap mic, speak, tap stop |
| Hold to speak | hold mic, release to stop, slide/cancel |
| Continue dictation | append transcript to existing draft |
| Direct send | optional, sends only when confidence and intent are clear |

Default:

- transcript review on
- direct send off
- partial transcript visible

## 4. State Machine

```text
idle
requesting_microphone
listening
streaming_audio
transcribing_partial
paused
transcribing_final
ready_to_send
transcription_failed_recoverable
microphone_denied
sending
```

Rules:

- `cancel` during listening discards only current recording segment, not previous draft.
- `stop` finalizes current segment.
- `continue dictation` starts a new segment appended to draft.
- `microphone_denied` leaves text input active.

## 5. Transcript Patch Protocol

ASR emits patch events:

```ts
type VoiceTranscriptPatch = {
  segmentId: string;
  revision: number;
  isFinal: boolean;
  text: string;
  range?: {
    start: number;
    end: number;
  };
  confidence?: number;
  uncertainSpans?: Array<{
    start: number;
    end: number;
    alternatives?: string[];
  }>;
  language?: 'zh-CN' | 'en-US' | 'auto';
};
```

Patch rules:

- Partial revisions may replace text for current segment.
- Final revision freezes segment unless user edits.
- User edits create a new local draft revision.
- ASR must not overwrite user-edited text without explicit merge.

## 6. ASR Provider Strategy

Provider order:

1. Native/browser local speech recognition if available and privacy-acceptable.
2. Lily-managed streaming ASR service if configured.
3. Upload audio to Lily-side model pathway for non-streaming transcription.
4. Fall back to text input.

Provider selection must be server-configurable:

```json
{
  "mobileVoice": {
    "enabled": true,
    "streamingProvider": "lily",
    "browserSpeechAllowed": true,
    "audioUploadFallbackEnabled": true,
    "directSendEnabled": false
  }
}
```

No automatic fallback to an unconfigured third-party provider.

## 7. Audio Privacy

- Default: do not retain audio after transcription completes.
- If fallback upload is used, audio temp object TTL max 2 hours.
- Push/telemetry must not include transcript content.
- Diagnostics include provider, duration, error code, not audio.
- User-visible privacy copy explains where transcription happens.

## 8. Language Handling

Defaults:

- Auto-detect zh-CN / en-US.
- Keep mixed Chinese/English terms.
- Preserve file names, app names, and person names where possible.
- Do not over-polish technical commands.

Long utterances:

- Segment into paragraphs.
- Preserve imperative intent.
- Do not add actions not spoken by user.

## 9. Direct Send Rules

Direct send may send without review only if all are true:

- user explicitly enabled direct send
- utterance duration under configured limit, default 8 seconds
- ASR confidence above threshold
- no uncertain high-impact words
- command does not appear sensitive
- desktop route is available

Otherwise transcript lands in composer for review.

## 10. Sensitive Intent Handling

Voice can draft:

- delete files
- send email
- run shell
- install software
- desktop control request

But execution follows normal approval policy. Voice never grants permission.

## 11. Failure Behavior

| Failure | Behavior |
|---|---|
| mic permission denied | keep text input active |
| ASR network fail | preserve partial transcript |
| provider unavailable | fall back to text |
| low confidence | mark uncertain spans |
| audio upload fail | recoverable retry |
| direct send blocked | show transcript for review |

## 12. UI Details

Recording UI:

- waveform or level meter
- elapsed time
- cancel affordance
- stop/send affordance
- clear status text

Composer:

- transcript appears in normal text draft area
- uncertain spans lightly marked
- user can tap uncertain span to choose alternative
- mic remains available after final transcript

## 13. Tests

Required tests:

- `test-mobile-voice-state-machine.mjs`
- `test-mobile-voice-transcript-patches.mjs`
- `test-mobile-voice-direct-send-policy.mjs`
- `test-mobile-voice-fail-open.mjs`
- `test-mobile-voice-sensitive-approval.mjs`

Assertions:

- cancel segment does not clear old draft
- ASR patch cannot overwrite user edits
- failed ASR preserves partial transcript
- direct send blocked for sensitive commands
- voice command still requires approval for high-risk actions

## 14. Acceptance Criteria

- User can speak, edit, continue speaking, and send without leaving Command.
- Short speech becomes text quickly.
- Long speech becomes readable command text.
- No voice failure loses draft text.
- Voice does not bypass permission or approval.
