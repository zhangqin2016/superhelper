#!/usr/bin/env python3
"""Read-only web system scanner for Lily learned skills.

This script intentionally collects page structure only. It never submits forms,
clicks mutating buttons, stores credentials, or captures field values.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import deque
from dataclasses import dataclass
from typing import Any
from urllib.parse import urldefrag, urljoin, urlparse


MUTATING_TEXT_RE = re.compile(
    r"(delete|remove|submit|send|approve|reject|pay|upload|create|save|删除|移除|提交|发送|审批|同意|驳回|支付|上传|创建|保存)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ScanConfig:
    base_url: str
    allowed_domains: list[str]
    max_pages: int
    timeout_ms: int
    headful: bool
    storage_state: str | None


def emit(payload: dict[str, Any], code: int = 0) -> None:
    stream = sys.stdout if code == 0 else sys.stderr
    print(json.dumps(payload, ensure_ascii=False, indent=2), file=stream)
    raise SystemExit(code)


def normalize_domain(value: str) -> str:
    text = value.strip()
    if not text:
        return ""
    if "://" in text:
        text = urlparse(text).netloc
    return text.lower().split("@")[-1].split(":")[0]


def normalize_url(url: str) -> str:
    clean, _fragment = urldefrag(url.strip())
    return clean


def validate_config(args: argparse.Namespace) -> ScanConfig:
    base_url = normalize_url(args.base_url)
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        emit({"ok": False, "code": "INVALID_BASE_URL", "message": "base URL must be http(s)"}, 2)

    allowed_domains = [normalize_domain(domain) for domain in args.allowed_domain]
    allowed_domains = [domain for domain in dict.fromkeys(allowed_domains) if domain]
    base_domain = normalize_domain(base_url)
    if not allowed_domains:
        emit({"ok": False, "code": "ALLOWLIST_REQUIRED", "message": "at least one allowed domain is required"}, 2)
    base_allowed = base_domain in allowed_domains or any(base_domain.endswith(f".{domain}") for domain in allowed_domains)
    if not base_allowed:
        emit(
            {
                "ok": False,
                "code": "BASE_DOMAIN_NOT_ALLOWED",
                "message": "base URL domain must be included in allowed domains",
                "baseDomain": base_domain,
                "allowedDomains": allowed_domains,
            },
            2,
        )

    return ScanConfig(
        base_url=base_url,
        allowed_domains=allowed_domains,
        max_pages=max(1, min(args.max_pages, 100)),
        timeout_ms=max(1000, min(args.timeout_ms, 60000)),
        headful=args.headful,
        storage_state=args.storage_state,
    )


def is_allowed_url(url: str, allowed_domains: list[str]) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False
    host = normalize_domain(url)
    return host in allowed_domains or any(host.endswith(f".{domain}") for domain in allowed_domains)


def compact_text(value: Any, limit: int = 160) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def risk_hint(text: str) -> str:
    if MUTATING_TEXT_RE.search(text):
        return "mutating"
    return "read"


def extract_page(page: Any, current_url: str, allowed_domains: list[str]) -> dict[str, Any]:
    snapshot = page.evaluate(
        """
        () => {
          const textOf = (node) => (node?.innerText || node?.textContent || node?.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim();
          const labelFor = (el) => {
            const id = el.getAttribute('id');
            if (id) {
              const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              if (label) return textOf(label);
            }
            const parentLabel = el.closest('label');
            if (parentLabel) return textOf(parentLabel);
            return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
          };
          return {
            title: document.title || '',
            headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 30).map((el) => ({
              level: el.tagName.toLowerCase(),
              text: textOf(el)
            })).filter((item) => item.text),
            links: Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map((el) => ({
              text: textOf(el),
              href: el.getAttribute('href')
            })),
            buttons: Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')).slice(0, 120).map((el) => ({
              text: textOf(el) || el.getAttribute('value') || el.getAttribute('aria-label') || '',
              type: el.getAttribute('type') || el.getAttribute('role') || el.tagName.toLowerCase()
            })).filter((item) => item.text),
            inputs: Array.from(document.querySelectorAll('input,select,textarea')).slice(0, 160).map((el) => ({
              label: labelFor(el),
              type: el.getAttribute('type') || el.tagName.toLowerCase(),
              name: el.getAttribute('name') || '',
              required: Boolean(el.required || el.getAttribute('aria-required') === 'true')
            })),
            forms: Array.from(document.querySelectorAll('form')).slice(0, 40).map((form) => ({
              label: textOf(form.querySelector('legend,h1,h2,h3')) || form.getAttribute('aria-label') || '',
              action: form.getAttribute('action') || '',
              method: form.getAttribute('method') || 'get',
              submitButtons: Array.from(form.querySelectorAll('button,input[type="submit"]')).slice(0, 20).map((el) => textOf(el) || el.getAttribute('value') || '')
            }))
          };
        }
        """
    )

    links: list[dict[str, str]] = []
    next_urls: list[str] = []
    for item in snapshot.get("links", []):
        href = str(item.get("href") or "")
        absolute = normalize_url(urljoin(current_url, href))
        if not is_allowed_url(absolute, allowed_domains):
            continue
        link = {"text": compact_text(item.get("text")), "url": absolute}
        if link["url"] and link["url"] not in {existing["url"] for existing in links}:
            links.append(link)
            next_urls.append(absolute)

    buttons = [
        {"text": compact_text(item.get("text")), "type": compact_text(item.get("type")), "riskHint": risk_hint(item.get("text", ""))}
        for item in snapshot.get("buttons", [])
        if compact_text(item.get("text"))
    ]

    forms = []
    for form in snapshot.get("forms", []):
        action = normalize_url(urljoin(current_url, str(form.get("action") or "")))
        forms.append(
            {
                "label": compact_text(form.get("label")),
                "action": action if is_allowed_url(action, allowed_domains) else "",
                "method": compact_text(form.get("method")).lower() or "get",
                "submitButtons": [compact_text(text) for text in form.get("submitButtons", []) if compact_text(text)],
                "riskHint": "mutating" if compact_text(form.get("method")).lower() == "post" else "read",
            }
        )

    return {
        "url": current_url,
        "title": compact_text(snapshot.get("title")),
        "headings": [
            {"level": compact_text(item.get("level")), "text": compact_text(item.get("text"))}
            for item in snapshot.get("headings", [])
            if compact_text(item.get("text"))
        ],
        "links": links[:80],
        "buttons": buttons[:80],
        "inputs": [
            {
                "label": compact_text(item.get("label")),
                "type": compact_text(item.get("type")),
                "name": compact_text(item.get("name")),
                "required": bool(item.get("required")),
            }
            for item in snapshot.get("inputs", [])
            if compact_text(item.get("label")) or compact_text(item.get("name"))
        ][:120],
        "forms": forms[:40],
        "_nextUrls": next_urls,
    }


def run_scan(config: ScanConfig) -> dict[str, Any]:
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # pragma: no cover - depends on optional runtime package
        emit(
            {
                "ok": False,
                "code": "PLAYWRIGHT_PACKAGE_MISSING",
                "message": "Playwright Python package is not installed in this runtime.",
                "detail": str(exc),
            },
            3,
        )

    pages: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    seen: set[str] = set()
    queue: deque[str] = deque([config.base_url])

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(headless=not config.headful, channel="chrome")
            except Exception:
                browser = p.chromium.launch(headless=not config.headful)
            context_kwargs: dict[str, Any] = {}
            if config.storage_state:
                context_kwargs["storage_state"] = config.storage_state
            context = browser.new_context(**context_kwargs)
            page = context.new_page()

            while queue and len(pages) < config.max_pages:
                url = queue.popleft()
                if url in seen or not is_allowed_url(url, config.allowed_domains):
                    continue
                seen.add(url)
                page_record: dict[str, Any]
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=config.timeout_ms)
                    page_record = extract_page(page, normalize_url(page.url), config.allowed_domains)
                    for next_url in page_record.pop("_nextUrls", []):
                        if next_url not in seen and len(seen) + len(queue) < config.max_pages * 4:
                            queue.append(next_url)
                except PlaywrightTimeoutError:
                    page_record = {"url": url, "error": "TIMEOUT"}
                    warnings.append({"url": url, "code": "TIMEOUT"})
                except PlaywrightError as exc:
                    page_record = {"url": url, "error": "PAGE_ERROR", "detail": compact_text(exc, 240)}
                    warnings.append({"url": url, "code": "PAGE_ERROR", "detail": compact_text(exc, 240)})
                pages.append(page_record)

            context.close()
            browser.close()
    except Exception as exc:  # pragma: no cover - depends on local browser installation
        emit(
            {
                "ok": False,
                "code": "BROWSER_RUNTIME_MISSING",
                "message": "No usable browser runtime was found. Install Chrome/Chromium or a Playwright browser pack, then retry.",
                "detail": compact_text(exc, 500),
            },
            4,
        )

    return {
        "ok": True,
        "schemaVersion": 1,
        "mode": "read-only-scan",
        "baseUrl": config.base_url,
        "allowedDomains": config.allowed_domains,
        "maxPages": config.max_pages,
        "pages": pages,
        "warnings": warnings,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only scan of a web system for Lily learned skill drafting.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--allowed-domain", action="append", default=[])
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument("--timeout-ms", type=int, default=15000)
    parser.add_argument("--storage-state", help="Optional Playwright storage_state JSON file. Never generated by this script.")
    parser.add_argument("--headful", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Validate scan config without launching a browser.")
    parser.add_argument("--out", help="Write scan JSON to this path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = validate_config(args)
    if args.dry_run:
        payload = {
            "ok": True,
            "schemaVersion": 1,
            "mode": "dry-run",
            "baseUrl": config.base_url,
            "allowedDomains": config.allowed_domains,
            "maxPages": config.max_pages,
        }
    else:
        payload = run_scan(config)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    emit(payload)


if __name__ == "__main__":
    main()
