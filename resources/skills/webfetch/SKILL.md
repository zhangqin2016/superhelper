---
name: webfetch
description: Fallback for reading a webpage when the built-in webfetch tool fails (blocked, timed out, or unavailable). Use the built-in webfetch tool first.
allowed-tools: Bash(node *)
---

# Web fetch (fallback)

Read a link with the built-in `webfetch` tool first. If it fails — the site
blocks it, it times out, or the tool is unavailable — run:

```bash
echo '{"url":"https://example.com/page","prompt":"what the user wants to know"}' | "{{NODE_BIN}}" "{{WEBFETCH_SCRIPT}}"
```

- `url`: complete URL (required)
- `prompt`: what to look for in the page (required)

The script prints extracted Markdown content to stdout. Answer from that content
in the user's current language, and cite sources when relevant.

Common workflow: use websearch to find links, then read specific pages.
