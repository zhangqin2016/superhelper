---
name: lily-video-generation
description: Generate videos with the configured video provider. Supports Lily GPU, Alibaba Bailian Wanxiang, Volcengine Seedance, Kling, MiniMax, and Zhipu. Use when the user asks for short videos, animations, storyboard videos, image-to-video, video continuation, or video editing.
allowed-tools: Bash(node *)
---

# Video generation

Generates ONE short video clip (~5–10s). Text-to-video models understand *what the
camera sees*, not prose — so write a concrete, filmable prompt, not a plot summary.

## Write a strong prompt

Order the description as: `[subject / character appearance] + [action] + [scene / environment] + [shot size + camera move] + [lighting / mood] + [style keywords]`.

Good: `a young cultivator kneels at the edge of a herb field, right hand pressed to the soil, dark-gold veins rippling out from his wrist like water and glowing; medium shot, slow push-in; dawn side-backlight, light mist; xianxia ink-wash, cinematic, warm tones.`
Bad (won't match): `a youth gains mysterious power and rises to the top` — that's plot, not a shot.

Write the prompt in whatever language fits the user's request; the structure above matters more than the language.

- For consistency with an existing look, pass a reference image as the first frame
  (image-to-video): `"media":[{"type":"first_frame","url":"file:///abs/keyframe.png"}]`.
- Don't expect on-screen text/subtitles — these models can't render text reliably.

## Run

```bash
echo '{"prompt":"<structured shot prompt>","ratio":"16:9","resolution":"720P","duration":5}' | "{{NODE_BIN}}" "{{VIDEO_GENERATION_SCRIPT}}"
```

Optional parameters:

- `model`: defaults to `DASHSCOPE_VIDEO_MODEL`, otherwise `wan2.7-t2v`
- `media`: reference media array, e.g. `[{"type":"first_frame","url":"https://.../image.png"}]`
- `negative_prompt`: negative prompt
- `ratio`: `16:9`, `9:16`, `1:1`, …
- `resolution`: default `720P`
- `duration`: seconds, default `5`
- `prompt_extend`: default `true`
- `watermark`: default `false`
- `provider`: `lily`/`dashscope`/`volcengine`/`kling`/`minimax`/`zhipu` (else the configured default)
- `output_dir`: save directory, default current workspace `generated-assets`

Provider rules:

- Do not assume DashScope/Wanxiang. The configured provider from Settings is
  injected as `LILY_VIDEO_PROVIDER`; when the user has selected Lily, omit
  `provider` or set `"provider":"lily"`.
- Only set `"provider":"dashscope"` when the user explicitly asks for
  DashScope/Bailian/Wanxiang, or when intentionally overriding the configured
  provider.
- If the user explicitly names a supported provider, include that provider in
  the JSON payload so the request cannot be routed to a different default.

`DASHSCOPE_VIDEO_ENDPOINT` can override the full endpoint. Otherwise the script
uses `DASHSCOPE_VIDEO_BASE_URL` with the official default path. `DASHSCOPE_BASE_URL`
is reserved for chat model APIs and is not used for video generation.
For Lily self-hosted GPU, set `LILY_MEDIA_VIDEO_ENDPOINT` (or
`LILY_MEDIA_VIDEO_BASE_URL`) and choose provider `lily`.

Video generation can take a long time. The script polls the task and downloads the
temporary video URL to a local file when complete. Reply with the local file path
and preview when available. Do not return the temporary URL.

> Multi-shot **finished films** (script → storyboard → one mp4 with voice-over,
> subtitles and music) are produced by the **Video Creation app** from the app
> store, which orchestrates this skill plus image/speech and ffmpeg. This skill
> stays single-clip; install that app for full film production.

Use the primary language of the user's latest message for the surrounding explanation.
