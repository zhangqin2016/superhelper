---
name: lily-speech-generation
description: Generate voice-over, narration, and audio with the configured speech provider. Supports Lily GPU and Alibaba Bailian speech synthesis. Use when the user asks for speech, reading aloud, narration, dubbing, or TTS.
allowed-tools: Bash(node *)
---

# Speech generation

When the user asks to generate speech, read text aloud, create narration,
dubbing, or TTS audio, run:

```bash
echo '{"text":"text to read aloud","format":"wav"}' | "{{NODE_BIN}}" "{{SPEECH_GENERATION_SCRIPT}}"
```

Optional parameters:

- `model`: defaults to `DASHSCOPE_TTS_MODEL`, otherwise `cosyvoice-v3-flash`
- `voice`: provider-specific voice; DashScope defaults to `DASHSCOPE_TTS_VOICE`
  or `longanyang`, Lily GPU defaults to `LILY_MEDIA_TTS_VOICE` or `aiden`
- `format`: `wav`, `mp3`, or `pcm`; default `wav`
- `sample_rate`: default `24000`
- `provider`: `lily`/`dashscope` (else the configured default)
- `output_dir`: save directory, default current workspace `generated-assets`
- Lily GPU voices: `aiden`, `dylan`, `eric`, `ono_anna`, `ryan`, `serena`,
  `sohee`, `uncle_fu`, `vivian`; default `aiden`

Provider rules:

- Do not assume DashScope/CosyVoice. The configured provider from Settings is
  injected as `LILY_SPEECH_PROVIDER`; when the user has selected Lily, omit
  `provider` or set `"provider":"lily"`.
- Only set `"provider":"dashscope"` when the user explicitly asks for
  DashScope/Bailian/CosyVoice, or when intentionally overriding the configured
  provider.
- If the user explicitly names a supported provider, include that provider in
  the JSON payload so the request cannot be routed to a different default.
- If the configured provider returns an error, do not silently retry with a
  different provider. Report the error, state which provider was used, and ask
  whether to retry, switch to another available provider, or use/provide a key.

`DASHSCOPE_TTS_ENDPOINT` can override the full endpoint. Otherwise the script
uses `DASHSCOPE_TTS_BASE_URL` with the official default path. `DASHSCOPE_BASE_URL`
is reserved for chat model APIs and is not used for speech generation.
For Lily self-hosted GPU, set `LILY_MEDIA_SPEECH_ENDPOINT` (or
`LILY_MEDIA_SPEECH_BASE_URL`) and choose provider `lily`.

The script calls the selected speech provider, downloads any temporary result
URL to a local file, and reports the local audio path. Reply with the local file
path and preview when available. Do not return the temporary URL.

Use the primary language of the user's latest message for the surrounding explanation.
