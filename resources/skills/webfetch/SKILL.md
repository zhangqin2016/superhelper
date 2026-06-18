---
name: webfetch
description: Open links and read webpage content without an API key. Use this when the user gives a URL and asks to summarize, translate, or analyze page content; use this skill when built-in WebFetch is unavailable.
allowed-tools: Bash(node *)
---

# Web fetch

Built-in WebFetch is unavailable in this app. When the user gives a link, run:

```bash
echo '{"url":"https://example.com/page","prompt":"what the user wants to know"}' | "{{NODE_BIN}}" "{{WEBFETCH_SCRIPT}}"
```

- `url`: complete URL (required)
- `prompt`: what to look for in the page (required)

The script prints extracted Markdown content to stdout. Answer from that content
in the user's current language, and cite sources when relevant.

Common workflow: use websearch to find links, then webfetch to read specific pages.
