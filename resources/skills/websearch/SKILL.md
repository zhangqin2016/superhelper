---
name: websearch
description: 联网搜索（默认阿里 IQS，国内稳定合规；亦支持 SearXNG / DuckDuckGo）。用户需要查资料、新闻、实时信息时使用；内置 WebSearch 不可用时必须用本 skill。
allowed-tools: Bash(node *)
---

# 联网搜索

内置 WebSearch 在本应用中不可用。需要搜索互联网时，用 Bash 执行：

```bash
echo '{"query":"搜索关键词"}' | "{{NODE_BIN}}" "{{WEBSEARCH_SCRIPT}}"
```

默认使用 **阿里 IQS**（信息查询服务，国内直连、合规可商用，应用已内置）。亦可在 **设置 → 联网搜索** 切换为 SearXNG 或 DuckDuckGo。

可选参数（JSON）：

- `allowed_domains`：只保留这些域名的结果（字符串数组）
- `blocked_domains`：排除这些域名（字符串数组）

`allowed_domains` 与 `blocked_domains` 不能同时使用。

脚本在 stdout 输出 `<search_results>` XML（含 title、url、snippet）。用搜索结果回答用户，并附上来源链接。
