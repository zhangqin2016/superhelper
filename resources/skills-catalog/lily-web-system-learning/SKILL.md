---
name: lily-web-system-learning
description: Use when the user wants Lily to learn a web/OA/ERP/CRM/admin system and turn it into a reusable workspace skill for natural-language operations. Covers read-only automatic exploration, page/action mapping, domain allowlists, credential safety, high-risk confirmation, and creating a workspace skill the user can enable.
---

# Lily Web System Learning

Use this skill when the user wants Lily to learn or automate a browser-based system such as OA, ERP, CRM, finance, HR, support portals, admin dashboards, vendor portals, or internal tools.

## Product Contract

The goal is not free-form clicking. The goal is a reviewable operating model:

1. Learn the system within an approved scope.
2. Build a page, action, and API map.
3. Generate a connector playbook with action contracts.
4. Prefer API-first execution when safe contracts exist; fall back to browser automation for UI-only or stale API paths.
5. Generate a workspace skill draft that references the playbook.
6. Let the user enable it before future use.

Never store passwords in a skill, prompt, log, or generated file. The user should log in through an interactive browser/profile, SSO, or existing session. Treat credentials, cookies, tokens, screenshots, exports, and personal data as sensitive.

## Learning Modes

- Read-only scan: default. Open pages, menus, lists, filters, and detail views. Do not submit forms or mutate data.
- Dry-run rehearsal: fill fields only when safe, then stop before submit.
- Authorized execution: perform writes only after the user explicitly approves the action and risk policy.
- Test-environment learning: when the user confirms the environment is safe, submit/create/update/delete flows may be explored to learn real APIs and validation behavior.

## Learning Flow

1. Confirm base URL, business scope, allowed domains, forbidden areas, and whether the environment is production or test.
2. Require a domain allowlist. Never follow links outside it.
3. Capture the login ONCE. If no saved session exists for this system, run
   `node scripts/capture_session.cjs --base-url <url> --system-id <id>
   --allow-domain <host>` — it opens one real browser window for the user to log
   in, then saves the session to a local, per-system file (printed as
   `sessionPath`, stored 0600 under userData, never exported). Pass that
   `sessionPath` as `--storage-state` to every later scan/discover/execute call.
   Re-run capture only when a call reports `stale`/`relearnRecommended` (401/403).
   Never ask the user to paste cookies, tokens, OAuth codes, CSRF values, or
   credential headers; if a token is dynamic, learn it from authenticated browser
   traffic or re-capture/re-learn the flow.
   The capture script is the only login-capture path: do not write ad-hoc Python
   or JavaScript login scripts, do not call `input()`/stdin prompts, and do not
   install Playwright at runtime. If the bundled browser runtime is missing,
   report that exact blocker instead of improvising.
4. **Contract discovery first (authoritative > inferred).** Before scanning the
   UI, run `scripts/discover_contracts.cjs --base-url <url> --allow-domain <host>`
   (pass `--storage-state` to reuse the logged-in session) to probe for the
   system's own published OpenAPI/Swagger or GraphQL schema. A published contract
   is a complete, authoritative source of APIs and data structures — prefer it
   over DOM/HAR inference. Pass its `api-contracts.json` to
   `create_web_system_skill.cjs --contracts`. Fall back to the UI scan only for
   what the published contract does not cover.
5. **Learn APIs from real traffic (for systems without a published contract, and
   for write paths).** Run the scan with `--har-path scan.har` to record traffic,
   then `node scripts/har_to_contracts.cjs --har scan.har --base-url <url>
   --allow-domain <host> --merge api-contracts.json --out api-contracts.json` to
   infer request/response schemas from observed requests and merge them in
   (authoritative published contracts are never overridden). Write-path APIs
   (POST/PUT/DELETE) are only captured when those flows actually run — exercise
   them only in a confirmed test environment.
6. **Learn auth injection from the logged-in session.** After HAR capture, run
   `node scripts/learn_auth_recipe.cjs --storage-state <sessionPath> --har scan.har
   --base-url <url> --allow-domain <host>`. The output stores only sources and
   formats (for example, `Authorization` from `localStorage.access_token` as
   `Bearer {{value}}`), never raw token values.
7. Run a read-only dry run before deeper exploration.
8. Run every scanner/executor command in the foreground and wait for it to finish before claiming the scan is running, complete, failed, or waiting for analysis.
9. Explore navigation, menus, tabs, forms, filters, lists, details, exports, pagination, dialogs, and error states.
10. Capture stable selectors, accessibility labels, field names, validation messages, request methods, endpoint shapes, and response hints.
11. Classify actions by risk: read, export, draft, submit, update, delete, financial, identity/security, and bulk operations.
12. Build an action map and playbook. Each action needs inputs, preconditions, execution path, confirmation policy, success signal, rollback/recovery, and audit fields.
13. Finish with the deterministic finalizer:
   `node scripts/finalize_web_system_learning.cjs --scan <scan.json>
   --contracts <api-contracts.json> --system-id <id> --name <name>`.
   This derives `web-system-spec.json` from scan/contracts and calls
   `create_web_system_skill.cjs`. Do not hand-write the final spec in chat, and
   do not end the learning turn before the finalizer returns `ok: true` or a
   concrete error.
