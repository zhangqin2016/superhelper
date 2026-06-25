#!/usr/bin/env python3
"""Web system scanner for Lily learned skills.

Default mode collects page structure only. Test-lab mode can describe submit
learning contracts, but credentials and field values are never captured.
"""

from __future__ import annotations

import argparse
import hashlib
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
SAFE_INTERACTION_TEXT_RE = re.compile(
    r"(details?|view|open|expand|more|next|previous|search|filter|tab|menu|详情|查看|打开|展开|更多|下一页|上一页|搜索|查询|筛选|菜单|标签)",
    re.IGNORECASE,
)

ID_SEGMENT_RE = re.compile(r"^(?:\d+|[0-9a-f]{8,}|[0-9a-f-]{20,})$", re.IGNORECASE)
LEARNING_MODES = {"read-only", "contract-probe", "test-lab"}
SENSITIVE_KEY_RE = re.compile(r"(authorization|cookie|token|secret|api[-_]?key|password|passwd|credential|session)", re.IGNORECASE)


@dataclass(frozen=True)
class ScanConfig:
    base_url: str
    allowed_domains: list[str]
    max_pages: int
    timeout_ms: int
    headful: bool
    storage_state: str | None
    interactive_readonly: bool
    learning_mode: str
    test_environment: str
    allow_mutating_learning: bool
    har_path: str | None


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

    learning_mode = str(args.learning_mode or "read-only").strip()
    if learning_mode not in LEARNING_MODES:
        emit({"ok": False, "code": "INVALID_LEARNING_MODE", "message": f"learning mode must be one of {sorted(LEARNING_MODES)}"}, 2)
    test_environment = compact_text(args.test_environment, 120)
    allow_mutating_learning = bool(args.allow_mutating_learning)
    if learning_mode == "test-lab" and (not test_environment or not allow_mutating_learning):
        emit(
            {
                "ok": False,
                "code": "TEST_LAB_CONFIRMATION_REQUIRED",
                "message": "test-lab learning requires --test-environment and --allow-mutating-learning.",
            },
            2,
        )
    if learning_mode != "test-lab" and allow_mutating_learning:
        emit(
            {
                "ok": False,
                "code": "MUTATING_LEARNING_REQUIRES_TEST_LAB",
                "message": "--allow-mutating-learning is only valid with --learning-mode test-lab.",
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
        interactive_readonly=bool(args.interactive_readonly),
        learning_mode=learning_mode,
        test_environment=test_environment,
        allow_mutating_learning=allow_mutating_learning,
        har_path=args.har_path,
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


def stable_hash(value: Any, length: int = 16) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:length]


def url_pattern(url: str) -> str:
    parsed = urlparse(url)
    segments = []
    for segment in parsed.path.split("/"):
        if not segment:
            continue
        segments.append(":id" if ID_SEGMENT_RE.match(segment) else segment)
    path = "/" + "/".join(segments) if segments else "/"
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def risk_hint(text: str) -> str:
    if MUTATING_TEXT_RE.search(text):
        return "mutating"
    return "read"


def build_api_contract(current_url: str, form: dict[str, Any], config: ScanConfig | None = None) -> dict[str, Any]:
    method = compact_text(form.get("method")).lower() or "get"
    action = compact_text(form.get("action"))
    fields = form.get("fields", [])[:120]
    submit_buttons = form.get("submitButtons", [])[:20]
    request_fields = [
        {
            "label": field.get("label", ""),
            "name": field.get("name", ""),
            "type": field.get("type", ""),
            "required": bool(field.get("required")),
            "options": field.get("options", [])[:40],
        }
        for field in fields
    ]
    has_static_endpoint = bool(action)
    learning_mode = config.learning_mode if config else "read-only"
    test_lab = learning_mode == "test-lab" and bool(config and config.allow_mutating_learning)
    return {
        "id": stable_hash([current_url, action, method, request_fields, submit_buttons], 12),
        "source": "static-form",
        "endpoint": action,
        "method": method.upper(),
        "contentType": "form",
        "requestFields": request_fields,
        "submitButtons": submit_buttons,
        "knownStaticEndpoint": has_static_endpoint,
        "needsSubmitProbe": not has_static_endpoint,
        "learningMode": learning_mode,
        "testEnvironment": config.test_environment if config else "",
        "probePolicy": {
            "requiresUserConsent": True,
            "useSyntheticValuesOnly": not test_lab,
            "abortUnsafeNetworkRequests": not test_lab,
            "redactPayloadValues": True,
            "neverCompleteBusinessSubmitDuringLearning": not test_lab,
            "allowRealSubmitInTestLab": test_lab,
        },
    }


def shape_value(value: Any, depth: int = 0) -> Any:
    if depth > 3:
        return "<nested>"
    if isinstance(value, dict):
        shaped: dict[str, Any] = {}
        for key in list(value.keys())[:80]:
            if SENSITIVE_KEY_RE.search(str(key)):
                shaped[str(key)] = "<redacted>"
            else:
                shaped[str(key)] = shape_value(value.get(key), depth + 1)
        return shaped
    if isinstance(value, list):
        if not value:
            return []
        return [shape_value(value[0], depth + 1)]
    if isinstance(value, bool):
        return "<boolean>"
    if isinstance(value, (int, float)):
        return "<number>"
    if value is None:
        return "<null>"
    return "<string>"


def parse_request_body_shape(post_data: str) -> dict[str, Any]:
    text = str(post_data or "")
    if not text:
        return {"type": "empty", "fields": []}
    try:
        parsed = json.loads(text)
        return {"type": "json", "shape": shape_value(parsed), "fields": request_fields_from_shape(parsed)}
    except Exception:
        pass
    try:
        from urllib.parse import parse_qs

        parsed_qs = parse_qs(text, keep_blank_values=True)
        fields = [
            {"name": key, "type": "string", "required": False, "sensitive": bool(SENSITIVE_KEY_RE.search(key))}
            for key in sorted(parsed_qs.keys())[:120]
        ]
        return {"type": "form", "fields": fields}
    except Exception:
        return {"type": "text", "length": len(text), "fields": []}


def request_fields_from_shape(value: Any, prefix: str = "") -> list[dict[str, Any]]:
    fields: list[dict[str, Any]] = []
    if isinstance(value, dict):
        for key, child in list(value.items())[:120]:
            name = f"{prefix}.{key}" if prefix else str(key)
            if SENSITIVE_KEY_RE.search(name):
                fields.append({"name": name, "type": "secret", "required": False, "sensitive": True})
                continue
            if isinstance(child, dict):
                fields.extend(request_fields_from_shape(child, name))
            elif isinstance(child, list) and child and isinstance(child[0], dict):
                fields.extend(request_fields_from_shape(child[0], f"{name}[]"))
            else:
                fields.append({"name": name, "type": inferred_json_type(child), "required": False, "sensitive": False})
    return fields[:120]


def inferred_json_type(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "array"
    if value is None:
        return "null"
    return "string"


def query_fields_from_url(url: str) -> list[dict[str, Any]]:
    parsed = urlparse(url)
    from urllib.parse import parse_qs

    query = parse_qs(parsed.query, keep_blank_values=True)
    return [
        {"name": key, "type": "string", "required": False, "sensitive": bool(SENSITIVE_KEY_RE.search(key))}
        for key in sorted(query.keys())[:120]
    ]


def response_shape_from_body(content_type: str, body: str) -> dict[str, Any]:
    text = str(body or "")
    if not text:
        return {"type": "empty"}
    if "json" in str(content_type).lower():
        try:
            return {"type": "json", "shape": shape_value(json.loads(text))}
        except Exception:
            return {"type": "json", "parseError": True, "length": len(text)}
    return {"type": "text", "length": len(text)}


class NetworkRecorder:
    def __init__(self, config: ScanConfig) -> None:
        self.config = config
        self.events: list[dict[str, Any]] = []

    def attach(self, page: Any) -> None:
        page.on("requestfinished", self._on_request_finished)

    def clear(self) -> None:
        self.events.clear()

    def snapshot(self) -> list[dict[str, Any]]:
        by_id: dict[str, dict[str, Any]] = {}
        for event in self.events:
            by_id[event["id"]] = event
        return list(by_id.values())[:80]

    def _on_request_finished(self, request: Any) -> None:
        try:
            if request.resource_type not in {"xhr", "fetch"}:
                return
            url = normalize_url(request.url)
            if not is_allowed_url(url, self.config.allowed_domains):
                return
            method = str(request.method or "GET").upper()
            response = request.response()
            status = int(response.status) if response else 0
            content_type = str((response.headers if response else {}).get("content-type", ""))
            body = ""
            if response and status < 400:
                try:
                    body = response.text()[:12000]
                except Exception:
                    body = ""
            body_shape = parse_request_body_shape(request.post_data or "")
            request_fields = query_fields_from_url(url)
            request_fields.extend(field for field in body_shape.get("fields", []) if isinstance(field, dict))
            parsed = urlparse(url)
            endpoint = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
            risk = "read" if method in {"GET", "HEAD"} else "submit"
            event = {
                "id": stable_hash([method, endpoint, sorted(field.get("name", "") for field in request_fields)], 12),
                "source": "network-observed",
                "endpoint": endpoint,
                "method": method,
                "contentType": "json" if body_shape.get("type") == "json" else body_shape.get("type", ""),
                "risk": risk,
                "resourceType": request.resource_type,
                "status": status,
                "requestFields": request_fields[:120],
                "requestBodyShape": {key: value for key, value in body_shape.items() if key != "fields"},
                "responseShape": response_shape_from_body(content_type, body),
                "queryFieldCount": len(query_fields_from_url(url)),
                "observedUrlPattern": url_pattern(url),
                "learningMode": self.config.learning_mode,
                "probePolicy": {
                    "capturedValues": False,
                    "credentialHeadersStored": False,
                    "sameDomainOnly": True,
                },
            }
            self.events.append(event)
        except Exception:
            return


def interaction_reason(candidate: dict[str, Any]) -> str:
    role = compact_text(candidate.get("role")).lower()
    tag = compact_text(candidate.get("tag")).lower()
    text = compact_text(candidate.get("text"))
    if role in {"tab", "menuitem", "treeitem"}:
        return role
    if tag == "summary":
        return "summary"
    if candidate.get("ariaExpanded") == "false":
        return "collapsed"
    if SAFE_INTERACTION_TEXT_RE.search(text):
        return "safe-text"
    return ""


def collect_action_candidates(page_record: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for button in page_record.get("buttons", []):
        text = compact_text(button.get("text"))
        if not text:
            continue
        candidates.append(
            {
                "kind": "button",
                "label": text,
                "riskHint": button.get("riskHint") or risk_hint(text),
                "sourceUrl": page_record.get("url", ""),
            }
        )
    for form in page_record.get("forms", []):
        label = compact_text(form.get("label")) or ", ".join(form.get("submitButtons") or []) or "form"
        candidates.append(
            {
                "kind": "form",
                "label": compact_text(label),
                "riskHint": form.get("riskHint") or "read",
                "method": form.get("method") or "get",
                "fieldCount": int(form.get("fieldCount") or len(form.get("fields", []))),
                "submitButtons": form.get("submitButtons", [])[:20],
                "sourceUrl": page_record.get("url", ""),
            }
        )
    for link in page_record.get("links", [])[:30]:
        text = compact_text(link.get("text"))
        if not text:
            continue
        candidates.append(
            {
                "kind": "link",
                "label": text,
                "riskHint": risk_hint(text),
                "targetUrl": link.get("url", ""),
                "sourceUrl": page_record.get("url", ""),
            }
        )
    return candidates[:80]


def infer_business_objects_from_page(page_record: dict[str, Any]) -> list[dict[str, Any]]:
    fields = []
    for item in page_record.get("inputs", []):
        label = compact_text(item.get("label") or item.get("name"))
        if not label:
            continue
        fields.append(
            {
                "name": label,
                "type": compact_text(item.get("type")),
                "required": bool(item.get("required")),
                "options": item.get("options", [])[:80],
                "source": "page-input",
                "confidence": "medium",
            }
        )
    for form in page_record.get("forms", []):
        for field in form.get("fields", []):
            label = compact_text(field.get("label") or field.get("name"))
            if not label:
                continue
            fields.append(
                {
                    "name": label,
                    "type": compact_text(field.get("type")),
                    "required": bool(field.get("required")),
                    "options": field.get("options", [])[:80],
                    "source": "form-field",
                    "formLabel": compact_text(form.get("label")),
                    "confidence": "high",
                }
            )
    table_fields = []
    for table in page_record.get("tables", []):
        for header in table.get("headers", []):
            text = compact_text(header)
            if text:
                table_fields.append({"name": text, "source": "table-header", "confidence": "medium"})
    object_name = (
        page_record.get("title")
        or next((heading.get("text") for heading in page_record.get("headings", []) if heading.get("text")), "")
        or page_record.get("urlPattern")
        or "Page"
    )
    object_fields = (fields + table_fields)[:80]
    if not object_fields:
        return []
    return [
        {
            "id": stable_hash([page_record.get("urlPattern"), object_name], 12),
            "name": compact_text(object_name, 80),
            "source": "scan",
            "sourceUrl": page_record.get("url", ""),
            "fields": object_fields,
        }
    ]


def extract_page(page: Any, current_url: str, allowed_domains: list[str], config: ScanConfig | None = None) -> dict[str, Any]:
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
          const fieldInfo = (el) => ({
            label: labelFor(el),
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || el.tagName.toLowerCase(),
            name: el.getAttribute('name') || '',
            placeholder: el.getAttribute('placeholder') || '',
            autocomplete: el.getAttribute('autocomplete') || '',
            required: Boolean(el.required || el.getAttribute('aria-required') === 'true'),
            disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
            readonly: Boolean(el.readOnly || el.getAttribute('readonly') !== null),
            options: el.tagName.toLowerCase() === 'select'
              ? Array.from(el.querySelectorAll('option')).slice(0, 80).map((option) => ({
                  label: textOf(option),
                  value: option.getAttribute('value') || ''
                })).filter((item) => item.label || item.value)
              : Array.from(document.querySelectorAll(`input[name="${CSS.escape(el.getAttribute('name') || '')}"][type="radio"],input[name="${CSS.escape(el.getAttribute('name') || '')}"][type="checkbox"]`)).slice(0, 80).map((option) => ({
                  label: labelFor(option),
                  value: option.getAttribute('value') || '',
                  type: option.getAttribute('type') || ''
                })).filter((item) => item.label || item.value)
          });
          let interactionIndex = 0;
          const isInsideForm = (el) => Boolean(el.closest('form'));
          const interactionInfo = (el) => {
            const scanId = `i${interactionIndex++}`;
            el.setAttribute('data-lily-scan-id', scanId);
            return {
              scanId,
              text: textOf(el) || el.getAttribute('value') || el.getAttribute('aria-label') || '',
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || '',
              type: el.getAttribute('type') || '',
              ariaExpanded: el.getAttribute('aria-expanded') || '',
              ariaControls: el.getAttribute('aria-controls') || '',
              href: el.getAttribute('href') || '',
              insideForm: isInsideForm(el)
            };
          };
          return {
            title: document.title || '',
            lang: document.documentElement.lang || '',
            path: location.pathname || '/',
            textSample: textOf(document.body).slice(0, 1200),
            headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 30).map((el) => ({
              level: el.tagName.toLowerCase(),
              text: textOf(el)
            })).filter((item) => item.text),
            landmarks: Array.from(document.querySelectorAll('main,nav,aside,header,footer,[role="main"],[role="navigation"],[role="menu"],[role="tablist"]')).slice(0, 30).map((el) => ({
              role: el.getAttribute('role') || el.tagName.toLowerCase(),
              text: textOf(el).slice(0, 240)
            })).filter((item) => item.text),
            navItems: Array.from(document.querySelectorAll('nav a, nav button, aside a, aside button, [role="navigation"] a, [role="navigation"] button, [role="menu"] [role="menuitem"], [role="tab"]')).slice(0, 120).map((el) => ({
              text: textOf(el),
              href: el.getAttribute('href') || ''
            })).filter((item) => item.text),
            links: Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map((el) => ({
              text: textOf(el),
              href: el.getAttribute('href')
            })),
            buttons: Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')).slice(0, 120).map((el) => ({
              text: textOf(el) || el.getAttribute('value') || el.getAttribute('aria-label') || '',
              type: el.getAttribute('type') || el.getAttribute('role') || el.tagName.toLowerCase()
            })).filter((item) => item.text),
            inputs: Array.from(document.querySelectorAll('input,select,textarea')).slice(0, 160).map(fieldInfo),
            forms: Array.from(document.querySelectorAll('form')).slice(0, 40).map((form) => ({
              label: textOf(form.querySelector('legend,h1,h2,h3')) || form.getAttribute('aria-label') || '',
              action: form.getAttribute('action') || '',
              method: form.getAttribute('method') || 'get',
              submitButtons: Array.from(form.querySelectorAll('button,input[type="submit"]')).slice(0, 20).map((el) => textOf(el) || el.getAttribute('value') || ''),
              fields: Array.from(form.querySelectorAll('input,select,textarea')).slice(0, 160).map(fieldInfo)
            })),
            tables: Array.from(document.querySelectorAll('table,[role="table"],[role="grid"]')).slice(0, 20).map((table) => ({
              caption: textOf(table.querySelector('caption,h1,h2,h3')) || table.getAttribute('aria-label') || '',
              headers: Array.from(table.querySelectorAll('th,[role="columnheader"]')).slice(0, 30).map((el) => textOf(el)).filter(Boolean),
              rowCount: table.querySelectorAll('tbody tr,[role="row"]').length
            })),
            iframes: Array.from(document.querySelectorAll('iframe')).slice(0, 20).map((el) => ({
              title: el.getAttribute('title') || el.getAttribute('name') || '',
              src: el.getAttribute('src') || ''
            })),
            interactionCandidates: Array.from(document.querySelectorAll('summary,[role="tab"],[role="menuitem"],[role="treeitem"],button,[role="button"],a[href]')).slice(0, 180).map(interactionInfo)
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
        submit_buttons = [compact_text(text) for text in form.get("submitButtons", []) if compact_text(text)]
        fields = []
        for field in form.get("fields", []):
            label = compact_text(field.get("label") or field.get("name"))
            if not label:
                continue
            fields.append(
                {
                    "label": label,
                    "tag": compact_text(field.get("tag")),
                    "type": compact_text(field.get("type")),
                    "name": compact_text(field.get("name")),
                    "placeholder": compact_text(field.get("placeholder")),
                    "autocomplete": compact_text(field.get("autocomplete")),
                    "required": bool(field.get("required")),
                    "disabled": bool(field.get("disabled")),
                    "readonly": bool(field.get("readonly")),
                    "options": [
                        {
                            "label": compact_text(option.get("label")),
                            "value": compact_text(option.get("value")),
                            "type": compact_text(option.get("type")),
                        }
                        for option in field.get("options", [])
                        if compact_text(option.get("label")) or compact_text(option.get("value"))
                    ][:80],
                }
            )
        form_risk = "mutating" if compact_text(form.get("method")).lower() == "post" or any(risk_hint(text) == "mutating" for text in submit_buttons) else "read"
        forms.append(
            {
                "label": compact_text(form.get("label")),
                "action": action if is_allowed_url(action, allowed_domains) else "",
                "method": compact_text(form.get("method")).lower() or "get",
                "submitButtons": submit_buttons,
                "fields": fields[:120],
                "fieldCount": len(fields),
                "riskHint": form_risk,
            }
        )

    page_record = {
        "id": stable_hash([current_url, snapshot.get("title"), snapshot.get("headings")], 12),
        "url": current_url,
        "urlPattern": url_pattern(current_url),
        "title": compact_text(snapshot.get("title")),
        "language": compact_text(snapshot.get("lang"), 32),
        "textSample": compact_text(snapshot.get("textSample"), 1200),
        "headings": [
            {"level": compact_text(item.get("level")), "text": compact_text(item.get("text"))}
            for item in snapshot.get("headings", [])
            if compact_text(item.get("text"))
        ],
        "landmarks": [
            {"role": compact_text(item.get("role")), "text": compact_text(item.get("text"), 240)}
            for item in snapshot.get("landmarks", [])
            if compact_text(item.get("text"))
        ],
        "navItems": [
            {
                "text": compact_text(item.get("text")),
                "url": normalize_url(urljoin(current_url, str(item.get("href") or ""))) if item.get("href") else "",
            }
            for item in snapshot.get("navItems", [])
            if compact_text(item.get("text"))
        ][:80],
        "links": links[:80],
        "buttons": buttons[:80],
        "inputs": [
            {
                "label": compact_text(item.get("label")),
                "tag": compact_text(item.get("tag")),
                "type": compact_text(item.get("type")),
                "name": compact_text(item.get("name")),
                "placeholder": compact_text(item.get("placeholder")),
                "autocomplete": compact_text(item.get("autocomplete")),
                "required": bool(item.get("required")),
                "disabled": bool(item.get("disabled")),
                "readonly": bool(item.get("readonly")),
                "options": [
                    {
                        "label": compact_text(option.get("label")),
                        "value": compact_text(option.get("value")),
                        "type": compact_text(option.get("type")),
                    }
                    for option in item.get("options", [])
                    if compact_text(option.get("label")) or compact_text(option.get("value"))
                ][:80],
            }
            for item in snapshot.get("inputs", [])
            if compact_text(item.get("label")) or compact_text(item.get("name"))
        ][:120],
        "forms": forms[:40],
        "formContracts": [
            {
                "id": stable_hash([current_url, form.get("label"), form.get("action"), form.get("fields")], 12),
                "label": form.get("label") or "form",
                "action": form.get("action") or "",
                "method": form.get("method") or "get",
                "riskHint": form.get("riskHint") or "read",
                "fieldCount": form.get("fieldCount") or len(form.get("fields", [])),
                "submitButtons": form.get("submitButtons", [])[:20],
                "fields": form.get("fields", [])[:120],
                "executionPolicy": {
                    "learnOnly": True,
                    "fillDraftAllowed": True,
                    "canSubmitDuringLearning": bool(config and config.learning_mode == "test-lab" and config.allow_mutating_learning),
                    "submitRequiresConfirmation": True,
                },
                "apiContract": build_api_contract(current_url, form, config),
            }
            for form in forms[:40]
        ],
        "tables": [
            {
                "caption": compact_text(item.get("caption")),
                "headers": [compact_text(header) for header in item.get("headers", []) if compact_text(header)][:30],
                "rowCount": int(item.get("rowCount") or 0),
            }
            for item in snapshot.get("tables", [])
        ],
        "iframes": [
            {
                "title": compact_text(item.get("title")),
                "src": normalize_url(urljoin(current_url, str(item.get("src") or ""))) if item.get("src") else "",
            }
            for item in snapshot.get("iframes", [])
        ],
        "interactionCandidates": [
            {
                "scanId": compact_text(item.get("scanId"), 32),
                "text": compact_text(item.get("text")),
                "tag": compact_text(item.get("tag")),
                "role": compact_text(item.get("role")),
                "type": compact_text(item.get("type")),
                "ariaExpanded": compact_text(item.get("ariaExpanded"), 16),
                "ariaControls": compact_text(item.get("ariaControls"), 80),
                "url": normalize_url(urljoin(current_url, str(item.get("href") or ""))) if item.get("href") else "",
                "insideForm": bool(item.get("insideForm")),
                "riskHint": risk_hint(item.get("text", "")),
                "reason": interaction_reason(item),
            }
            for item in snapshot.get("interactionCandidates", [])
            if compact_text(item.get("scanId")) and interaction_reason(item) and not bool(item.get("insideForm")) and risk_hint(item.get("text", "")) == "read"
        ][:80],
        "_nextUrls": next_urls,
    }
    page_record["metrics"] = {
        "links": len(page_record["links"]),
        "buttons": len(page_record["buttons"]),
        "inputs": len(page_record["inputs"]),
        "forms": len(page_record["forms"]),
        "formContracts": len(page_record["formContracts"]),
        "tables": len(page_record["tables"]),
        "iframes": len(page_record["iframes"]),
        "interactionCandidates": len(page_record["interactionCandidates"]),
        "apiContracts": len([form for form in page_record["formContracts"] if form.get("apiContract")]),
    }
    # Native Playwright accessibility-tree snapshot — the page as assistive tech
    # (and the model) actually reads it: roles + accessible names in document
    # order. First-party Playwright API, far more robust for page understanding
    # than hand-rolled DOM scraping. Additive + fail-safe: any failure leaves the
    # field empty and never affects the rest of the scan.
    page_record["accessibilityTree"] = ""
    try:
        aria = page.locator("body").aria_snapshot()
        if isinstance(aria, str) and aria.strip():
            page_record["accessibilityTree"] = aria[:8000]
    except Exception:
        pass
    page_record["actionCandidates"] = collect_action_candidates(page_record)
    page_record["businessObjects"] = infer_business_objects_from_page(page_record)
    page_record["fingerprint"] = stable_hash(
        {
            "urlPattern": page_record["urlPattern"],
            "title": page_record["title"],
            "headings": page_record["headings"][:8],
            "buttons": [button["text"] for button in page_record["buttons"][:30]],
            "inputs": [item.get("label") or item.get("name") for item in page_record["inputs"][:40]],
            "tables": page_record["tables"][:10],
        }
    )
    return page_record


