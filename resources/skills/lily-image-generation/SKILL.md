---
name: lily-image-generation
description: Generate bitmap images with Alibaba Bailian Qwen-Image. Use for scene/texture images such as portraits, posters, illustrations, product shots, avatars, covers, and concept art. For structural content such as flowcharts, architecture diagrams, charts, and icons, use lily-diagrams instead.
allowed-tools: Bash(node *)
---

# Image generation

This tool generates **bitmap images**. It is appropriate for scene and texture
work: people, portraits, photorealistic images, posters, illustrations, product
shots, concept art, and covers.

If the user asks for structural content such as a flowchart, architecture
diagram, sequence diagram, state machine, mind map, data chart, ER diagram,
Gantt chart, or UI wireframe, do **not** use this tool. Use `lily-diagrams`
instead, preferring Mermaid first and SVG only when Mermaid cannot express the
layout.

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

`DASHSCOPE_IMAGE_ENDPOINT` can override the full endpoint. Otherwise the script
uses `DASHSCOPE_IMAGE_BASE_URL` with the official default path. `DASHSCOPE_BASE_URL`
is reserved for chat model APIs and is not used for image generation.

The script calls the Alibaba Bailian Qwen-Image API, downloads the temporary
24-hour URL to a local file, and prints `<generated_media>` plus a local
Markdown image preview to stdout.

When replying, show the local image preview. Do not return only a path, and do
not expose the temporary URL. Use this shape:

```markdown
![Generated image](/absolute/path/generated-image.png)
Saved to: /absolute/path/generated-image.png
```

Use the user's current language or app language for the surrounding explanation.
