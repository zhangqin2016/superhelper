---
name: lily-image-generation
description: Generate bitmap images with Alibaba Bailian Qwen-Image. Use for scene/texture/creative work where realism, style, or mood is what matters — portraits, people, scenes, landscapes, background art, textures, posters, illustrations, product shots, avatars, covers, concept art. NOT for structural content (flowcharts, architecture diagrams, charts, icons, wireframes → lily-diagrams) and NOT for a real/usable UI or web page (landing page, dashboard, component → frontend-design). See the intent router's visual-output rubric.
allowed-tools: Bash(node *)
---

# Image generation

This tool generates **bitmap images**. It is appropriate for scene and texture
work: people, portraits, photorealistic images, posters, illustrations, product
shots, concept art, and covers.

Route by what makes the output correct (full rubric: the intent router's
"Visual / graphic output" section). In short: structural content whose
correctness is exact text/data/geometry — flowcharts, architecture, charts,
icons, wireframes — is **not** a bitmap → use `lily-diagrams`. A real, usable
UI or web page → use `frontend-design` (code), not a picture of one. Use this
tool only when realism, style, or mood is what matters.

## Ground the request in context — don't interrogate

When the request is bare or short (e.g. just "generate an image" with no
explicit subject), do NOT reply with a generic questionnaire (subject / style /
size / preferences). First infer the subject from the CURRENT conversation and
the latest deliverable: if a report or dataset was just produced, generate a
relevant cover, hero image, or illustration for it. Choose sensible defaults
(size 2048*2048, a style that fits the content) and generate directly. Ask at
most ONE short, context-aware question, and only when there is genuinely no
usable context to infer a subject. (To visualize the report's actual numbers as
a chart/diagram, use lily-diagrams, not this bitmap tool.)

When the user asks to generate an image, poster, illustration, cover, avatar,
product shot, or visual concept, run:

```bash
echo '{"prompt":"image description","size":"2048*2048"}' | "{{NODE_BIN}}" "{{IMAGE_GENERATION_SCRIPT}}"
```

Optional parameters:

- `size`: output size, for example `1664*928`, `1328*1328`, or `928*1664`
- `negative_prompt`: negative prompt
- `prompt_extend`: whether Bailian should enhance the prompt, default `true`
- `watermark`: whether to add a watermark, default `false`
- `output_dir`: save directory, default current workspace `generated-assets`
- `model`: defaults to `DASHSCOPE_IMAGE_MODEL`, otherwise `qwen-image-2.0-pro`
- `provider`: `lily`/`dashscope`/`volcengine`/`kling`/`minimax`/`zhipu` (else the configured default)

`DASHSCOPE_IMAGE_ENDPOINT` can override the full endpoint. Otherwise the script
uses `DASHSCOPE_IMAGE_BASE_URL` with the official default path. `DASHSCOPE_BASE_URL`
is reserved for chat model APIs and is not used for image generation.
For Lily self-hosted GPU, set `LILY_MEDIA_IMAGE_ENDPOINT` (or
`LILY_MEDIA_IMAGE_BASE_URL`) and choose provider `lily`.

The script calls the Alibaba Bailian Qwen-Image API, downloads the temporary
24-hour URL to a local file, and prints `<generated_media>` plus a local
Markdown image preview to stdout.

When replying, show the local image preview. Do not return only a path, and do
not expose the temporary URL. Use this shape:

```markdown
![Generated image](/absolute/path/generated-image.png)
Saved to: /absolute/path/generated-image.png
```

Use the primary language of the user's latest message for the surrounding explanation.
