---
name: webfetch
description: 打开链接并读取网页正文（无需 API Key）。用户给出 URL 并要求总结、翻译或分析页面内容时使用；内置 WebFetch 不可用时必须用本 skill。
allowed-tools: Bash(node *)
---

# 读取网页

内置 WebFetch 在本应用中不可用。用户给出链接时，用 Bash 执行：

```bash
echo '{"url":"https://example.com/page","prompt":"用户想了解的问题"}' | "{{NODE_BIN}}" "{{WEBFETCH_SCRIPT}}"
```

- `url`：完整 URL（必填）
- `prompt`：要从页面里找什么信息（必填）

脚本在 stdout 输出提取后的 Markdown 正文。根据正文用中文回答用户的问题。

常见流程：先 websearch 找链接，再 webfetch 读具体页面。
