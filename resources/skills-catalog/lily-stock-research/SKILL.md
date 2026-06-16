---
name: lily-stock-research
description: Use when the user asks for stock, ETF, index, market, watchlist, or portfolio research; combines Lily search/model resources with the installed stock analysis workspace, keeps facts source-backed, and always separates data, model inference, and non-advice risk notes.
---

# Lily Stock Research

Use this skill when the user asks to analyze stocks, ETFs, indexes, markets,
watchlists, earnings, news catalysts, valuation, technical signals, or portfolio
risks.

## Core Rules

- Treat every output as research assistance, never investment advice.
- Separate facts, model inference, and user-action ideas.
- Do not invent prices, financials, analyst ratings, filings, news, or market
  events. If data fetch fails, say exactly what failed.
- For current prices, news, policy, earnings, or rankings, use `lily-research-synthesis`
  behavior: search current sources, open sources where possible, and cite them.
- Prefer platform-provided model/search environment variables. Do not ask users
  to paste API keys unless the workspace explicitly lacks required credentials.
- Lily Workbench already provides web search through the platform search skill
  and configured backend. Do not tell ordinary users to configure Bocha,
  Tavily, SerpAPI, Brave, MiniMax, Anspire, or other third-party search keys as
  a routine "improvement" when platform search is available.
- Use the workspace's scripts only after inspecting the workspace README,
  `AGENTS.md`, and `.env.example`.

## Platform Resource Workflow

1. Confirm the active workspace is the stock analysis app, or ask the user to
   open/install it from the Lily app store.
2. Inspect `README.md`, `AGENTS.md`, and `source/.env.example`.
3. Prefer Lily's bundled runtime on `PATH`:
   - `python` / `python3` should resolve to Lily's bundled venv in packaged builds.
   - `uv` should resolve to Lily's bundled uv when available.
4. Create a workspace-local environment only when the app dependencies are
   missing. Keep it inside the workspace, never in the app bundle:

```bash
cd source
uv venv .venv-lily-stock
. .venv-lily-stock/bin/activate
uv pip install -r requirements.txt
```

On Windows use:

```powershell
cd source
uv venv .venv-lily-stock
.\.venv-lily-stock\Scripts\Activate.ps1
uv pip install -r requirements.txt
```

5. Run the Lily-native entrypoint for a tiny dry run before any full watchlist:

```bash
python lily_run.py --stocks 600519,AAPL --dry-run
```

Do not run upstream `main.py` for Lily app analysis. It is only a compatibility
wrapper/example path and can bypass Lily's platform-managed model configuration.

6. For table outputs, apply `lily-excel-data-analysis` behavior: create
   reviewable CSV/XLSX summaries with source columns and a cleaning/assumption
   log when possible.

## Data-Limit Language

When market data is missing or a ticker is newly listed, phrase it as current
data coverage, not as a product defect or customer setup task.

Use:

- "本次数据限制：SPCX 交易历史较短，均线/MACD 等指标置信度不足。"
- "本次数据限制：yfinance 暂未提供完整财务字段，本报告不计算 PE/ROE。"
- "已使用 Lily 平台联网搜索核验公开新闻；未找到足够可靠来源时标注缺失。"

Do not use:

- "待改进项"
- "要让 App 输出更高质量的分析，还需要..."
- "请配置 Bocha/Tavily/SerpAPI 搜索 Key"
- "等 yfinance 收录后 App 才能工作"

## Output Shape

Use this structure unless the user asks for a different format:

1. Scope and data time: ticker list, market, data timestamp, and sources checked.
2. Facts: price/financial/news facts with source links or clear source names.
3. Model interpretation: trend, catalyst, valuation or risk interpretation.
4. Watch items: what would change the view, missing data, and uncertainty.
5. Risk note: "This is research assistance, not investment advice."

## Red Lines

- Do not present model scores as facts.
- Do not say "buy", "sell", or "guaranteed" as an instruction.
- Do not hide stale data or failed API calls.
- Do not run broad automated analysis before a small dry run succeeds.
- Do not install global Python packages; use the bundled runtime or a
  workspace-local environment.
- Do not make the report end with a generic improvement checklist. Missing
  search/news/fundamental/technical fields belong in the report's data-limit
  section with concrete impact on confidence.
