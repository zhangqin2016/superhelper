---
name: websearch
description: Search the web when the user needs current facts, news, references, or external sources. Uses the configured web search provider; IQS, SearXNG, and DuckDuckGo are supported. Use this skill when the built-in WebSearch tool is unavailable.
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

The script uses the configured web search provider from Settings -> Web Search.
Do not assume IQS when the current provider context says SearXNG or DuckDuckGo.

Optional JSON parameters:

- `allowed_domains`: only keep results from these domains.
- `blocked_domains`: exclude results from these domains.

Do not send both `allowed_domains` and `blocked_domains` in the same request.

The script writes `<search_results>` XML to stdout with `title`, `url`, and `snippet` fields. Answer in the user's current language and include source links when the answer relies on search results.
