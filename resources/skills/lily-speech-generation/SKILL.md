---
name: lily-speech-generation
description: 使用阿里云百炼语音合成生成配音、旁白和音频。用户要求生成语音、朗读、旁白、配音或 TTS 时使用。
allowed-tools: Bash(node *)
---

# 语音生成

用户要求生成语音、朗读、旁白、配音或 TTS 时，用 Bash 执行：

```bash
echo '{"text":"要朗读的文本","voice":"longanyang","format":"wav"}' | "{{NODE_BIN}}" "{{SPEECH_GENERATION_SCRIPT}}"
```

可选参数：

- `model`：默认读取 `DASHSCOPE_TTS_MODEL`，否则使用 `cosyvoice-v3-flash`
- `voice`：默认读取 `DASHSCOPE_TTS_VOICE`，否则使用 `longanyang`
- `format`：`wav`、`mp3`、`pcm`，默认 `wav`
- `sample_rate`：默认 `24000`
- `output_dir`：保存目录，默认当前工作区 `generated-assets`

后台可通过 `DASHSCOPE_TTS_ENDPOINT` 覆盖完整接口地址；否则使用 `DASHSCOPE_TTS_BASE_URL` 拼接官方默认路径。`DASHSCOPE_BASE_URL` 保留给聊天模型接口，不参与语音生成。

脚本会调用阿里云百炼非实时语音合成接口，并把临时音频 URL 下载到本地。回复用户时只说明本地音频文件路径。
