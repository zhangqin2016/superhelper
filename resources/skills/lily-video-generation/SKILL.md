---
name: lily-video-generation
description: 使用阿里云百炼万相生成视频。用户要求生成短视频、动画、分镜视频、图生视频、视频续写或视频编辑时使用。
allowed-tools: Bash(node *)
---

# 视频生成

用户要求生成短视频、动画、分镜视频、图生视频、视频续写或视频编辑时，用 Bash 执行：

```bash
echo '{"prompt":"要生成的视频描述","ratio":"16:9","resolution":"720P","duration":5}' | "{{NODE_BIN}}" "{{VIDEO_GENERATION_SCRIPT}}"
```

可选参数：

- `model`：默认读取 `DASHSCOPE_VIDEO_MODEL`，否则使用 `wan2.7-t2v`
- `media`：参考素材数组，例如 `[{"type":"first_frame","url":"https://.../image.png"}]`
- `negative_prompt`：反向提示词
- `ratio`：`16:9`、`9:16`、`1:1` 等
- `resolution`：默认 `720P`
- `duration`：视频秒数，默认 `5`
- `prompt_extend`：默认 `true`
- `watermark`：默认 `false`
- `output_dir`：保存目录，默认当前工作区 `generated-assets`

后台可通过 `DASHSCOPE_VIDEO_ENDPOINT` 覆盖完整接口地址；否则使用 `DASHSCOPE_VIDEO_BASE_URL` / `DASHSCOPE_BASE_URL` 拼接官方默认路径。

视频生成耗时较长。脚本会轮询百炼任务，完成后把临时视频 URL 下载到本地。回复用户时说明本地文件路径，不要直接返回临时 URL。
