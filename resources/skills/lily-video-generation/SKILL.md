---
name: lily-video-generation
description: Generate videos with Alibaba Bailian Wanxiang. Use when the user asks for short videos, animations, storyboard videos, image-to-video, video continuation, or video editing.
allowed-tools: Bash(node *)
---

# Video generation

When the user asks to generate a short video, animation, storyboard video,
image-to-video output, video continuation, or video edit, run:

```bash
echo '{"prompt":"video description","ratio":"16:9","resolution":"720P","duration":5}' | "{{NODE_BIN}}" "{{VIDEO_GENERATION_SCRIPT}}"
```

Optional parameters:

- `model`: defaults to `DASHSCOPE_VIDEO_MODEL`, otherwise `wan2.7-t2v`
- `media`: reference media array, for example `[{"type":"first_frame","url":"https://.../image.png"}]`
- `negative_prompt`: negative prompt
- `ratio`: `16:9`, `9:16`, `1:1`, and similar ratios
- `resolution`: default `720P`
- `duration`: seconds, default `5`
- `prompt_extend`: default `true`
- `watermark`: default `false`
- `output_dir`: save directory, default current workspace `generated-assets`

`DASHSCOPE_VIDEO_ENDPOINT` can override the full endpoint. Otherwise the script
uses `DASHSCOPE_VIDEO_BASE_URL` with the official default path. `DASHSCOPE_BASE_URL`
is reserved for chat model APIs and is not used for video generation.

Video generation can take a long time. The script polls the Bailian task and
downloads the temporary video URL to a local file when complete. Reply with the
local file path and preview when available. Do not return the temporary URL.

Use the primary language of the user's latest message for the surrounding explanation.