def build_scan_summary(config: ScanConfig, pages: list[dict[str, Any]], warnings: list[dict[str, str]]) -> dict[str, Any]:
    readable_pages = [page for page in pages if not page.get("error")]
    interactive_pages = [page for page in readable_pages if page.get("source") == "interactive-readonly"]
    action_candidates = []
    business_objects = []
    api_contracts = []
    edges = []
    for page in readable_pages:
        action_candidates.extend(page.get("actionCandidates", []))
        business_objects.extend(page.get("businessObjects", []))
        api_contracts.extend([form.get("apiContract") for form in page.get("formContracts", []) if form.get("apiContract")])
        api_contracts.extend(page.get("networkContracts", []))
        for link in page.get("links", []):
            edges.append({"from": page.get("url"), "to": link.get("url"), "label": link.get("text", "")})

    return {
        "pageCount": len(readable_pages),
        "errorCount": len(pages) - len(readable_pages),
        "warningCount": len(warnings),
        "maxPages": config.max_pages,
        "coverageRatio": round(len(readable_pages) / config.max_pages, 4),
        "actionCandidateCount": len(action_candidates),
        "businessObjectCount": len(business_objects),
        "apiContractCount": len(api_contracts),
        "interactivePageCount": len(interactive_pages),
        "learningMode": config.learning_mode,
        "testEnvironment": config.test_environment,
        "allowMutatingLearning": config.allow_mutating_learning,
        "fingerprint": stable_hash([page.get("fingerprint") for page in readable_pages]),
        "limitations": [
            "Read-only mode follows same-domain links and does not submit forms.",
            "Test-lab mode may learn real submit flows only when explicitly enabled for a non-production environment.",
            "Expandable menus, authenticated-only routes, iframes, shadow DOM, and SPA routes may need interactive learning passes.",
            "Action candidates are hypotheses and require user/model review before execution.",
        ],
        "siteMap": {
            "nodes": [
                {
                    "id": page.get("id"),
                    "url": page.get("url"),
                    "title": page.get("title"),
                    "urlPattern": page.get("urlPattern"),
                    "fingerprint": page.get("fingerprint"),
                }
                for page in readable_pages
            ],
            "edges": edges[:500],
        },
        "actionCandidates": action_candidates[:500],
        "businessObjects": business_objects[:300],
        "apiContracts": api_contracts[:300],
    }


