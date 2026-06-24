"""Lily platform search vendor for TradingAgents news tools.

This vendor routes stock and macro news research through Lily Workbench's
server-managed web search gateway (Alibaba IQS when configured). It keeps API
keys out of the workspace app and avoids using Yahoo's English news search as
the primary path for A-share research.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime
from html import unescape

from dateutil.relativedelta import relativedelta

from .errors import VendorNotConfiguredError


IQS_API_URL = os.environ.get(
    "WEBSEARCH_IQS_API_URL",
    "https://cloud-iqs.aliyuncs.com/search/unified",
)
IQS_ENGINE_TYPE = os.environ.get("WEBSEARCH_IQS_ENGINE_TYPE", "LiteAdvanced")
REQUEST_TIMEOUT = float(os.environ.get("LILY_STOCK_SEARCH_TIMEOUT_SECONDS", "12"))


def _api_key() -> str:
    return os.environ.get("WEBSEARCH_IQS_API_KEY", "").strip()


def _clean(value: object) -> str:
    return unescape(str(value or "")).strip()


def _ticker_query_label(ticker: str) -> str:
    raw = str(ticker or "").strip().upper()
    if raw.endswith(".SS") or raw.endswith(".SZ"):
        return f"{raw[:6]} A股"
    if raw.endswith(".HK"):
        return f"{raw[:-3]} 港股"
    return raw


def _search(query: str, *, limit: int = 8, allowed_domains: list[str] | None = None) -> list[dict]:
    key = _api_key()
    if not key:
        raise VendorNotConfiguredError("lily_search requires WEBSEARCH_IQS_API_KEY")

    body = {
        "query": query,
        "engineType": IQS_ENGINE_TYPE,
        "contents": {
            "mainText": False,
            "markdownText": False,
            "summary": False,
            "rerankScore": True,
        },
        "advancedParams": {},
    }
    if allowed_domains:
        body["advancedParams"]["filter"] = " OR ".join(f"site:{domain}" for domain in allowed_domains)

    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        IQS_API_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Lily search HTTP {exc.code}: {detail[:300]}") from exc

    items = data.get("pageItems") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    results = []
    for item in items:
        title = _clean(item.get("title"))
        url = _clean(item.get("link") or item.get("url"))
        snippet = _clean(item.get("snippet") or item.get("summary"))
        if title and url:
            results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= limit:
            break
    return results


def _format_results(title: str, query: str, results: list[dict]) -> str:
    if not results:
        return f"No Lily platform news found for query: {query}"
    lines = [f"## {title}", "", f"Lily platform search query: {query}", ""]
    for index, item in enumerate(results, 1):
        lines.append(f"### {index}. {item['title']}")
        if item["snippet"]:
            lines.append(item["snippet"])
        lines.append(f"Link: {item['url']}")
        lines.append("")
    lines.append(
        "Data source: Lily platform web search. Treat snippets as evidence pointers; "
        "cite source links and do not fabricate unavailable financial metrics."
    )
    return "\n".join(lines)


def get_news_lily_search(ticker: str, start_date: str, end_date: str) -> str:
    label = _ticker_query_label(ticker)
    query = f"{label} {start_date} {end_date} 最新消息 财报 公告 股价 风险"
    domains = None
    if label.endswith("A股"):
        domains = [
            "eastmoney.com",
            "10jqka.com.cn",
            "sina.com.cn",
            "cninfo.com.cn",
            "sse.com.cn",
            "szse.cn",
        ]
    results = _search(query, limit=10, allowed_domains=domains)
    return _format_results(f"{ticker} Lily Platform News, from {start_date} to {end_date}", query, results)


def get_global_news_lily_search(
    curr_date: str,
    look_back_days: int | None = None,
    limit: int | None = None,
) -> str:
    if look_back_days is None:
        look_back_days = 7
    if limit is None:
        limit = 8
    curr_dt = datetime.strptime(curr_date, "%Y-%m-%d")
    start_date = (curr_dt - relativedelta(days=look_back_days)).strftime("%Y-%m-%d")
    query = f"{start_date} {curr_date} A股 市场 宏观 政策 半导体 科技 财经 新闻"
    results = _search(query, limit=limit)
    return _format_results(f"Lily Platform Global Market News, from {start_date} to {curr_date}", query, results)
