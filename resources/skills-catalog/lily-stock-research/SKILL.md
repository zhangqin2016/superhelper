---
name: lily-stock-research
description: Use when the user asks for stock, ETF, index, market, watchlist, or portfolio research; combines Lily search/model resources with the installed stock analysis workspace, keeps facts source-backed, and always separates data, model inference, and non-advice risk notes.
---

# Lily Stock Research

Use this skill for stocks, ETFs, indexes, markets, watchlists, earnings, news catalysts, valuation, technical signals, and portfolio risks.

## Core Rules

- Treat every output as research assistance, never investment advice.
- Separate facts, model inference, and user-action ideas.
- Do not invent prices, financials, analyst ratings, filings, news, or market events.
- For current prices, news, policy, earnings, or rankings, use current search and cite sources where possible.
- Prefer platform-provided model/search configuration. Do not ask ordinary users for third-party search keys when platform search is available.
- Use workspace scripts only after inspecting README, AGENTS.md, and environment examples.

## Workflow

1. Confirm the active workspace is the stock analysis app or ask the user to open/install it.
2. Inspect project instructions and environment examples.
3. Prefer Lily's bundled runtime on PATH.
4. Create a workspace-local environment only when dependencies are missing.
5. Run a tiny dry run before a full watchlist.
6. For table outputs, create reviewable CSV/XLSX summaries with source columns and assumption logs when possible.

## Data Limits

Phrase missing or weak data as data coverage limits, not as user failure. Mark unavailable metrics, short trading history, missing fields, and unverified news plainly.

## Output

Include scope, tickers, current facts with source/date, quantitative summary where data exists, qualitative inference clearly marked, risks, unknowns, and a non-investment-advice note.
