---
name: lily-image-generation
description: 使用阿里云百炼 Qwen-Image 生成位图。用户要画面/质感类图像（人物、人像、海报、插画、产品图、头像、封面、概念艺术）时使用；流程图/架构图/图表/图标等结构性内容请改用 SVG，不要用本工具。
allowed-tools: Bash(node *)
---

# 图片生成

> **选择**：本工具生成的是**位图**，适合“画面/质感”类——人物、人像、照片级、海报、插画、产品图、概念艺术、封面。
> 如果用户要的是**流程图、架构图、时序图、思维导图、数据图表、图标、UI 线框、几何示意图**这类“结构/流程”内容，**不要用本工具**，改为直接产出 **SVG**（矢量更清晰、可编辑、可无损缩放）——见「工作台基础规则」的图像方式选择条款。

用户要求生成图片、海报、插画、封面、头像、产品图、视觉稿时，用 Bash 执行：

```bash
echo '{"prompt":"要生成的图片描述","size":"2048*2048"}' | "{{NODE_BIN}}" "{{IMAGE_GENERATION_SCRIPT}}"
```

可选参数：

- `size`：输出尺寸，例如 `1664*928`、`1328*1328`、`928*1664`
- `negative_prompt`：反向提示词
- `prompt_extend`：是否让百炼增强提示词，默认 `true`
- `watermark`：是否加水印，默认 `false`
- `output_dir`：保存目录，默认当前工作区 `generated-assets`
- `model`：默认读取 `DASHSCOPE_IMAGE_MODEL`，否则使用 `qwen-image-2.0-pro`

后台可通过 `DASHSCOPE_IMAGE_ENDPOINT` 覆盖完整接口地址；否则使用 `DASHSCOPE_IMAGE_BASE_URL` 拼接官方默认路径。`DASHSCOPE_BASE_URL` 保留给聊天模型接口，不参与图片生成。

脚本会调用阿里云百炼 Qwen-Image 官方接口，把 24 小时临时 URL 下载到本地，并在 stdout 输出 `<generated_media>` 和本地 Markdown 图片预览。

回复用户时必须使用本地图片预览，不要只给路径，也不要直接返回临时 URL。格式：

```markdown
![生成图片](/绝对路径/生成图片.png)
已保存到：/绝对路径/生成图片.png
```