def explore_readonly_interactions(
    page: Any,
    source_page: dict[str, Any],
    config: ScanConfig,
    timeout_ms: int,
    max_new_pages: int,
    network_recorder: NetworkRecorder | None = None,
) -> list[dict[str, Any]]:
    discovered: list[dict[str, Any]] = []
    source_url = source_page.get("url") or ""
    source_fingerprint = source_page.get("fingerprint") or ""
    candidates = source_page.get("interactionCandidates", [])[:12]
    for candidate in candidates:
        if len(discovered) >= max_new_pages:
            break
        if candidate.get("riskHint") != "read" or candidate.get("insideForm"):
            continue
        if not source_url:
            continue
        try:
            if network_recorder:
                network_recorder.clear()
            page.goto(source_url, wait_until="domcontentloaded", timeout=timeout_ms)
            refreshed_page = extract_page(page, normalize_url(page.url), config.allowed_domains, config)
            refreshed_page.pop("_nextUrls", None)
            refreshed_candidate = next(
                (
                    item
                    for item in refreshed_page.get("interactionCandidates", [])
                    if item.get("text") == candidate.get("text") and item.get("reason") == candidate.get("reason")
                ),
                None,
            )
            scan_id = (refreshed_candidate or candidate).get("scanId")
            if not scan_id:
                continue
            if network_recorder:
                network_recorder.clear()
            page.locator(f'[data-lily-scan-id="{scan_id}"]').first.click(timeout=min(timeout_ms, 5000), no_wait_after=True)
            page.wait_for_timeout(500)
            current_url = normalize_url(page.url)
            if not is_allowed_url(current_url, config.allowed_domains):
                continue
            discovered_page = extract_page(page, current_url, config.allowed_domains, config)
            if network_recorder:
                discovered_page["networkContracts"] = network_recorder.snapshot()
                discovered_page["metrics"]["networkContracts"] = len(discovered_page["networkContracts"])
            discovered_page.pop("_nextUrls", None)
            if discovered_page.get("fingerprint") == source_fingerprint and discovered_page.get("url") == source_url:
                continue
            discovered_page["id"] = stable_hash([source_page.get("id"), scan_id, discovered_page.get("fingerprint")], 12)
            discovered_page["source"] = "interactive-readonly"
            discovered_page["sourceInteraction"] = {
                "fromPageId": source_page.get("id", ""),
                "fromUrl": source_url,
                "scanId": scan_id,
                "label": candidate.get("text", ""),
                "reason": candidate.get("reason", ""),
            }
            discovered.append(discovered_page)
        except Exception:
            continue
    return discovered


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
            if config.har_path:
                # Record full traffic (with bodies) so har_to_contracts.cjs can
                # learn APIs from real requests/responses, including write paths.
                context_kwargs["record_har_path"] = config.har_path
                context_kwargs["record_har_content"] = "embed"
            context = browser.new_context(**context_kwargs)
            page = context.new_page()
            network_recorder = NetworkRecorder(config)
            network_recorder.attach(page)

            while queue and len(pages) < config.max_pages:
                url = queue.popleft()
                if url in seen or not is_allowed_url(url, config.allowed_domains):
                    continue
                seen.add(url)
                page_record: dict[str, Any]
                interactive_pages: list[dict[str, Any]] = []
                try:
                    network_recorder.clear()
                    page.goto(url, wait_until="domcontentloaded", timeout=config.timeout_ms)
                    page.wait_for_timeout(300)
                    page_record = extract_page(page, normalize_url(page.url), config.allowed_domains, config)
                    page_record["networkContracts"] = network_recorder.snapshot()
                    page_record["metrics"]["networkContracts"] = len(page_record["networkContracts"])
                    for next_url in page_record.pop("_nextUrls", []):
                        if next_url not in seen and len(seen) + len(queue) < config.max_pages * 4:
                            queue.append(next_url)
                    if config.interactive_readonly and len(pages) < config.max_pages:
                        remaining = config.max_pages - len(pages) - 1
                        if remaining > 0:
                            interactive_pages = explore_readonly_interactions(page, page_record, config, config.timeout_ms, remaining, network_recorder)
                except PlaywrightTimeoutError:
                    page_record = {"url": url, "error": "TIMEOUT"}
                    warnings.append({"url": url, "code": "TIMEOUT"})
                except PlaywrightError as exc:
                    page_record = {"url": url, "error": "PAGE_ERROR", "detail": compact_text(exc, 240)}
                    warnings.append({"url": url, "code": "PAGE_ERROR", "detail": compact_text(exc, 240)})
                pages.append(page_record)
                for interactive_page in interactive_pages:
                    if len(pages) >= config.max_pages:
                        break
                    pages.append(interactive_page)

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

    summary = build_scan_summary(config, pages, warnings)
    return {
        "ok": True,
        "schemaVersion": 1,
        "mode": "read-only-scan",
        "learningMode": config.learning_mode,
        "testEnvironment": config.test_environment,
        "allowMutatingLearning": config.allow_mutating_learning,
        "interactiveReadonly": config.interactive_readonly,
        "baseUrl": config.base_url,
        "allowedDomains": config.allowed_domains,
        "maxPages": config.max_pages,
        "harPath": config.har_path,
        "pages": pages,
        "coverage": {key: value for key, value in summary.items() if key not in {"siteMap", "actionCandidates", "businessObjects", "apiContracts"}},
        "siteMap": summary["siteMap"],
        "actionCandidates": summary["actionCandidates"],
        "businessObjects": summary["businessObjects"],
        "apiContracts": summary["apiContracts"],
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
    parser.add_argument("--interactive-readonly", action="store_true", help="Safely click read-only menu/tab/detail controls to improve coverage. Never submits forms.")
    parser.add_argument("--learning-mode", choices=sorted(LEARNING_MODES), default="read-only", help="read-only, contract-probe, or test-lab.")
    parser.add_argument("--test-environment", default="", help="Required with --learning-mode test-lab. Example: staging, qa, demo.")
    parser.add_argument("--allow-mutating-learning", action="store_true", help="Only valid in test-lab mode. Allows generated contracts to model real submit/delete flows.")
    parser.add_argument("--dry-run", action="store_true", help="Validate scan config without launching a browser.")
    parser.add_argument("--out", help="Write scan JSON to this path.")
    parser.add_argument("--har-path", help="Record all network traffic to this HAR file (feed to har_to_contracts.cjs to learn APIs from real traffic, including write paths).")
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
            "interactiveReadonly": config.interactive_readonly,
            "learningMode": config.learning_mode,
            "testEnvironment": config.test_environment,
            "allowMutatingLearning": config.allow_mutating_learning,
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
