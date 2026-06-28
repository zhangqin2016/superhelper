---
name: lily-video-generation
description: Generate videos with Alibaba Bailian Wanxiang. Use when the user asks for short videos, animations, storyboard videos, image-to-video, video continuation, or video editing.
allowed-tools: Bash(node *)
---

# Video generation

Generates ONE short video clip (~5–10s). Text-to-video models understand *what the
camera sees*, not prose — so write a concrete, filmable prompt, not a plot summary.

## Write a strong prompt

Order the description as: `[主体/角色外观] + [动作] + [场景/环境] + [景别+运镜] + [光线/氛围] + [画风关键词]`.

Good: `少年修士跪在药田边，右手按泥土，手腕暗金纹路如水波扩散发光；中景缓推；黎明侧逆光、薄雾；仙侠水墨、电影感、暖色调。`
Bad (won't match): `少年获得神秘力量开启逆袭` — that's plot, not a shot.

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
- `provider`: `dashscope`/`volcengine`/`kling`/`minimax`/`zhipu` (else the configured default)
- `output_dir`: save directory, default current workspace `generated-assets`

`DASHSCOPE_VIDEO_ENDPOINT` can override the full endpoint. Otherwise the script
uses `DASHSCOPE_VIDEO_BASE_URL` with the official default path. `DASHSCOPE_BASE_URL`
is reserved for chat model APIs and is not used for video generation.

Video generation can take a long time. The script polls the task and downloads the
temporary video URL to a local file when complete. Reply with the local file path
and preview when available. Do not return the temporary URL.

> Multi-shot **finished films** (文案 → storyboard → one mp4 with voice-over,
> subtitles and music) are produced by the **「视频创作」app** from the app store,
> which orchestrates this skill plus image/speech and ffmpeg. This skill stays
> single-clip; install that app for full film production.

Use the primary language of the user's latest message for the surrounding explanation.
