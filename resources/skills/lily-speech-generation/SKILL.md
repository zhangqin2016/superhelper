---
name: lily-speech-generation
description: Generate voice-over, narration, and audio with Alibaba Bailian speech synthesis. Use when the user asks for speech, reading aloud, narration, dubbing, or TTS.
allowed-tools: Bash(node *)
---

# Speech generation

When the user asks to generate speech, read text aloud, create narration,
dubbing, or TTS audio, run:

```bash
echo '{"text":"text to read aloud","voice":"longanyang","format":"wav"}' | "{{NODE_BIN}}" "{{SPEECH_GENERATION_SCRIPT}}"
```

Optional parameters:

- `model`: defaults to `DASHSCOPE_TTS_MODEL`, otherwise `cosyvoice-v3-flash`
- `voice`: defaults to `DASHSCOPE_TTS_VOICE`, otherwise `longanyang`
- `format`: `wav`, `mp3`, or `pcm`; default `wav`
- `sample_rate`: default `24000`
- `output_dir`: save directory, default current workspace `generated-assets`

`DASHSCOPE_TTS_ENDPOINT` can override the full endpoint. Otherwise the script
uses `DASHSCOPE_TTS_BASE_URL` with the official default path. `DASHSCOPE_BASE_URL`
is reserved for chat model APIs and is not used for speech generation.

The script calls Alibaba Bailian asynchronous speech synthesis, downloads the
temporary audio URL to a local file, and reports the local audio path. Reply with
the local file path and preview when available. Do not return the temporary URL.

Use the user's current language or app language for the surrounding explanation.