14. Tell the user exactly where the generated workspace skill draft was written
   and that they can enable it.
15. On later use, execute through the learned playbook; if selectors/API change, mark stale and request re-learning.

## Runtime Lifecycle Rules

The chat UI can only show "running" while a real foreground tool is active. Keep the assistant state honest:

- Do not say "scan is running", "waiting for scan completion", or "I will analyze when it finishes" unless the scanner command is still executing as a foreground Bash/tool call in the same turn.
- Never start `scan_web_system.py`, `execute_web_playbook.cjs`, Playwright, browser learning, or skill generation with `&`, `nohup`, `setsid`, `disown`, a detached terminal, or a separate background shell.
- If a scan may take minutes, tell the user what will be scanned, then run the foreground command and wait for its JSON/output before summarizing.
- If the environment cannot keep a foreground tool alive, stop and explain the exact blocker instead of pretending a background scan is active.
- A follow-up such as "deeper scan" or "continue scanning" must either run another foreground scanner command or ask for the missing scope. It must not be treated as a separate idle chat while the previous scan is supposedly pending.
- After a scanner command finishes, read the output file before generating `system-profile.json`, `page-map.json`, `api-map.json`, `capability-map.json`, `action-playbook.json`, `health.json`, and the workspace skill `SKILL.md`.
- A partial scan is still a valid reviewable draft. If coverage is low, run the
  deterministic finalizer anyway and mark gaps in `health.json`; do not stop at
  "I will continue scanning" unless another foreground scanner command is
  actually running.

## Output Artifacts

Place generated artifacts in the workspace learning area, using stable English directory names and localized display labels:

- system-profile.json: app name, domains, roles, navigation, risks.
- page-map.json: pages, routes, labels, selectors, forms, tables, actions.
- api-contracts.json: authoritative published contracts (OpenAPI/GraphQL) from discover_contracts.cjs, with real request/response JSON Schema (types, enums, required) and reusable data schemas. Persisted verbatim for review and re-learn diffing.
- api-map.json: merged endpoint catalog (authoritative contracts take precedence over observed/inferred), methods, request/response schemas, data schemas, auth hints, mutation flags.
- capability-map.json: natural-language capability routing, required parameters, confirmation gates, success signals, stale signals, and recovery policy.
- action-playbook.json: natural-language intents mapped to safe actions.
- health.json: learning coverage, API/browser fallback coverage, stale state, and recommended next steps.
- SKILL.md: workspace skill instructions for enablement, written under the generated system id directory such as `<learned-skills-inbox>/<system-id>/`.
- audit-log.jsonl: learning actions, timestamps, scope, and redacted evidence.

## Safety Rules

- Production systems default to read-only learning.
- Mutating actions require explicit user approval and clear risk labels.
- High-risk actions always need confirmation at execution time: delete, submit, payment, payroll, permission, account, bulk update, external send, and irreversible actions.
- Do not store raw secrets or cookies in generated artifacts.
- If the system changes, detect stale selectors/API and trigger re-learning rather than guessing.

## Execution Rules

- Log in ONCE, then reuse the session. Capture the logged-in session to a
  storageState file (e.g. `web-session.json`) and pass `--storage-state` to every
  scan/discover/execute call. Do not reopen a browser to log in for each action;
  only re-capture when the session actually expires (a run reports
  `stale`/`relearnRecommended` from a 401/403).
- If a page or API requires a token/cookie/header, do not ask the user how to
  obtain it. Use the captured session, or re-run authenticated learning so the
  platform observes the required dynamic token flow.
- Captured sessions can contain cookies, localStorage, and sessionStorage. Treat
  all three as local secrets; reuse them through `--storage-state` and
  `--auth-recipe`, never by copying values into plans, prompts, generated code,
  logs, or skill files.
- Pass the local auth recipe as `--auth-recipe <authRecipePath>` for API
  execution when HAR observed Authorization/CSRF headers. The recipe resolves
  values from storageState at runtime and must not contain raw token values.
- Prefer learned API actions: an all-API plan runs over plain HTTP with the
  reused session cookies and launches NO browser (fast, no flicker, no repeated
  windows). Asking a question that maps to a learned API = one HTTP call.
