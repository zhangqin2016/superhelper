---
name: websearch
description: Search the web when the user needs current facts, news, references, or external sources. Default provider is Alibaba IQS; SearXNG and DuckDuckGo can also be configured. Use this skill when the built-in WebSearch tool is unavailable.
allowed-tools: Bash(node *)
---

# Web Search

Use this skill when the user needs up-to-date or externally sourced information.

The callable skill name is `websearch`. Do not call a localized display name
as a skill; localized names are UI labels only.

Run:

```bash
echo '{"query":"search keywords"}' | "{{NODE_BIN}}" "{{WEBSEARCH_SCRIPT}}"
```

The default provider is Alibaba IQS, which is configured by the app. The user can switch the provider in Settings -> Web Search.

Optional JSON parameters:

- `allowed_domains`: only keep results from these domains.
- `blocked_domains`: exclude results from these domains.

Do not send both `allowed_domains` and `blocked_domains` in the same request.

The script writes `<search_results>` XML to stdout with `title`, `url`, and `snippet` fields. Answer in the user's current language and include source links when the answer relies on search results.