- Normal user execution must use the learned flow graph in `capability-map.json`
  and `web-system-playbook.json`. Do not generate ad-hoc Playwright,
  JavaScript, Python, selectors, or operation plans while answering a normal user
  request.
- Use browser automation during learning, discovery, login, and captured
  headless fallback flows only. If no captured API or headless flow exists for a
  capability, mark it as needing re-learning instead of improvising.
- When an action has both an API path and a captured browser path, store the
  browser path during learning as `fallbackOperations`; the executor runs the
  fallback automatically if the API path fails or goes stale
  (401/403/404/status-mismatch/locator-not-found).
- For write actions, capture `rollbackOperations` during learning when a safe
  compensating path exists; the executor runs them best-effort if a write fails
  after mutating state.
- Always pass `--audit-log <file>` so every step is appended to a durable JSONL
  trail (inputs redacted). A failed run reports `stale`/`staleSignal`/
  `relearnRecommended` — when `relearnRecommended` is true, re-run learning
  rather than blindly retrying.
- For ambiguous natural-language requests, ask one focused question instead of guessing a destructive action.
- Always show what will happen before a mutating action and record the result in audit logs.
- Locator resilience is built in: the executor tries selector → testId → role →
  label → placeholder → text candidates before failing, so a single brittle
  selector does not break a step. On a hard failure it reports
  `relearnRecommended` rather than guessing.
- For a frequently-repeated, verified flow, compile it during learning to a
  deterministic script with `node scripts/compile_playbook.cjs --playbook
  web-system-playbook.json --action web.x --plan plan.json --out flows/x.cjs`.
  The compiled script replays without the model (faster, cheaper, reproducible)
  and keeps the domain allowlist + no-credential rules inlined. Re-compile after
  a re-learn.

## Browser Engine (@playwright/mcp, optional)

Two complementary browser paths — pick by task:

- **Deterministic path (default for verified/repeatable flows):** the validated
  executor (`execute_web_playbook.cjs`) and compiled scripts. Use this for
  learned, confirmed actions — it is safe, fast, and reproducible.
- **Accessibility-tree path (optional, for exploration / learning capture):** if
  this session has Microsoft's `@playwright/mcp` server registered, prefer its
  accessibility-snapshot tools to navigate and act on pages the way a person
  reads them — better for first-time exploration and capturing missing flows. It
  is free/open-source (Apache-2.0) and runs locally.

When `@playwright/mcp` is available, use it for discovery/coverage passes and
exploration steps, then capture the result as a learned action so future runs
use the deterministic path. Never put credentials in MCP tool calls; rely on the
shared browser session. If `@playwright/mcp` is not registered, everything still
works through the deterministic executor — it is an enhancement, not a
requirement.

## Natural-Language Routing

You are the router. Do not rely on keyword tables — read `capability-map.json`
and match the user's request to a capability by meaning:

1. Load `capability-map.json`. Each capability has `intents`, a description,
   `params` (with `required`/`askWhenMissing`), `execution`, and `successSignal`.
2. Pick the single best-matching capability by intent. If two are plausible, ask
   one focused disambiguating question rather than guessing — especially when one
   candidate is a write/destructive action.
3. Fill `params` from the request; for any missing `required` param, ask using
   its `askWhenMissing` prompt before executing.
4. Execute through the typed learned-system tool when available; otherwise
   materialize the plan from `execution.learnedFlow.operationTemplate` and user
   parameters. Never author a fresh browser/script plan at runtime.
5. If no capability matches, say so and offer to re-learn that area — never
   invent an endpoint or selector.

(For very large systems where the full capability set will not fit in context,
add a retrieval pre-filter to shortlist candidates before this step. Not needed
for typical systems — the model routes directly.)

## Coverage Completeness

Learning is not done after one pass. Explore like a QA engineer mapping the
whole system, then critique coverage:

- Systematically walk every menu, tab, list, filter, detail, dialog, and
  pagination within scope — not just the landing pages.
- After each pass, ask "what have I NOT seen yet?" (modules behind permissions,
  routes only reached via buttons/JS, write flows, error/validation states) and
  run another foreground pass to cover them. Stop only when consecutive passes
  surface nothing new.
- Authoritative contracts (`api-contracts.json`) define the API/data-structure
  ceiling; use the UI scan to map which capability each contract serves and to
  cover UI-only flows the contract omits.
- Record coverage and known gaps in `health.json` honestly. A skill with gaps is
  a reviewable draft, not a finished operator — say what is not yet covered.

## Re-learning & Drift

When re-learning a system, diff the new contracts against the persisted ones:

```
node scripts/diff_contracts.cjs --old api-contracts.json --new api-contracts.new.json
```

Treat `removed`/`changed` endpoints (and anything under `breaking`) as stale:
re-verify or disable the capabilities bound to them before reuse. Record the
drift summary in `change-log.json`.
